import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import iconsRoutes from './icons.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

describe('icons picker permissions (task #931)', () => {
  let getSetsCalls = 0
  let searchIconsCalls = 0
  let listSetIconsCalls = 0
  let materializeIconsCalls = 0

  async function getSets() {
    getSetsCalls++
    return [{ prefix: 'mdi', name: 'Material Design Icons', iconCount: 1, isEnabled: true }]
  }
  async function searchIcons() {
    searchIconsCalls++
    return ['mdi:account']
  }
  async function listSetIcons() {
    listSetIconsCalls++
    return ['account']
  }
  async function materializeIcons(refs: string[]) {
    materializeIconsCalls++
    return refs.filter(() => false)
  }

  /** `x-test-permissions` is the group-wide list; `x-test-rule-roles` what a page rule grants. */
  function actorForRequest(req: any) {
    const header = req.headers['x-test-permissions']
    const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
    return { groupIds: [], permissions }
  }

  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      routes: iconsRoutes,
      // -> Rebinds `mayHoldPermissionSomewhere` per request, since it never sees `req` itself;
      //    returning `undefined` leaves the session alone.
      session: (req: any) => {
        CARDINAL.models.groups.mayHoldPermissionSomewhere = (
          actor: { permissions: string[] },
          permissions: string[]
        ) => {
          if (actor.permissions.includes('manage:system')) {
            return true
          }
          const header = req.headers['x-test-rule-roles']
          const roles = typeof header === 'string' ? header.split(',').filter(Boolean) : []
          return permissions.some((p) => roles.includes(p))
        }
        return undefined
      },
      wiki: {
        models: {
          icons: { getSets, searchIcons, listSetIcons, materializeIcons },
          groups: {
            actorForRequest,
            // -> Placeholder: the `session` hook above rebinds this per request.
            mayHoldPermissionSomewhere: () => false
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    getSetsCalls = 0
    searchIconsCalls = 0
    listSetIconsCalls = 0
    materializeIconsCalls = 0
  })

  test('a caller with no relevant permission and no page rule is refused on every picker route', async () => {
    const routes: Array<{ method: 'GET' | 'POST'; url: string; payload?: any }> = [
      { method: 'GET', url: '/sets' },
      { method: 'GET', url: '/search?query=account' },
      { method: 'GET', url: '/sets/mdi/icons' },
      { method: 'POST', url: '/materialize', payload: { icons: ['mdi:account'] } }
    ]
    for (const route of routes) {
      const res = await app.inject({ method: route.method, url: route.url, payload: route.payload })
      assert.equal(res.statusCode, 403, `${route.method} ${route.url}`)
    }
    assert.equal(getSetsCalls, 0)
    assert.equal(searchIconsCalls, 0)
    assert.equal(listSetIconsCalls, 0)
    assert.equal(materializeIconsCalls, 0)
  })

  test('manage:sites (group-wide) may use every picker route', async () => {
    const headers = { 'x-test-permissions': 'manage:sites' }
    assert.equal((await app.inject({ method: 'GET', url: '/sets', headers })).statusCode, 200)
    assert.equal(
      (await app.inject({ method: 'GET', url: '/search?query=account', headers })).statusCode,
      200
    )
    assert.equal(
      (await app.inject({ method: 'GET', url: '/sets/mdi/icons', headers })).statusCode,
      200
    )
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/materialize',
          headers,
          payload: { icons: ['mdi:account'] }
        })
      ).statusCode,
      200
    )
    assert.equal(getSetsCalls, 1)
    assert.equal(searchIconsCalls, 1)
    assert.equal(listSetIconsCalls, 1)
    assert.equal(materializeIconsCalls, 1)
  })

  test('write:pages granted only through a page rule (absent from the group-wide list) may use every picker route', async () => {
    const headers = { 'x-test-rule-roles': 'write:pages' }
    assert.equal((await app.inject({ method: 'GET', url: '/sets', headers })).statusCode, 200)
    assert.equal(
      (await app.inject({ method: 'GET', url: '/search?query=account', headers })).statusCode,
      200
    )
    assert.equal(
      (await app.inject({ method: 'GET', url: '/sets/mdi/icons', headers })).statusCode,
      200
    )
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/materialize',
          headers,
          payload: { icons: ['mdi:account'] }
        })
      ).statusCode,
      200
    )
  })

  test('manage:pages granted only through a page rule may use every picker route', async () => {
    const headers = { 'x-test-rule-roles': 'manage:pages' }
    assert.equal((await app.inject({ method: 'GET', url: '/sets', headers })).statusCode, 200)
  })

  test('manage:system bypasses the check entirely', async () => {
    const headers = { 'x-test-permissions': 'manage:system' }
    assert.equal((await app.inject({ method: 'GET', url: '/sets', headers })).statusCode, 200)
  })

  test('an unrelated group-wide permission alone is still refused', async () => {
    const headers = { 'x-test-permissions': 'manage:navigation' }
    const res = await app.inject({ method: 'GET', url: '/sets', headers })
    assert.equal(res.statusCode, 403)
    assert.equal(getSetsCalls, 0)
  })
})

/**
 * Its own `buildTestApp` instance: unlike the picker routes above, `POST /sideload` is gated by the
 * real `config.permissions` preHandler, which needs `session: 'header', permissions: true`.
 */
describe('icons sideload route (task #2946)', () => {
  const sideloadResult = {
    loaded: [{ prefix: 'tabler', iconCount: 42 }],
    skipped: [{ prefix: 'broken', error: 'invalid JSON' }]
  }

  function headersFor(permissions: string[]) {
    return {
      'x-test-session': JSON.stringify({ authenticated: true, permissions, groups: [] })
    }
  }

  let sideloadApp: FastifyInstance
  let sideloadCalls = 0

  before(async () => {
    sideloadApp = await buildTestApp({
      routes: iconsRoutes,
      session: 'header',
      permissions: true,
      wiki: {
        models: {
          icons: {
            sideloadFromDataPath: async () => {
              sideloadCalls++
              return sideloadResult
            }
          }
        }
      }
    })
  })

  after(() => closeTestApp(sideloadApp))

  beforeEach(() => {
    sideloadCalls = 0
  })

  test('requires manage:system', async () => {
    const res = await sideloadApp.inject({
      method: 'POST',
      url: '/sideload',
      headers: headersFor(['manage:users'])
    })
    assert.equal(res.statusCode, 403)
    assert.equal(sideloadCalls, 0)
  })

  test('refuses an unauthenticated request', async () => {
    const res = await sideloadApp.inject({ method: 'POST', url: '/sideload' })
    assert.equal(res.statusCode, 401)
    assert.equal(sideloadCalls, 0)
  })

  test('runs the rescan and returns what it did, verbatim from the model', async () => {
    const res = await sideloadApp.inject({
      method: 'POST',
      url: '/sideload',
      headers: headersFor(['manage:system'])
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), sideloadResult)
    assert.equal(sideloadCalls, 1)
  })
})
