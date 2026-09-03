import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { mock } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * Feature #2425: the self-service `/profile/notifications` routes — a user's own per-event-type
 * email subscription toggles. Mirrors `profile.apiKeys.test.ts`'s harness: a minimal fastify app with
 * `req.session` simulated via the `x-test-session` header, and `WIKI.models.users` mocked rather than
 * hitting a real database — the DB-backed round trip through `prefs` itself is covered in
 * `models/users.profile.test.ts`. What belongs here is the routing: session-gating, and that the
 * session user id (never a client-supplied one) is what reaches the model.
 */

let app: FastifyInstance
let getNotificationSubscriptionsMock: ReturnType<typeof mock.fn>
let setNotificationSubscriptionsMock: ReturnType<typeof mock.fn>

const USER_ID = '11111111-1111-1111-1111-111111111111'

const ALL_FALSE = {
  'page:create': false,
  'page:edit': false,
  'page:rename': false,
  'page:delete': false,
  'asset:upload': false,
  'asset:edit': false,
  'asset:rename': false,
  'asset:delete': false,
  'comment:new': false,
  'comment:edit': false,
  'comment:delete': false,
  'user:join': false,
  'user:login': false,
  'user:logout': false,
  'approval:submitted': false,
  'approval:approved': false,
  'approval:rejected': false,
  'page:classification-changed': false
}

function sessionHeader(userId: string | null) {
  return userId
    ? { 'x-test-session': JSON.stringify({ authenticated: true, user: { id: userId } }) }
    : {}
}

before(async () => {
  getNotificationSubscriptionsMock = mock.fn(async () => ({ ...ALL_FALSE }))
  setNotificationSubscriptionsMock = mock.fn(async () => ({
    ...ALL_FALSE,
    'page:create': true
  }))
  app = await buildTestApp({
    routes: usersRoutes,
    session: 'header',
    wiki: {
      models: {
        users: {
          getNotificationSubscriptions: getNotificationSubscriptionsMock,
          setNotificationSubscriptions: setNotificationSubscriptionsMock
        }
      }
    }
  })
})

after(() => closeTestApp(app))

afterEach(() => {
  getNotificationSubscriptionsMock.mock.resetCalls()
  setNotificationSubscriptionsMock.mock.resetCalls()
})

test('GET /profile/notifications refuses an anonymous request', async () => {
  const res = await app.inject({ method: 'GET', url: '/profile/notifications' })
  assert.equal(res.statusCode, 401)
  assert.equal(getNotificationSubscriptionsMock.mock.calls.length, 0)
})

test("GET /profile/notifications returns the session user's own subscription map", async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/profile/notifications',
    headers: sessionHeader(USER_ID)
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), ALL_FALSE)
  assert.equal(getNotificationSubscriptionsMock.mock.calls.length, 1)
  assert.equal(getNotificationSubscriptionsMock.mock.calls[0].arguments[0], USER_ID)
})

test('GET /profile/notifications answers 401 when the session outlived the user it points at', async () => {
  getNotificationSubscriptionsMock.mock.mockImplementationOnce(async () => null)
  const res = await app.inject({
    method: 'GET',
    url: '/profile/notifications',
    headers: sessionHeader(USER_ID)
  })
  assert.equal(res.statusCode, 401)
})

test('PUT /profile/notifications refuses an anonymous request', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/profile/notifications',
    payload: { 'page:create': true }
  })
  assert.equal(res.statusCode, 401)
  assert.equal(setNotificationSubscriptionsMock.mock.calls.length, 0)
})

test('PUT /profile/notifications passes the session user id and the body patch through to the model', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/profile/notifications',
    headers: sessionHeader(USER_ID),
    payload: { 'page:create': true }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, subscriptions: { ...ALL_FALSE, 'page:create': true } })
  assert.equal(setNotificationSubscriptionsMock.mock.calls.length, 1)
  assert.equal(setNotificationSubscriptionsMock.mock.calls[0].arguments[0], USER_ID)
  assert.deepEqual(setNotificationSubscriptionsMock.mock.calls[0].arguments[1], {
    'page:create': true
  })
})

test('PUT /profile/notifications silently drops an unknown event key, matching every other route in this codebase', async () => {
  // -> This instance's ajv is configured with the Fastify default `removeAdditional: true` (see
  //    `schemas/comment.ts`'s own doc comment on `CommentUpdateInput`), which deletes an undeclared
  //    property from the body rather than rejecting the request -- so an unknown key never reaches
  //    the model, but the request still succeeds rather than 400ing.
  const res = await app.inject({
    method: 'PUT',
    url: '/profile/notifications',
    headers: sessionHeader(USER_ID),
    payload: { 'not:a-real-event': true, 'page:create': true }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(setNotificationSubscriptionsMock.mock.calls.length, 1)
  assert.deepEqual(setNotificationSubscriptionsMock.mock.calls[0].arguments[1], {
    'page:create': true
  })
})

test('PUT /profile/notifications rejects a non-boolean value for a known event key', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/profile/notifications',
    headers: sessionHeader(USER_ID),
    payload: { 'page:create': 'yes' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(setNotificationSubscriptionsMock.mock.calls.length, 0)
})
