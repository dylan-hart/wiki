import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { mock } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * OpenProject #788: the self-service `/users/profile/api-keys*` routes — list/create/revoke a
 * personal access token, scoped to the session's own user id. Mirrors the harness
 * `api/users.test.ts` already uses for `/whoami` (a minimal fastify app, `req.session` simulated via
 * an `onRequest` hook reading a test-only header), with `WIKI.models.apiKeys` mocked rather than
 * hitting a real database — the DB-backed live-resolution behavior itself is covered in
 * `models/apiKeys.test.ts`; what belongs here is the routing: who may call these, and that ownership
 * is enforced rather than trusted from the URL alone.
 */

let app: FastifyInstance
let listKeysForUserMock: ReturnType<typeof mock.fn>
let createKeyMock: ReturnType<typeof mock.fn>
let getKeyByIdMock: ReturnType<typeof mock.fn>
let revokeKeyForUserMock: ReturnType<typeof mock.fn>
let auditLogRecordMock: ReturnType<typeof mock.fn>

const OWNER_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222'
const KEY_ID = '44444444-4444-4444-4444-444444444444'

function sessionHeader(userId: string | null) {
  return userId
    ? { 'x-test-session': JSON.stringify({ authenticated: true, user: { id: userId } }) }
    : {}
}

before(async () => {
  listKeysForUserMock = mock.fn(async () => [])
  createKeyMock = mock.fn(async () => ({ id: 'new-key-id', key: 'signed.jwt.token' }))
  getKeyByIdMock = mock.fn(async () => null)
  revokeKeyForUserMock = mock.fn(async () => true)
  auditLogRecordMock = mock.fn(async () => {})
  app = await buildTestApp({
    routes: usersRoutes,
    swagger: true,
    session: 'header',
    wiki: {
      models: {
        apiKeys: {
          listKeysForUser: listKeysForUserMock,
          createKey: createKeyMock,
          getKeyById: getKeyByIdMock,
          revokeKeyForUser: revokeKeyForUserMock
        },
        auditLog: {
          record: auditLogRecordMock
        }
      }
    }
  })
})

after(() => closeTestApp(app))

afterEach(() => {
  listKeysForUserMock.mock.resetCalls()
  createKeyMock.mock.resetCalls()
  getKeyByIdMock.mock.resetCalls()
  revokeKeyForUserMock.mock.resetCalls()
  auditLogRecordMock.mock.resetCalls()
})

test('GET /profile/api-keys refuses an anonymous request', async () => {
  const res = await app.inject({ method: 'GET', url: '/profile/api-keys' })
  assert.equal(res.statusCode, 401)
  assert.equal(listKeysForUserMock.mock.calls.length, 0)
})

test("GET /profile/api-keys lists only the session user's own tokens", async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/profile/api-keys',
    headers: sessionHeader(OWNER_ID)
  })
  assert.equal(res.statusCode, 200)
  assert.equal(listKeysForUserMock.mock.calls.length, 1)
  assert.equal(listKeysForUserMock.mock.calls[0].arguments[0], OWNER_ID)
})

test('POST /profile/api-keys refuses an anonymous request', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/profile/api-keys',
    payload: { name: 'My token', expiration: '30d' }
  })
  assert.equal(res.statusCode, 401)
  assert.equal(createKeyMock.mock.calls.length, 0)
})

test('POST /profile/api-keys creates a token attributed to the session user, with no groups field to pick', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/profile/api-keys',
    headers: sessionHeader(OWNER_ID),
    payload: { name: 'My token', expiration: '30d', scope: ['read:pages'] }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.key, 'signed.jwt.token')
  assert.equal(createKeyMock.mock.calls.length, 1)
  const call = createKeyMock.mock.calls[0].arguments[0] as any
  assert.equal(call.userId, OWNER_ID)
  assert.equal(call.name, 'My token')
  assert.deepEqual(call.scope, ['read:pages'])
  assert.equal('groups' in call, false)
})

test('POST /profile/api-keys refuses a name with disallowed characters', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/profile/api-keys',
    headers: sessionHeader(OWNER_ID),
    payload: { name: 'bad<name>', expiration: '30d' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createKeyMock.mock.calls.length, 0)
})

test('POST /profile/api-keys refuses a siteId naming a site that does not exist', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/profile/api-keys',
    headers: sessionHeader(OWNER_ID),
    payload: {
      name: 'My token',
      expiration: '30d',
      siteId: '33333333-3333-3333-3333-333333333333'
    }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createKeyMock.mock.calls.length, 0)
})

test('POST /profile/api-keys/:keyId/revoke refuses an anonymous request', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/profile/api-keys/${KEY_ID}/revoke`
  })
  assert.equal(res.statusCode, 401)
  assert.equal(getKeyByIdMock.mock.calls.length, 0)
})

test('POST /profile/api-keys/:keyId/revoke answers 404 for a token owned by somebody else, exactly like one that does not exist', async () => {
  getKeyByIdMock.mock.mockImplementationOnce(async () => ({
    id: KEY_ID,
    userId: OTHER_USER_ID,
    isRevoked: false
  }))
  const res = await app.inject({
    method: 'POST',
    url: `/profile/api-keys/${KEY_ID}/revoke`,
    headers: sessionHeader(OWNER_ID)
  })
  assert.equal(res.statusCode, 404)
  // -> Ownership is refused before ever touching the revoke call — ownership is checked, not
  //    outsourced to a DB WHERE clause silently updating zero rows
  assert.equal(revokeKeyForUserMock.mock.calls.length, 0)
})

test('POST /profile/api-keys/:keyId/revoke answers 409 for a token already revoked', async () => {
  getKeyByIdMock.mock.mockImplementationOnce(async () => ({
    id: KEY_ID,
    userId: OWNER_ID,
    isRevoked: true
  }))
  const res = await app.inject({
    method: 'POST',
    url: `/profile/api-keys/${KEY_ID}/revoke`,
    headers: sessionHeader(OWNER_ID)
  })
  assert.equal(res.statusCode, 409)
  assert.equal(revokeKeyForUserMock.mock.calls.length, 0)
})

test("POST /profile/api-keys/:keyId/revoke revokes the caller's own token", async () => {
  getKeyByIdMock.mock.mockImplementationOnce(async () => ({
    id: KEY_ID,
    userId: OWNER_ID,
    isRevoked: false
  }))
  const res = await app.inject({
    method: 'POST',
    url: `/profile/api-keys/${KEY_ID}/revoke`,
    headers: sessionHeader(OWNER_ID)
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, message: 'Personal access token revoked successfully.' })
  assert.equal(revokeKeyForUserMock.mock.calls.length, 1)
  assert.deepEqual(revokeKeyForUserMock.mock.calls[0].arguments, [KEY_ID, OWNER_ID])
})
