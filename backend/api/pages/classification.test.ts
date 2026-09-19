import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

describe('pages API — classification (OpenProject #1080)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'
  const SECOND_PAGE_ID = '22222222-2222-4222-8222-222222222223'
  const THIRD_PAGE_ID = '22222222-2222-4222-8222-222222222224'
  const PUBLIC_ID = '30000000-0000-4000-8000-000000000001'
  const INTERNAL_ID = '30000000-0000-4000-8000-000000000002'
  const RESTRICTED_ID = '30000000-0000-4000-8000-000000000003'

  const SORT_ORDER: Record<string, number> = {
    [PUBLIC_ID]: 0,
    [INTERNAL_ID]: 1,
    [RESTRICTED_ID]: 2
  }

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
  let grantedPermissions: Set<string>
  let deniedForPath: string | null = null
  let bulkSetClassificationCalls: any[] = []
  let auditLogCalls: any[] = []
  let getPagesByIdsCalls: any[] = []
  let parentClassificationsCalls: any[] = []
  let parentClassificationFloor: string | null = null

  let app: FastifyInstance

  before(async () => {
    // -> The PATCH handler calls `page.updatedAt.toTemporalInstant()`.
    await ensureTemporal()
    const wiki = {
      models: {
        pages: {
          getPage: async ({ id }: { id: string }) =>
            PAGE_FIXTURES[id] ? { ...PAGE_FIXTURES[id], updatedAt: new Date() } : null,
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
        pageClassification: {
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
    // -> from === to: nothing to audit.
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
      assert.equal(auditLogCalls.length, 1)
      assert.equal(auditLogCalls[0].event, 'page.classificationChanged')
      assert.deepEqual(auditLogCalls[0].detail, { from: INTERNAL_ID, to: RESTRICTED_ID })
    })

    /*
      The model layer is mocked, so one call to each batched method stands in for "a query count
      that does not grow with N".
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
      assert.equal(getPagesByIdsCalls.length, 1)
      assert.deepEqual(getPagesByIdsCalls[0].ids, ids)
      assert.equal(parentClassificationsCalls.length, 1)
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
        // -> INTERNAL_ID is the fixture page's own level, so not a lowering, but it is below the
        //    RESTRICTED_ID parent floor.
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
