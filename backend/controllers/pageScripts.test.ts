import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import pageScriptsRoutes from './pageScripts.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

describe('/_pages/:pageId/script.js (OpenProject #3405)', () => {
  const VALID_UUID = '11111111-1111-4111-8111-111111111111'

  const SITE_A_ID = 'site-a-id'
  const SITE_B_ID = 'site-b-id'

  const sites: Record<string, any> = {
    [SITE_A_ID]: {
      id: SITE_A_ID,
      hostname: 'a.example.com',
      isEnabled: true,
      config: { features: { pageScripts: true } }
    },
    [SITE_B_ID]: {
      id: SITE_B_ID,
      hostname: 'b.example.com',
      isEnabled: true,
      config: { features: { pageScripts: true } }
    },
    'disabled-site': {
      id: 'disabled-site',
      hostname: 'off.example.com',
      isEnabled: false,
      config: { features: { pageScripts: true } }
    },
    'flag-off-site': {
      id: 'flag-off-site',
      hostname: 'flagoff.example.com',
      isEnabled: true,
      config: { features: { pageScripts: false } }
    }
  }

  let page: any
  let checkAccessResult = true
  let checkAccessCalls: any[] = []

  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      config: {},
      models: {
        sites: {
          getSiteByHostname: async ({ hostname }: { hostname: string }) =>
            Object.values(sites).find((s) => s.hostname === hostname) ?? null
        },
        pages: {
          getPage: async ({ siteId, id }: { siteId: string; id: string }) => {
            if (!page || page.id !== id || page.siteId !== siteId) {
              return null
            }
            return page
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: (_actor: any, _permission: string, target: any) => {
            checkAccessCalls.push(target)
            return checkAccessResult
          },
          groupIdsForRequest: () => []
        }
      }
    })
    app = fastify()
    await app.register(fastifySensible)
    await app.register(pageScriptsRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  const basePage = {
    id: VALID_UUID,
    siteId: SITE_A_ID,
    path: 'some/page',
    locale: 'en',
    tags: [],
    isLocked: false,
    scriptJsLoad: '',
    scriptJsUnload: ''
  }

  test('an invalid UUID 404s before any query runs', async () => {
    page = null
    const res = await app.inject({
      method: 'GET',
      url: '/not-a-uuid/script.js',
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('a hostname with no site behind it answers 404', async () => {
    page = null
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}/script.js`,
      headers: { host: 'nowhere.example.com' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('a disabled site is refused with 403 before the flag or the page is ever consulted', async () => {
    page = null
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}/script.js`,
      headers: { host: 'off.example.com' }
    })
    assert.equal(res.statusCode, 403)
  })

  test('the site-wide features.pageScripts flag off answers 403, before read:pages is checked', async () => {
    page = { ...basePage, siteId: 'flag-off-site', scriptJsLoad: 'console.log(1)' }
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}/script.js`,
      headers: { host: 'flagoff.example.com' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(checkAccessCalls.length, 0)
  })

  test('a missing page answers 404', async () => {
    page = null
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}/script.js`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('an unreadable (denied read:pages) page answers 404, not the bytes', async () => {
    page = { ...basePage, scriptJsLoad: 'console.log(1)' }
    checkAccessResult = false
    checkAccessCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}/script.js`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 404)
    assert.equal(checkAccessCalls.length, 1)
    checkAccessResult = true
  })

  test("a request from site B's hostname for site A's page id answers 404", async () => {
    page = { ...basePage, scriptJsLoad: 'console.log(1)' }
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}/script.js`,
      headers: { host: 'b.example.com' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('a readable page with both hooks set returns a module exporting load() and unload(), private and immutable', async () => {
    page = {
      ...basePage,
      scriptJsLoad: "console.log('loaded')",
      scriptJsUnload: "console.log('unloaded')"
    }
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}/script.js`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8')
    assert.equal(res.headers['cache-control'], 'private, max-age=31536000, immutable')
    assert.match(res.body, /export function load\(\) \{\nconsole\.log\('loaded'\)\n\}/)
    assert.match(res.body, /export function unload\(\) \{\nconsole\.log\('unloaded'\)\n\}/)
  })

  test('a page with only scriptJsLoad set exports only load()', async () => {
    page = { ...basePage, scriptJsLoad: "console.log('loaded')" }
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}/script.js`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 200)
    assert.match(res.body, /export function load/)
    assert.doesNotMatch(res.body, /export function unload/)
  })

  test('a page with neither hook set returns an empty body', async () => {
    page = { ...basePage }
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}/script.js`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, '')
  })

  test('a locked page (still readable) returns 200 with an empty body -- toPage() already blanked both fields', async () => {
    page = { ...basePage, isLocked: true, scriptJsLoad: '', scriptJsUnload: '' }
    const res = await app.inject({
      method: 'GET',
      url: `/${VALID_UUID}/script.js`,
      headers: { host: 'a.example.com' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, '')
  })
})
