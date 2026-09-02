import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * `profile.ts`'s `requireSessionUser` preHandler (API-F5).
 *
 * Every `/profile*` route used to open with its own copy of the same four lines --
 * `const userId = sessionUserId(req)`, then `if (!userId) return reply.unauthorized()` -- 21 of
 * them. Replacing 21 in-handler checks with one hook is only safe if three things stay true, and
 * this file is what keeps them true:
 *
 * 1. every one of those routes still answers 401 for a session-less request, with the identical
 *    body (`reply.unauthorized()` carries no message, so it is `http-errors`' own "Unauthorized");
 * 2. the hook runs where the in-handler checks did, i.e. AFTER schema validation -- a request that
 *    is both anonymous AND malformed still answers 400 first, exactly as it did before;
 * 3. the hook does not leak out of the sub-plugin onto an `admin.ts` route, which is
 *    `config.permissions`-gated rather than session-gated and must keep answering 403 to a caller
 *    holding a session but not the permission.
 */
describe('profile sub-plugin: requireSessionUser', () => {
  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      routes: usersRoutes,
      prefix: '/users',
      session: 'header',
      permissions: true,
      ajv: true,
      wiki: { config: {} }
    })
  })

  after(() => closeTestApp(app))

  /**
   * One per shape of profile route: a plain GET, a nested GET, a parameterised GET, a DELETE with a
   * path param, and a PUT with a body. If the hook were registered anywhere but on this sub-plugin's
   * own scope, at least one of these would answer something other than 401.
   */
  const anonymous: Array<[string, string]> = [
    ['GET', '/users/profile'],
    ['GET', '/users/profile/groups'],
    ['GET', '/users/profile/api-keys'],
    ['GET', '/users/profile/editor-settings/markdown'],
    ['GET', '/users/profile/auth'],
    ['GET', '/users/profile/tfa/recovery-codes?strategyId=00000000-0000-4000-8000-000000000000'],
    ['DELETE', '/users/profile/passkeys/11111111-1111-4111-8111-111111111111'],
    ['POST', '/users/profile/passkeys/challenge']
  ]

  for (const [method, url] of anonymous) {
    test(`${method} ${url} answers 401 Unauthorized with no session`, async () => {
      const res = await app.inject({ method: method as any, url })
      assert.equal(res.statusCode, 401)
      assert.deepEqual(res.json(), {
        ok: false,
        error: 'UnauthorizedError',
        statusCode: 401,
        message: 'Unauthorized'
      })
    })
  }

  test('validation still runs first: an anonymous request with a bad body answers 400, not 401', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/users/profile/password',
      payload: { strategyId: 'not-a-uuid', currentPassword: 'x', newPassword: 'yyyyyyyy' }
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /strategyId/)
  })

  test('the hook is scoped to this sub-plugin: an admin route still answers on its own permission gate', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/defaults',
      headers: { 'x-test-permissions': 'read:pages' }
    })
    // -> 403, not 401: the caller HAS a session, it just does not hold `read:users`/`manage:users`.
    //    A `requireSessionUser` that had escaped onto `admin.ts` could not produce this.
    assert.equal(res.statusCode, 403)
  })

  test('an anonymous request to an admin route is still 401, from its own permission gate', async () => {
    // -> Not a scoping proof on its own: the route-permission hook answers a session-less request
    //    with the same `reply.unauthorized()` body `requireSessionUser` would. The 403 above is what
    //    tells the two apart. This is here so the anonymous case is asserted for both audiences.
    const res = await app.inject({ method: 'GET', url: '/users/defaults' })
    assert.equal(res.statusCode, 401)
  })
})
