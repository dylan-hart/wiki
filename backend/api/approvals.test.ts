import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import approvalsRoutes from './approvals.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

describe('/sites/:siteId/approvals/rules — site:approvals permission (task 683)', () => {
  /**
   * Task #683: `/sites/:siteId/approvals/rules` (GET/POST/PUT/DELETE) — the routes behind
   * `AdminApprovals.vue` — used to gate on the blanket route-level `manage:sites`. They
   * now also accept the site-scoped `site:approvals` permission from task #682 (`checkSiteAccess()`),
   * checked in-handler via `mayReadApprovalRules`/`mayManageApprovalRules` since `config.permissions`
   * cannot express a per-site check.
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
  async function getSiteById({ id }: { id: string }) {
    return sites[id] ?? null
  }

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
  async function getUnknownGroupIds() {
    return unknownGroupIdsToReturn
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

  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        sites: { getSiteById },
        groups: { actorForRequest, checkSiteAccess },
        approvals: {
          getRules,
          getRule,
          getUnknownGroupIds,
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

describe('page-scoped approval routes — siteId threading (task 673)', () => {
  /**
   * Regression test for task 673: both `mayOnPage` (via `loadSuggestablePage`) and the direct
   * `checkAccess` call in `reviewerFor` pass the route's `siteId` through, so a page rule scoped to
   * one site (task 671) is enforced when deciding who may suggest an edit and who reviews it, not
   * just when reading the page.
   */

  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '33333333-3333-4333-8333-333333333333'

  let app: FastifyInstance
  let checkAccessCalls: { permission: string; page: any }[]

  before(async () => {
    checkAccessCalls = []
    ;(globalThis as any).WIKI = {
      models: {
        pages: {
          getPage: async () => ({
            id: PAGE_ID,
            path: 'some/page',
            tags: [],
            allowContributions: true
          })
        },
        approvals: {
          isReviewerSession: () => true,
          getActorGroupIds: () => [],
          canReviewPage: async () => true,
          getReviewableSubmissions: async () => []
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: (_actor: any, permission: string, page: any) => {
            checkAccessCalls.push({ permission, page })
            return true
          }
        }
      }
    }

    app = fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    await registerErrorSchema(app)
    await registerApprovalSchema(app)
    await app.register(approvalsRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('PENDING SUBMISSIONS FOR A PAGE: passes the route siteId to both checkAccess calls', async () => {
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/submissions`
    })
    assert.equal(res.statusCode, 200)
    // -> One from `mayOnPage` (`read:pages`, via `loadSuggestablePage`), one from `reviewerFor`
    //    (`review:pages`, the direct `checkAccess` call)
    assert.equal(checkAccessCalls.length, 2)
    assert.equal(checkAccessCalls.find((c) => c.permission === 'read:pages')?.page.siteId, SITE_ID)
    assert.equal(
      checkAccessCalls.find((c) => c.permission === 'review:pages')?.page.siteId,
      SITE_ID
    )
  })
})
