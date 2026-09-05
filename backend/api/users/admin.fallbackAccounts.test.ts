import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * `GET /fallback-accounts` route wiring: the real global permission gate
 * (`core/http/authHooks.ts#permissionPreHandler`, installed via `permissions: true`) plus a stubbed
 * `WIKI.models.users.getFallbackAccounts` — the query itself is a real database concern, covered by
 * `models/users.fallbackAccounts.db.test.ts`.
 */

const RESULT = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Pending Reset',
    email: 'pending@example.com',
    providerKey: 'ldap',
    createdAt: new Date('2026-01-01T00:00:00.000Z')
  }
]

let app: FastifyInstance

before(async () => {
  const wiki = {
    models: {
      users: {
        async getFallbackAccounts() {
          return RESULT
        }
      }
    }
  }

  app = await buildTestApp({ routes: usersRoutes, wiki, session: 'header', permissions: true })
})

after(() => closeTestApp(app))

function headersFor(permissions: string[]) {
  return {
    'x-test-session': JSON.stringify({ authenticated: true, permissions, groups: [] })
  }
}

test('a read:users holder gets the fallback-accounts report', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/fallback-accounts',
    headers: headersFor(['read:users'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Pending Reset',
      email: 'pending@example.com',
      providerKey: 'ldap',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  ])
})

test('a manage:users holder gets the report too', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/fallback-accounts',
    headers: headersFor(['manage:users'])
  })
  assert.equal(res.statusCode, 200)
})

test('an account with neither permission is refused', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/fallback-accounts',
    headers: headersFor(['manage:navigation'])
  })
  assert.equal(res.statusCode, 403)
})

test('a guest is refused', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/fallback-accounts'
  })
  assert.equal(res.statusCode, 401)
})
