import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import watchingRoutes from './watching.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'

/**
 * Regression test for task 673: `loadWatchablePage`'s call to `mayOnPage` (pages.ts) passes the
 * route's `siteId` through, so a page rule scoped to one site (task 671) is enforced when deciding
 * whether the caller may watch a page, not just when reading it.
 */

const SITE_ID = '11111111-1111-4111-8111-111111111111'
const PAGE_ID = '33333333-3333-4333-8333-333333333333'
const USER_ID = '44444444-4444-4444-8444-444444444444'

let app: FastifyInstance
let checkAccessCalls: any[]

before(async () => {
  checkAccessCalls = []
  ;(globalThis as any).WIKI = {
    models: {
      pages: {
        getPage: async () => ({ id: PAGE_ID, path: 'some/page', locale: 'en', tags: [] })
      },
      pageWatching: {
        watch: async () => {}
      },
      groups: {
        actorForRequest: () => ({ permissions: [] }),
        checkAccess: (_actor: any, _permission: string, page: any) => {
          checkAccessCalls.push(page)
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
  app.addHook('onRequest', async (req) => {
    // -> Minimal stand-in for the real session plugin: enough for `actorFrom` to see a logged-in user.
    ;(req as any).session = { authenticated: true, user: { id: USER_ID }, permissions: [] }
  })
  await registerPageSchema(app)
  await app.register(watchingRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('WATCH: passes the route siteId through to checkAccess', async () => {
  checkAccessCalls = []
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/pages/${PAGE_ID}/watch`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(checkAccessCalls.length, 1)
  assert.equal(checkAccessCalls[0].siteId, SITE_ID)
  assert.equal(checkAccessCalls[0].path, 'some/page')
})
