import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

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

  /** One per shape of profile route, not an exhaustive list. */
  const anonymous: Array<[string, string]> = [
    ['GET', '/users/profile'],
    ['GET', '/users/profile/groups'],
    ['GET', '/users/profile/api-keys'],
    ['GET', '/users/profile/editor-settings/markdown'],
    ['GET', '/users/profile/notifications'],
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
    // -> 403, not 401: a `requireSessionUser` leaked onto `admin.ts` would answer 401 here.
    assert.equal(res.statusCode, 403)
  })

  test('an anonymous request to an admin route is still 401, from its own permission gate', async () => {
    // -> Not a scoping proof on its own: the route-permission hook answers a session-less request
    //    with the same body `requireSessionUser` would. The 403 above is what tells the two apart.
    const res = await app.inject({ method: 'GET', url: '/users/defaults' })
    assert.equal(res.statusCode, 401)
  })
})
