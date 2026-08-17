import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import pagesRoutes, { mayOnPage, pagePermissionsFor } from './pages.ts'
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

/**
 * Regression tests for task 673: `mayOnPage` and `pagePermissionsFor` take an explicit `siteId` and
 * thread it into the `RulePageRef` given to `checkAccess`, so a page rule scoped to one site (task
 * 671) is actually enforced from these two call sites rather than silently matching every site's
 * rules. Exercised directly rather than through a route, since both are plain functions exported for
 * exactly this reason.
 */

test('mayOnPage: threads siteId into the RulePageRef passed to checkAccess', () => {
  const calls: any[] = []
  const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return true
  }
  try {
    const result = mayOnPage({} as any, 'read:pages', ENABLED_SITE_ID, { path: 'foo/bar' })
    assert.equal(result, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].siteId, ENABLED_SITE_ID)
    assert.equal(calls[0].path, 'foo/bar')
  } finally {
    ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
  }
})

test('pagePermissionsFor: threads siteId into every RulePageRef it checks', () => {
  const calls: any[] = []
  const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return false
  }
  try {
    pagePermissionsFor({} as any, ENABLED_SITE_ID, { path: 'foo/bar' })
    assert.ok(calls.length > 0)
    for (const page of calls) {
      assert.equal(page.siteId, ENABLED_SITE_ID)
      assert.equal(page.path, 'foo/bar')
    }
  } finally {
    ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
  }
})

test('PAGE USER PERMISSIONS route: passes the route siteId through to pagePermissionsFor', async () => {
  const calls: any[] = []
  const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return false
  }
  try {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${ENABLED_SITE_ID}/pages/userPermissions`,
      payload: { path: 'foo/bar' }
    })
    assert.equal(res.statusCode, 200)
    assert.ok(calls.length > 0)
    for (const page of calls) {
      assert.equal(page.siteId, ENABLED_SITE_ID)
    }
  } finally {
    ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
  }
})

test('RESOLVE ALIAS route: passes the route siteId through an inline page ref to mayOnPage', async () => {
  const calls: any[] = []
  const originalCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
  const originalGetPathFromAlias = (globalThis as any).WIKI.models.pages.getPathFromAlias
  ;(globalThis as any).WIKI.models.groups.checkAccess = (
    _actor: any,
    _permission: string,
    page: any
  ) => {
    calls.push(page)
    return true
  }
  ;(globalThis as any).WIKI.models.pages.getPathFromAlias = async () => ({
    id: 'p1',
    path: 'some/path'
  })
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${ENABLED_SITE_ID}/pages/alias/foo`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].siteId, ENABLED_SITE_ID)
    assert.equal(calls[0].path, 'some/path')
  } finally {
    ;(globalThis as any).WIKI.models.groups.checkAccess = originalCheckAccess
    ;(globalThis as any).WIKI.models.pages.getPathFromAlias = originalGetPathFromAlias
  }
})
