import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import iconsRoutes from './icons.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * OpenProject #931: `GET /sets`, `GET /search`, `GET /sets/:prefix/icons` and `POST /materialize`
 * used to declare route-level `config.permissions: PICKER_PERMISSIONS`, a list that mixed
 * `write:pages`/`manage:pages` (page-rule permissions) in with `manage:sites`/`manage:system`
 * (group-wide ones). Per CLAUDE.md's Permissions section, `config.permissions` is enforced by a
 * hook that only ever reads the group-wide session list — it silently reduced the check to
 * `manage:sites`/`manage:system` alone, refusing every ordinary author write access had been
 * granted to through a page rule. `mayUseIconPicker()` now checks in-handler instead, the same
 * `No route-level permissions:` pattern `api/blocks.ts`'s `mayListBlocks()` uses.
 *
 * Unit-level, no database: `WIKI.models.icons`/`groups` are stubbed the same way
 * `blocks.test.ts`'s site-scoped delegation suite stubs `WIKI.models.blocks`/`groups`.
 */
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

  /**
   * Stand-in for `groups.actorForRequest`/`mayHoldPermissionSomewhere`: `x-test-permissions` is the
   * group-wide list, `x-test-rule-roles` is what a page rule grants (comma-separated), mirroring how
   * `mayUseIconPicker()` consults both.
   */
  function actorForRequest(req: any) {
    const header = req.headers['x-test-permissions']
    const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
    return { groupIds: [], permissions }
  }

  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      routes: iconsRoutes,
      // -> `mayHoldPermissionSomewhere` is rebound per request, from the `x-test-rule-roles` header
      //    this suite grants page-rule roles through; returning `undefined` leaves the request's own
      //    session alone.
      session: (req: any) => {
        WIKI.models.groups.mayHoldPermissionSomewhere = (
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
            // -> Overridden per-request by the `session` hook above, which is what actually reads
            //    `x-test-rule-roles` -- this placeholder only exists so the shape is present before
            //    the hook runs at all.
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
    // -> No `x-test-permissions` at all: the group-wide list is empty. Only the rule-roles header
    //    grants anything, exactly like an ordinary author whose write access comes from a page rule.
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
