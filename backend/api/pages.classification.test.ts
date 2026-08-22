import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { registerSchemas } from './schemas/page.ts'
import { registerSchemas as registerApprovalSchemas } from './schemas/approval.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { registerSchemas as registerPageImportSchema } from './schemas/pageImport.ts'
import pagesRoutes from './pages.ts'

/**
 * OpenProject #1080: the PATCH route's declassification guardrail (lowering a page's classification
 * needs `manage:classification` ON THIS PAGE, on top of `write:pages`/`manage:pages`) and the
 * classification-resolution-dialog flow (raising a page's own classification surfaces descendants
 * that now sit below the new floor, resolved via a dedicated endpoint rather than cascaded silently).
 *
 * Route-level only, mirroring `api/pages.test.ts`'s `enforceApiKeySite` describe block's shape: a real
 * Fastify instance with `WIKI.models.pages`/`WIKI.models.groups`/`WIKI.models.classificationLevels`
 * stubbed to the smallest surface each test needs, rather than a database. The floor-invariant math
 * itself (`meetsFloor`/`isLowerThan`) is covered directly in `models/classificationLevels.test.ts`;
 * this file is about who may reach it and what the route does with the model's answer.
 */
describe('pages API — classification (OpenProject #1080)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'
  const PUBLIC_ID = '30000000-0000-4000-8000-000000000001'
  const INTERNAL_ID = '30000000-0000-4000-8000-000000000002'
  const RESTRICTED_ID = '30000000-0000-4000-8000-000000000003'

  // -> Order determines openness: PUBLIC < INTERNAL < RESTRICTED, mirroring the seeded defaults.
  const SORT_ORDER: Record<string, number> = {
    [PUBLIC_ID]: 0,
    [INTERNAL_ID]: 1,
    [RESTRICTED_ID]: 2
  }

  let updatePageCalls: any[] = []
  let checkAccessCalls: any[] = []
  /** Which permissions `checkAccess` grants, by permission name — every test overrides what it needs. */
  let grantedPermissions: Set<string>
  let bulkSetClassificationCalls: any[] = []
  let auditLogCalls: any[] = []

  let app: FastifyInstance
  let previousTemporal: any
  let previousToTemporalInstant: any

  /**
   * Same fake as `api/pages.test.ts`'s own `installFakeTemporal` -- this sandbox's Node lacks native
   * `Temporal` (see that file's doc comment), and the PATCH handler calls
   * `page.updatedAt.toTemporalInstant()` for the collab-save notification regardless of whether this
   * test's own assertions care about the timestamp.
   */
  function installFakeTemporal(): void {
    ;(globalThis as any).Temporal = {
      Instant: { from: (iso: string) => ({ epochMilliseconds: Date.parse(iso) }) }
    }
    ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
      const epochMilliseconds = this.getTime()
      return { epochMilliseconds, toString: () => new Date(epochMilliseconds).toISOString() }
    }
  }

  before(async () => {
    previousTemporal = (globalThis as any).Temporal
    previousToTemporalInstant = (Date.prototype as any).toTemporalInstant
    if (typeof previousTemporal === 'undefined') {
      installFakeTemporal()
    }
    ;(globalThis as any).WIKI = {
      models: {
        pages: {
          getPage: async ({ id }: { id: string }) =>
            id === PAGE_ID
              ? {
                  id: PAGE_ID,
                  path: 'engineering/onboarding',
                  locale: 'en',
                  classification: INTERNAL_ID,
                  tags: [],
                  updatedAt: new Date()
                }
              : null,
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
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          groupIdsForRequest: () => [],
          checkAccess: (_actor: unknown, permission: string) => {
            checkAccessCalls.push(permission)
            return grantedPermissions.has(permission)
          }
        },
        classificationLevels: {
          byId: (id: string) =>
            SORT_ORDER[id] !== undefined ? { id, sortOrder: SORT_ORDER[id] } : null,
          isLowerThan: (a: string, b: string) => SORT_ORDER[a] < SORT_ORDER[b]
        },
        auditLog: {
          record: async (args: any) => {
            auditLogCalls.push(args)
          }
        }
      },
      sites: { [SITE_ID]: {} },
      collab: { pageSaved: () => {} }
    }

    app = Fastify()
    await app.register(fastifySensible)
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    app.addHook('onRequest', async (req) => {
      const rawSession = req.headers['x-test-session']
      if (typeof rawSession === 'string') {
        ;(req as any).session = JSON.parse(rawSession)
      }
    })
    await registerApprovalSchemas(app)
    await registerSchemas(app)
    await registerErrorSchema(app)
    await registerPageImportSchema(app)
    await app.register(pagesRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
    ;(globalThis as any).Temporal = previousTemporal
    ;(Date.prototype as any).toTemporalInstant = previousToTemporalInstant
  })

  beforeEach(() => {
    updatePageCalls = []
    checkAccessCalls = []
    bulkSetClassificationCalls = []
    auditLogCalls = []
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
      //    that page's OWN classification as fetched during the permission-check loop (INTERNAL_ID
      //    here, from the shared `getPage` stub).
      assert.equal(auditLogCalls.length, 1)
      assert.equal(auditLogCalls[0].event, 'page.classificationChanged')
      assert.deepEqual(auditLogCalls[0].detail, { from: INTERNAL_ID, to: RESTRICTED_ID })
    })
  })
})
