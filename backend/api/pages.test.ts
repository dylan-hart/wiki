import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'

/**
 * Regression test for task 699: the siteId-scoped page READ routes trust a `siteId` the client
 * already has cached, so a client that fetched one before its site was disabled could otherwise keep
 * reading indefinitely — none of these are reached through the page/shell hook in `index.ts` (task
 * 695), which only ever sees a hostname-addressed navigation, not an already-cached siteId.
 *
 * Covers the three routes task 699 names: LIST, SEARCH and INCLUDE. Asserts the same 403-vs-404-ish
 * contract as the other entry points in this task — here there is no "site not found" branch to
 * contrast with (`guardSiteEnabled` deliberately leaves an unknown siteId to whatever the route
 * already did with one, see its doc comment), so this only proves the disabled case answers 403 and
 * an enabled site is unaffected.
 */

const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'

const sites: Record<string, any> = {
  [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, isEnabled: true },
  [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, isEnabled: false }
}

let searchPagesCalls = 0
let getPageCalls = 0

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    sites,
    models: {
      search: {
        searchPages: async () => {
          searchPagesCalls++
          return { results: [], totalHits: 0 }
        }
      },
      pages: {
        getPage: async () => {
          getPageCalls++
          return null
        }
      },
      groups: {
        actorForRequest: () => ({ permissions: [] }),
        checkAccess: () => true
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
  await registerPageSchema(app)
  await app.register(pagesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('LIST: answers 403 for a disabled site', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${DISABLED_SITE_ID}/pages` })
  assert.equal(res.statusCode, 403)
  assert.match(res.json().message, /disabled/i)
})

test('LIST: an enabled site still answers its (currently always-empty) list', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${ENABLED_SITE_ID}/pages` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [])
})

test('SEARCH: answers 403 for a disabled site, without ever calling searchPages', async () => {
  searchPagesCalls = 0
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${DISABLED_SITE_ID}/pages/search?query=foo`
  })
  assert.equal(res.statusCode, 403)
  assert.equal(searchPagesCalls, 0)
})

test('SEARCH: an enabled site reaches searchPages as before', async () => {
  searchPagesCalls = 0
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${ENABLED_SITE_ID}/pages/search?query=foo`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(searchPagesCalls, 1)
})

test('INCLUDE: answers 403 for a disabled site, without ever calling getPage', async () => {
  getPageCalls = 0
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${DISABLED_SITE_ID}/pages/include?path=home`
  })
  assert.equal(res.statusCode, 403)
  assert.equal(getPageCalls, 0)
})

test('INCLUDE: an enabled site reaches getPage as before', async () => {
  getPageCalls = 0
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${ENABLED_SITE_ID}/pages/include?path=home`
  })
  // -> 404 because getPage is stubbed to return null, but the guard let the request get there
  assert.equal(res.statusCode, 404)
  assert.equal(getPageCalls, 1)
})
