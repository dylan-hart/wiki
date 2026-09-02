import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * OpenProject #1080: the PATCH route's declassification guardrail (lowering a page's classification
 * needs `manage:classification` ON THIS PAGE, on top of `write:pages`/`manage:pages`) and the
 * classification-resolution-dialog flow (raising a page's own classification surfaces descendants
 * that now sit below the new floor, resolved via a dedicated endpoint rather than cascaded silently).
 *
 * Route-level only: a real Fastify instance with `WIKI.models.pages`/`WIKI.models.groups`/
 * `WIKI.models.classificationLevels` stubbed to the smallest surface each test needs, rather than a
 * database. The floor-invariant math
 * itself (`meetsFloor`/`isLowerThan`) is covered directly in `models/classificationLevels.test.ts`;
 * this file is about who may reach it and what the route does with the model's answer.
 */
describe('pages API — classification (OpenProject #1080)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'
  const SECOND_PAGE_ID = '22222222-2222-4222-8222-222222222223'
  const THIRD_PAGE_ID = '22222222-2222-4222-8222-222222222224'
  const PUBLIC_ID = '30000000-0000-4000-8000-000000000001'
  const INTERNAL_ID = '30000000-0000-4000-8000-000000000002'
  const RESTRICTED_ID = '30000000-0000-4000-8000-000000000003'

  // -> Order determines openness: PUBLIC < INTERNAL < RESTRICTED, mirroring the seeded defaults.
  const SORT_ORDER: Record<string, number> = {
    [PUBLIC_ID]: 0,
    [INTERNAL_ID]: 1,
    [RESTRICTED_ID]: 2
  }

  /**
   * Every page `getPagesByIds`/`getPage` can resolve -- OpenProject #1902's batched select stands in
   * for what used to be a per-id `getPage()` loop, so the fixture now needs more than one page on hand
   * to exercise a real batch.
   */
  const PAGE_FIXTURES: Record<
    string,
    { id: string; path: string; locale: string; classification: string; tags: string[] }
  > = {
    [PAGE_ID]: {
      id: PAGE_ID,
      path: 'engineering/onboarding',
      locale: 'en',
      classification: INTERNAL_ID,
      tags: []
    },
    [SECOND_PAGE_ID]: {
      id: SECOND_PAGE_ID,
      path: 'engineering/runbook',
      locale: 'en',
      classification: INTERNAL_ID,
      tags: []
    },
    [THIRD_PAGE_ID]: {
      id: THIRD_PAGE_ID,
      path: 'engineering/glossary',
      locale: 'en',
      classification: INTERNAL_ID,
      tags: []
    }
  }

  let updatePageCalls: any[] = []
  let checkAccessCalls: any[] = []
  /** Which permissions `checkAccess` grants, by permission name — every test overrides what it needs. */
  let grantedPermissions: Set<string>
  /** A path `checkAccess` refuses every permission for, regardless of `grantedPermissions` -- what a
   *  mixed-batch test uses to make one target in a batch fail while the others pass. */
  let deniedForPath: string | null = null
  let bulkSetClassificationCalls: any[] = []
  let auditLogCalls: any[] = []
  let getPagesByIdsCalls: any[] = []
  let parentClassificationsCalls: any[] = []
  /** `WIKI.models.pageClassification.parentClassification`'s stubbed return -- null (no parent) by default. */
  let parentClassificationFloor: string | null = null

  let app: FastifyInstance

  before(async () => {
    // -> The PATCH handler calls `page.updatedAt.toTemporalInstant()` for the collab-save
    //    notification regardless of whether this test's own assertions care about the timestamp.
    await ensureTemporal()
    const wiki = {
      models: {
        pages: {
          getPage: async ({ id }: { id: string }) =>
            PAGE_FIXTURES[id] ? { ...PAGE_FIXTURES[id], updatedAt: new Date() } : null,
          // -> OpenProject #1902: the batched select `api/pages.ts`'s resolve route now calls instead
          //    of a per-id `getPage` loop. One call per request regardless of how many ids are asked
          //    for -- `getPagesByIdsCalls.length` is what the "query count does not grow with N" tests
          //    below assert against.
          getPagesByIds: async (siteId: string, ids: string[]) => {
            getPagesByIdsCalls.push({ siteId, ids })
            const map = new Map<string, any>()
            for (const id of ids) {
              if (PAGE_FIXTURES[id]) {
                map.set(id, PAGE_FIXTURES[id])
              }
            }
            return map
          },
          updatePage: async (siteId: string, id: string, patch: any) => {
            updatePageCalls.push({ siteId, id, patch })
            return {
              id,
              path: 'engineering/onboarding',
              locale: 'en',
              classification: patch.classification ?? INTERNAL_ID,
              updatedAt: new Date(),
              authorName: ''
            }
          }
        },
        // -> The classification cluster moved to `models/pageClassification.ts` when
        //    `models/pages.ts` was split; the resolve route reaches it there now.
        pageClassification: {
          // -> OpenProject #1902: the batched parent-classification lookup, one call per request
          //    regardless of how many targets it covers. `parentClassificationFloor` stands in for
          //    every target's floor uniformly, the same way the single-target stub did.
          parentClassifications: async (
            siteId: string,
            entries: { locale: string; path: string }[]
          ) => {
            parentClassificationsCalls.push({ siteId, entries })
            const map = new Map<string, string | null>()
            for (const { locale, path } of entries) {
              map.set(`${locale}\0${path}`, parentClassificationFloor)
            }
            return map
          },
          descendantsBelowFloor: async () => [
            {
              id: 'child-1',
              path: 'engineering/onboarding/secret',
              title: 'Secret',
              classification: PUBLIC_ID
            }
          ],
          bulkSetClassification: async (siteId: string, ids: string[], classification: string) => {
            bulkSetClassificationCalls.push({ siteId, ids, classification })
            return ids.length
          },
          // -> No parent by default (root-level page in these fixtures) -- overridden per-test where
          //    the floor-invariant enforcement in the resolve route is what's under test.
          parentClassification: async () => parentClassificationFloor
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          groupIdsForRequest: () => [],
          checkAccess: (_actor: unknown, permission: string, page: { path?: string } = {}) => {
            checkAccessCalls.push(permission)
            if (deniedForPath && page.path === deniedForPath) {
              return false
            }
            return grantedPermissions.has(permission)
          }
        },
        classificationLevels: {
          byId: (id: string) =>
            SORT_ORDER[id] !== undefined ? { id, sortOrder: SORT_ORDER[id] } : null,
          isLowerThan: (a: string, b: string) => SORT_ORDER[a] < SORT_ORDER[b],
          meetsFloor: (candidateId: string, floorId: string) =>
            SORT_ORDER[candidateId] !== undefined &&
            SORT_ORDER[floorId] !== undefined &&
            SORT_ORDER[candidateId] >= SORT_ORDER[floorId]
        },
        auditLog: {
          record: async (args: any) => {
            auditLogCalls.push(args)
          },
          // -> OpenProject #1902: the resolve route's batched writes now go through `recordMany` --
          //    flattened into `auditLogCalls` too, so the same per-entry assertions the PATCH-route
          //    tests already make against a single `record()` call work unchanged here.
          recordMany: async (entries: any[]) => {
            auditLogCalls.push(...entries)
          }
        }
      },
      sites: { [SITE_ID]: {} },
      collab: { pageSaved: () => {} }
    }

    app = await buildTestApp({ routes: pagesRoutes, wiki, session: 'header' })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    updatePageCalls = []
    checkAccessCalls = []
    bulkSetClassificationCalls = []
    auditLogCalls = []
    getPagesByIdsCalls = []
    parentClassificationsCalls = []
    parentClassificationFloor = null
    deniedForPath = null
    grantedPermissions = new Set(['write:pages'])
  })

  const sessionHeader = {
    'x-test-session': JSON.stringify({
      authenticated: true,
      user: { id: 'user-1' },
      permissions: []
    })
  }

  test('raising the classification needs only write:pages, not manage:classification', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { classification: RESTRICTED_ID }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
    assert.ok(!checkAccessCalls.includes('manage:classification'))
    // -> OpenProject #1081: every actual classification change is recorded to the audit log.
    assert.equal(auditLogCalls.length, 1)
    assert.equal(auditLogCalls[0].event, 'page.classificationChanged')
    assert.equal(auditLogCalls[0].targetType, 'page')
    assert.equal(auditLogCalls[0].targetId, PAGE_ID)
    assert.deepEqual(auditLogCalls[0].detail, { from: INTERNAL_ID, to: RESTRICTED_ID })
  })

  test('lowering the classification without manage:classification is refused with 403, before updatePage runs', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { classification: PUBLIC_ID }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(updatePageCalls.length, 0)
  })

  test('lowering the classification succeeds once the actor also holds manage:classification', async () => {
    grantedPermissions = new Set(['write:pages', 'manage:classification'])
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { classification: PUBLIC_ID }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
  })

  test('an unchanged classification is not treated as a lowering and needs no extra permission', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { classification: INTERNAL_ID, title: 'Onboarding' }
    })
    assert.equal(res.statusCode, 200)
    // -> from === to: recordClassificationChange() is a documented no-op here.
    assert.equal(auditLogCalls.length, 0)
  })

  test('a save that does not touch classification at all is unaffected', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { title: 'Onboarding' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updatePageCalls.length, 1)
    assert.equal(auditLogCalls.length, 0)
  })

  test('raising the classification surfaces classificationConflicts from descendantsBelowFloor', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { classification: RESTRICTED_ID }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.classificationConflicts.length, 1)
    assert.equal(body.classificationConflicts[0].id, 'child-1')
  })

  test('lowering the classification never computes classificationConflicts', async () => {
    grantedPermissions = new Set(['write:pages', 'manage:classification'])
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      headers: sessionHeader,
      payload: { classification: PUBLIC_ID }
    })
    const body = res.json()
    assert.equal(body.classificationConflicts, undefined)
  })

  describe('POST /sites/:siteId/pages/classification-conflicts/resolve', () => {
    test('refuses an unknown classification level with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        payload: { pageIds: [PAGE_ID], classification: 'no-such-level' }
      })
      assert.equal(res.statusCode, 400)
      assert.equal(bulkSetClassificationCalls.length, 0)
    })

    test('refuses when the actor lacks write:pages on one of the target pages', async () => {
      grantedPermissions = new Set()
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        payload: { pageIds: [PAGE_ID], classification: RESTRICTED_ID }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(bulkSetClassificationCalls.length, 0)
    })

    test('bumps every named page once authorized', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        payload: { pageIds: [PAGE_ID], classification: RESTRICTED_ID }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(bulkSetClassificationCalls.length, 1)
      assert.deepEqual(bulkSetClassificationCalls[0].ids, [PAGE_ID])
      assert.equal(bulkSetClassificationCalls[0].classification, RESTRICTED_ID)
      // -> OpenProject #1081: a bulk resolve records one audit entry per page bumped, `from` being
      //    that page's OWN classification as fetched by the batched `getPagesByIds` read (INTERNAL_ID
      //    here, from the shared `PAGE_FIXTURES` fixture).
      assert.equal(auditLogCalls.length, 1)
      assert.equal(auditLogCalls[0].event, 'page.classificationChanged')
      assert.deepEqual(auditLogCalls[0].detail, { from: INTERNAL_ID, to: RESTRICTED_ID })
    })

    /*
      OpenProject #1902: resolving N pages must produce the same per-page outcomes and the same N
      audit rows the old per-id `getPage`/`parentClassification`/`record` loop would have, while
      issuing a number of queries that does not grow with N -- `getPagesByIdsCalls.length` and
      `parentClassificationsCalls.length` staying at 1 regardless of how many ids were submitted is
      this test's stand-in for "one query", since this suite mocks the model layer rather than a
      real database.
    */
    test('resolving a batch of N pages issues one batched read/lookup and N audit rows, not N of each', async () => {
      const ids = [PAGE_ID, SECOND_PAGE_ID, THIRD_PAGE_ID]
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        payload: { pageIds: ids, classification: RESTRICTED_ID }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(bulkSetClassificationCalls.length, 1)
      assert.deepEqual(bulkSetClassificationCalls[0].ids, ids)
      // -> One call each, no matter how many pages were in the batch.
      assert.equal(getPagesByIdsCalls.length, 1)
      assert.deepEqual(getPagesByIdsCalls[0].ids, ids)
      assert.equal(parentClassificationsCalls.length, 1)
      // -> N audit rows for N pages, all from one `recordMany` flattened into `auditLogCalls`.
      assert.equal(auditLogCalls.length, ids.length)
      assert.deepEqual(auditLogCalls.map((c: any) => c.targetId).sort(), [...ids].sort())
      for (const call of auditLogCalls) {
        assert.deepEqual(call.detail, { from: INTERNAL_ID, to: RESTRICTED_ID })
      }
    })

    test('refuses with 404 when one of the submitted ids does not exist, before any writes', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        payload: {
          pageIds: [PAGE_ID, '99999999-9999-4999-8999-999999999999'],
          classification: RESTRICTED_ID
        }
      })
      assert.equal(res.statusCode, 404)
      assert.equal(bulkSetClassificationCalls.length, 0)
      assert.equal(auditLogCalls.length, 0)
    })

    /*
      A mixed batch -- one page the actor may write, one it may not -- must land on the SAME outcome
      the old serial, early-returning loop would: the actor lacking write:pages on ANY target refuses
      the whole request with 403 and writes nothing, rather than silently applying to the pages that
      did pass. OpenProject #1902's batching changes how the targets are READ, not this per-page
      permission semantics.
    */
    test('a mixed batch (one page permitted, one refused) is refused as a whole, matching the serial version', async () => {
      deniedForPath = PAGE_FIXTURES[SECOND_PAGE_ID]!.path
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        payload: { pageIds: [PAGE_ID, SECOND_PAGE_ID], classification: RESTRICTED_ID }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(bulkSetClassificationCalls.length, 0)
      assert.equal(auditLogCalls.length, 0)
    })

    /*
      This endpoint is not restricted to the resolve dialog's own callers, which only ever ask for a
      raise -- a bare `write:pages` caller passing an actually-lower target must be refused the same
      way the PATCH route refuses one, not silently allowed just because it arrived here instead.
    */
    test('refuses to lower a target classification without manage:classification', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        // -> The fixture page starts at INTERNAL_ID; PUBLIC_ID is a lowering.
        payload: { pageIds: [PAGE_ID], classification: PUBLIC_ID }
      })
      assert.equal(res.statusCode, 403)
      assert.equal(bulkSetClassificationCalls.length, 0)
    })

    test('allows a lowering once the actor also holds manage:classification', async () => {
      grantedPermissions = new Set(['write:pages', 'manage:classification'])
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        payload: { pageIds: [PAGE_ID], classification: PUBLIC_ID }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(bulkSetClassificationCalls.length, 1)
    })

    test('refuses a target classification below the page’s own immediate parent floor', async () => {
      parentClassificationFloor = RESTRICTED_ID
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        // -> INTERNAL_ID is a raise relative to the fixture page's own current level, but still
        //    below a RESTRICTED_ID parent floor.
        payload: { pageIds: [PAGE_ID], classification: INTERNAL_ID }
      })
      assert.equal(res.statusCode, 400)
      assert.equal(bulkSetClassificationCalls.length, 0)
    })

    test('a target classification at the parent floor is accepted', async () => {
      parentClassificationFloor = RESTRICTED_ID
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        payload: { pageIds: [PAGE_ID], classification: RESTRICTED_ID }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(bulkSetClassificationCalls.length, 1)
    })

    // -> OpenProject #1870: an over-limit pageIds array is rejected by schema validation before the
    //    handler ever runs, not processed up to the 5 MB body-size limit.
    test('an over-limit pageIds array is rejected with 400 by schema validation', async () => {
      const oversized = Array.from(
        { length: 501 },
        (_, i) => `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      )
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        payload: { pageIds: oversized, classification: RESTRICTED_ID }
      })
      assert.equal(res.statusCode, 400)
      assert.equal(bulkSetClassificationCalls.length, 0)
    })

    // -> OpenProject #1870: a repeated id produces exactly one outcome and one audit row for that
    //    page, instead of one per occurrence in the request body.
    test('a body repeating one id produces exactly one outcome and one audit row', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/pages/classification-conflicts/resolve`,
        headers: sessionHeader,
        payload: { pageIds: [PAGE_ID, PAGE_ID, PAGE_ID], classification: RESTRICTED_ID }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(bulkSetClassificationCalls.length, 1)
      assert.deepEqual(bulkSetClassificationCalls[0].ids, [PAGE_ID])
      assert.equal(auditLogCalls.length, 1)
      assert.equal(auditLogCalls[0].targetId, PAGE_ID)
    })
  })
})
