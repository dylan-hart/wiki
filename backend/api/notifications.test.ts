import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import notificationRoutes from './notifications.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

let app: FastifyInstance
let session: any
let apiKey: any
let listForUserMock: ReturnType<typeof mock.fn>
let unreadCountMock: ReturnType<typeof mock.fn>
let markReadMock: ReturnType<typeof mock.fn>
let getByIdMock: ReturnType<typeof mock.fn>

const SITE_ID = '11111111-1111-1111-1111-111111111111'
const USER_ID = '33333333-3333-3333-3333-333333333333'
const NOTIFICATION_ID = '44444444-4444-4444-4444-444444444444'
const ACTOR_ID = '55555555-5555-5555-5555-555555555555'
const SESSION_ACTOR = { groupIds: [], permissions: [], scope: null }

const ROW = {
  id: NOTIFICATION_ID,
  pageId: '66666666-6666-6666-6666-666666666666',
  pageTitle: 'Some Page',
  pagePath: 'some/page',
  pageLocale: 'en',
  action: 'updated',
  changedFields: ['title'],
  actorId: ACTOR_ID,
  createdAt: new Date('2026-08-17T12:00:00Z')
}

before(async () => {
  app = await buildTestApp({
    routes: notificationRoutes,
    // -> `apiKey` rides along as a per-request side effect, the way a bearer token would arrive
    session: (req: any) => {
      req.apiKey = apiKey
      return session
    },
    wiki: {
      models: {
        pageWatchEvents: {
          listForUser: (...args: any[]) => listForUserMock(...args),
          unreadCount: (...args: any[]) => unreadCountMock(...args),
          markRead: (...args: any[]) => markReadMock(...args)
        },
        users: {
          getById: (...args: any[]) => getByIdMock(...args)
        },
        groups: {
          groupIdsForRequest: () => [],
          actorForRequest: (req: any) => ({
            groupIds: [],
            permissions: [],
            scope: req.apiKey?.scope ?? null
          })
        }
      }
    }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  session = { authenticated: true, user: { id: USER_ID }, permissions: [] }
  apiKey = null
  listForUserMock = mock.fn(async () => [ROW])
  unreadCountMock = mock.fn(async () => 1)
  markReadMock = mock.fn(async () => true)
  getByIdMock = mock.fn(async () => ({ id: ACTOR_ID, name: 'Jane Actor' }))
})

test("GET lists the caller's unread notifications with a resolved actor name", async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/notifications` })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(listForUserMock.mock.calls[0]?.arguments, [USER_ID, SITE_ID, SESSION_ACTOR])
  assert.deepEqual(res.json(), [
    { ...ROW, createdAt: ROW.createdAt.toISOString(), actorName: 'Jane Actor' }
  ])
})

test('GET resolves an actor only once for repeated rows sharing the same actorId', async () => {
  listForUserMock = mock.fn(async () => [ROW, { ...ROW, id: 'other-row' }])

  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/notifications` })

  assert.equal(res.statusCode, 200)
  assert.equal(getByIdMock.mock.calls.length, 1)
})

test('GET falls back to "Someone" for a null actorId', async () => {
  listForUserMock = mock.fn(async () => [{ ...ROW, actorId: null }])

  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/notifications` })

  assert.equal(res.json()[0].actorName, 'Someone')
  assert.equal(getByIdMock.mock.calls.length, 0)
})

test('GET answers 401 for an unauthenticated caller and never touches the model', async () => {
  session = { authenticated: false }

  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/notifications` })

  assert.equal(res.statusCode, 401)
  assert.equal(listForUserMock.mock.calls.length, 0)
})

test("GET unread-count answers the caller's count", async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/notifications/unread-count`
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(unreadCountMock.mock.calls[0]?.arguments, [USER_ID, SITE_ID, SESSION_ACTOR])
  assert.deepEqual(res.json(), { count: 1 })
})

test('GET and unread-count filter as the request’s own actor, so an API key’s scope reaches the model', async () => {
  session = undefined
  apiKey = { id: 'key-1', userId: USER_ID, permissions: [], groupIds: [], scope: ['read:comments'] }

  const list = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/notifications` })
  const count = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/notifications/unread-count`
  })

  assert.equal(list.statusCode, 200)
  assert.equal(count.statusCode, 200)
  for (const call of [listForUserMock.mock.calls[0], unreadCountMock.mock.calls[0]]) {
    const [userId, siteId, actor] = call!.arguments as [string, string, any]
    assert.equal(userId, USER_ID)
    assert.equal(siteId, SITE_ID)
    assert.deepEqual(actor.scope, ['read:comments'])
  }
})

test('PATCH marks a notification read', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/notifications/${NOTIFICATION_ID}/read`
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(markReadMock.mock.calls[0]?.arguments, [NOTIFICATION_ID, USER_ID])
  assert.deepEqual(res.json(), { ok: true })
})

test('PATCH answers 404 for a notification that does not belong to the caller', async () => {
  markReadMock = mock.fn(async () => false)

  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/notifications/${NOTIFICATION_ID}/read`
  })

  assert.equal(res.statusCode, 404)
})

test('PATCH answers 401 for an unauthenticated caller and never touches the model', async () => {
  session = { authenticated: false }

  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/notifications/${NOTIFICATION_ID}/read`
  })

  assert.equal(res.statusCode, 401)
  assert.equal(markReadMock.mock.calls.length, 0)
})
