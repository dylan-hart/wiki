import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import { createSiteAdminAccessStub } from '../test/mocks.ts'
import approvalsRoutes from './approvals.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { registerParamsSchemas } from './schemas/params.ts'

describe('/sites/:siteId/approvals/rules — site:approvals permission (task 683)', () => {
  /**
   * Task #683: `/sites/:siteId/approvals/rules` (GET/POST/PUT/DELETE) — the routes behind
   * `AdminApprovals.vue` — used to gate on the blanket route-level `manage:sites`. They
   * now also accept the site-scoped `site:approvals` permission from task #682 (`checkSiteAccess()`),
   * checked in-handler via `checkSiteAdminAccess` since `config.permissions` cannot express a
   * per-site check.
   *
   * The submission/review routes (`/sites/:siteId/approvals/submissions/...`,
   * `/sites/:siteId/pages/:pageId/suggestions/self`) are deliberately untouched by task #683 — they
   * are page-scoped review permissions (`review:pages`, decided per-page by `helpers/pageRules.ts`),
   * not a site-admin surface, per `docs/decisions/delegated-per-site-administration.md` §3's mapping
   * of `site:approvals` to the rules routes specifically. Covered separately below.
   */

  const SITE_ID = '5d9c8f1e-2b3a-4c5d-9e6f-7a8b9c0d1e2f'
  const RULE_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678'
  const SUBMITTER_GROUP = 'b2c3d4e5-f6a7-489a-bcde-f01234567890'
  const REVIEWER_GROUP = 'c3d4e5f6-a7b8-49ab-cdef-012345678901'

  const sites: Record<string, any> = { [SITE_ID]: { id: SITE_ID } }

  const existingRule = {
    id: RULE_ID,
    name: 'Existing rule',
    match: 'START',
    path: '',
    submitterGroups: [SUBMITTER_GROUP],
    reviewerGroups: [REVIEWER_GROUP],
    minApprovals: 1
  }

  let createRuleCalls: any[] = []
  let updateRuleCalls: any[] = []
  let deleteRuleCalls: any[] = []

  async function getRules() {
    return [existingRule]
  }
  async function getRule() {
    return existingRule
  }
  // -> Mutable per-test, task #1616: default empty (every group id resolves), one test below
  //    overrides it to prove `rejectUnknownGroups` now sends a coded `ERR_UNKNOWN_GROUPS` message.
  let unknownGroupIdsToReturn: string[] = []
  async function hasUnknownGroupIds() {
    return unknownGroupIdsToReturn.length > 0
  }
  async function createRule(siteId: string, body: any) {
    createRuleCalls.push({ siteId, body })
    return { ...existingRule, ...body }
  }
  async function updateRule(siteId: string, ruleId: string, body: any) {
    updateRuleCalls.push({ siteId, ruleId, body })
    return { ...existingRule, ...body }
  }
  async function deleteRule(siteId: string, ruleId: string) {
    deleteRuleCalls.push({ siteId, ruleId })
    return true
  }

  let currentSitePermissionHeader: string | undefined
  function checkSiteAccess(actor: { permissions: string[] }, permission: string, siteId: string) {
    if (actor.permissions.includes('manage:system')) {
      return true
    }
    return typeof currentSitePermissionHeader === 'string'
      ? currentSitePermissionHeader.split(',').filter(Boolean).includes(`${permission}@${siteId}`)
      : false
  }

  function actorForRequest(req: any) {
    const header = req.headers['x-test-permissions']
    const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
    return { groupIds: [], permissions }
  }

  const checkSiteAdminAccess = createSiteAdminAccessStub(actorForRequest, checkSiteAccess)

  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      sites,
      models: {
        groups: { actorForRequest, checkSiteAccess, checkSiteAdminAccess, hasUnknownGroupIds },
        approvals: {
          getRules,
          getRule,
          createRule,
          updateRule,
          deleteRule,
          isReviewerSession: () => false,
          getActorGroupIds: () => []
        }
      },
      logger: { warn: () => {} }
    }

    app = fastify()
    await app.register(fastifySensible)
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`forbidden()`/etc. is a
    //    thrown `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that
    //    shapes it into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerErrorSchema(app)
    await registerApprovalSchema(app)
    app.addHook('preHandler', (req: any, reply, done) => {
      currentSitePermissionHeader = req.headers['x-test-site-permissions']
      done()
    })
    // -> The unknown-site 404 lives in this one hook now (spec D1), not in each route handler, so a
    //    plugin-only app has to register it to answer that case the way the real app does.
    app.addHook('preHandler', siteEnabledPreHandler)
    await registerParamsSchemas(app)
    await app.register(approvalsRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    createRuleCalls = []
    updateRuleCalls = []
    deleteRuleCalls = []
    unknownGroupIdsToReturn = []
  })

  test('manage:sites may list approval rules', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/approvals/rules`,
      headers: { 'x-test-permissions': 'manage:sites' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().length, 1)
  })

  test('site:approvals on this site may list approval rules', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/approvals/rules`,
      headers: { 'x-test-site-permissions': `site:approvals@${SITE_ID}` }
    })
    assert.equal(res.statusCode, 200)
  })

  test('site:approvals on a DIFFERENT site may not list rules here', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/approvals/rules`,
      headers: { 'x-test-site-permissions': 'site:approvals@some-other-site' }
    })
    assert.equal(res.statusCode, 403)
  })

  test('a caller with none of manage:sites/site:approvals is refused on GET', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/approvals/rules`,
      headers: { 'x-test-permissions': 'manage:navigation' }
    })
    assert.equal(res.statusCode, 403)
  })

  test('site:approvals on this site may create a rule', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/approvals/rules`,
      headers: { 'x-test-site-permissions': `site:approvals@${SITE_ID}` },
      payload: {
        name: 'New rule',
        match: 'START',
        path: '',
        submitterGroups: [SUBMITTER_GROUP],
        reviewerGroups: [REVIEWER_GROUP]
      }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(createRuleCalls.length, 1)
  })

  // -> #1616: this used to be a hardcoded `No such group: <ids>` English sentence, which surfaced
  //    verbatim in the UI instead of translating like the rest of a `t(key, fallback)` screen.
  //    Assert the coded `ERR_*` shape, not any particular wording.
  test('creating a rule with an unknown group id is rejected with a coded error', async () => {
    unknownGroupIdsToReturn = [SUBMITTER_GROUP]
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/approvals/rules`,
      headers: { 'x-test-site-permissions': `site:approvals@${SITE_ID}` },
      payload: {
        name: 'New rule',
        match: 'START',
        path: '',
        submitterGroups: [SUBMITTER_GROUP],
        reviewerGroups: [REVIEWER_GROUP]
      }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().message, 'ERR_UNKNOWN_GROUPS')
    assert.equal(createRuleCalls.length, 0)
  })

  test('an unrelated permission alone may not create a rule', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/approvals/rules`,
      headers: { 'x-test-permissions': 'manage:navigation' },
      payload: {
        name: 'New rule',
        match: 'START',
        path: '',
        submitterGroups: [SUBMITTER_GROUP],
        reviewerGroups: [REVIEWER_GROUP]
      }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(createRuleCalls.length, 0)
  })

  test('site:approvals on this site may update a rule', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/approvals/rules/${RULE_ID}`,
      headers: { 'x-test-site-permissions': `site:approvals@${SITE_ID}` },
      payload: { name: 'Renamed rule' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updateRuleCalls.length, 1)
  })

  test('site:approvals on a DIFFERENT site may not update a rule here', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/approvals/rules/${RULE_ID}`,
      headers: { 'x-test-site-permissions': 'site:approvals@some-other-site' },
      payload: { name: 'Renamed rule' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(updateRuleCalls.length, 0)
  })

  test('site:approvals on this site may delete a rule', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE_ID}/approvals/rules/${RULE_ID}`,
      headers: { 'x-test-site-permissions': `site:approvals@${SITE_ID}` }
    })
    assert.equal(res.statusCode, 204)
    assert.equal(deleteRuleCalls.length, 1)
  })

  test('site:approvals on a DIFFERENT site may not delete a rule here', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE_ID}/approvals/rules/${RULE_ID}`,
      headers: { 'x-test-site-permissions': 'site:approvals@some-other-site' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(deleteRuleCalls.length, 0)
  })
})

describe('approve/reject submission routes — response schema covers reachable statuses (task 2355)', () => {
  /**
   * The approve/reject submission routes deliberately declare no route-level `config.permissions`
   * (the actor check is in-handler instead, via `actorFrom`/`reviewerFor` — see the "No route-level
   * permissions" convention in CLAUDE.md) so `responseErrors.test.ts`'s blanket 401/403 check, which
   * only scans routes with a non-empty `config.permissions`, can never catch a missing 401 on either
   * of them. OpenProject #2355: the reject route's response schema once omitted 401 even though its
   * handler can (defensively) return `reply.unauthorized()`, the same shape the approve route above
   * it already had. This is a narrow regression guard for exactly that gap, using the same
   * recording-stub technique as `responseErrors.test.ts` rather than booting a real Fastify instance.
   */

  function createRecordingApp() {
    const routes: { method: string; path: string; options: any }[] = []
    const app: any = {
      addContentTypeParser: () => {},
      addHook: () => {},
      register: () => app
    }
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      app[method] = (routePath: string, options?: any) => {
        routes.push({ method, path: routePath, options })
        return app
      }
    }
    return { app, routes }
  }

  /** Whether a response entry is (or resolves through `allOf`/`oneOf` to) `{ $ref: 'ApiError#' }`. */
  function referencesApiError(entry: any): boolean {
    if (!entry) return false
    if (entry.$ref === 'ApiError#') return true
    return [...(entry.allOf ?? []), ...(entry.oneOf ?? [])].some(referencesApiError)
  }

  test('approve and reject routes both declare 401 and 404 as ApiError', async () => {
    const { app, routes } = createRecordingApp()
    await approvalsRoutes(app as unknown as FastifyInstance)

    const target = routes.filter((r) => r.path.endsWith('/approve') || r.path.endsWith('/reject'))
    assert.equal(
      target.length,
      2,
      `expected exactly 2 approve/reject routes, found ${target.length}`
    )

    for (const route of target) {
      const response = route.options?.schema?.response ?? {}
      const label = `${route.method.toUpperCase()} ${route.path}`
      assert.ok(
        referencesApiError(response['401']),
        `${label} is missing a 401 ApiError response entry`
      )
      assert.ok(
        referencesApiError(response['404']),
        `${label} is missing a 404 ApiError response entry`
      )
    }
  })
})
