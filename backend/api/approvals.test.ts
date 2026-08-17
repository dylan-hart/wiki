import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import approvalsRoutes from './approvals.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'

/**
 * Regression test for task 673: both `mayOnPage` (via `loadSuggestablePage`) and the direct
 * `checkAccess` call in `reviewerFor` pass the route's `siteId` through, so a page rule scoped to one
 * site (task 671) is enforced when deciding who may suggest an edit and who reviews it, not just when
 * reading the page.
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
  assert.equal(checkAccessCalls.find((c) => c.permission === 'review:pages')?.page.siteId, SITE_ID)
})
