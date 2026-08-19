import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import watchingRoutes from './watching.ts'
import { registerSchemas as registerPageSchemas } from './schemas/page.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

/**
 * Task 530's API surface: `PATCH /sites/:siteId/pages/:pageId/watch` (the new preference-setting
 * route) and the preference now threaded through `PUT` on the same path. `WIKI.models.pageWatching`
 * and the permission chain (`WIKI.models.pages.getPage` / `WIKI.models.groups`) are stubbed — the
 * model's own persistence and default-resolution behavior is `models/pageWatching.test.ts`'s
 * DB-backed coverage; this is only the route's request/response wiring and its 404-vs-200 branching.
 */

let app: FastifyInstance
let session: any
let watchMock: ReturnType<typeof mock.fn>
let setPreferenceMock: ReturnType<typeof mock.fn>
let getPreferenceMock: ReturnType<typeof mock.fn>
let getPageMock: ReturnType<typeof mock.fn>

const SITE_ID = '11111111-1111-1111-1111-111111111111'
const PAGE_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = '33333333-3333-3333-3333-333333333333'
const PAGE = { id: PAGE_ID, path: 'some/page', locale: 'en', tags: [] }
const RESOLVED_PREFERENCE = {
  notifyMode: 'digest',
  notifyOnEdited: true,
  notifyOnMoved: true,
  notifyOnDeleted: true
}

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      pages: {
        getPage: (...args: any[]) => getPageMock(...args)
      },
      groups: {
        actorForRequest: () => ({ groupIds: [], permissions: [] }),
        checkAccess: () => true,
        groupIdsForRequest: () => []
      },
      pageWatching: {
        watch: (...args: any[]) => watchMock(...args),
        setPreference: (...args: any[]) => setPreferenceMock(...args),
        getPreference: (...args: any[]) => getPreferenceMock(...args),
        unwatch: async () => {},
        listForUser: async () => []
      }
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  // -> Stand-in for `@fastify/session` (registered app-wide in `index.ts`, not here), same pattern
  //    `api/authentication.test.ts` uses — mutable per-test via the `session` module variable.
  app.decorateRequest('session', null as any)
  app.addHook('onRequest', async (req) => {
    req.session = session
  })
  await registerPageSchemas(app)
  await registerErrorSchema(app)
  await app.register(watchingRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  session = { authenticated: true, user: { id: USER_ID }, permissions: [] }
  watchMock = mock.fn(async () => {})
  setPreferenceMock = mock.fn(async () => true)
  getPreferenceMock = mock.fn(async () => RESOLVED_PREFERENCE)
  getPageMock = mock.fn(async () => PAGE)
})

const WATCH_URL = `/sites/${SITE_ID}/pages/${PAGE_ID}/watch`

test('PATCH sets a preference and returns the resolved value', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: WATCH_URL,
    payload: { notifyMode: 'immediate' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(setPreferenceMock.mock.calls.length, 1)
  assert.deepEqual(setPreferenceMock.mock.calls[0]?.arguments[0], {
    pageId: PAGE_ID,
    userId: USER_ID,
    notifyMode: 'immediate'
  })
  assert.deepEqual(res.json(), { ok: true, preference: RESOLVED_PREFERENCE })
})

test('PATCH answers 404 when the caller is not watching the page', async () => {
  setPreferenceMock = mock.fn(async () => false)

  const res = await app.inject({
    method: 'PATCH',
    url: WATCH_URL,
    payload: { notifyMode: 'immediate' }
  })

  assert.equal(res.statusCode, 404)
  assert.equal(getPreferenceMock.mock.calls.length, 0)
})

test('PATCH answers 401 for an unauthenticated caller and never touches the model', async () => {
  session = { authenticated: false }

  const res = await app.inject({
    method: 'PATCH',
    url: WATCH_URL,
    payload: { notifyMode: 'immediate' }
  })

  assert.equal(res.statusCode, 401)
  assert.equal(setPreferenceMock.mock.calls.length, 0)
})

test('PATCH strips an unknown field from the body rather than passing it through', async () => {
  // -> Fastify's ajv strips properties `additionalProperties: false` disallows rather than erroring
  //    on them, so the assertion here is that the model never SEES the extra field — not a 400.
  const res = await app.inject({
    method: 'PATCH',
    url: WATCH_URL,
    payload: { notifyMode: 'immediate', somethingElse: true }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(setPreferenceMock.mock.calls[0]?.arguments[0], {
    pageId: PAGE_ID,
    userId: USER_ID,
    notifyMode: 'immediate'
  })
})

test('PUT passes an optional preference through to watch() and returns it resolved', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: WATCH_URL,
    payload: { notifyMode: 'immediate', notifyOnMoved: false }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(watchMock.mock.calls[0]?.arguments[0], {
    siteId: SITE_ID,
    pageId: PAGE_ID,
    userId: USER_ID,
    notifyMode: 'immediate',
    notifyOnMoved: false
  })
  assert.deepEqual(res.json(), { ok: true, isWatching: true, preference: RESOLVED_PREFERENCE })
})

test('PUT with no body still succeeds, passing no preference through', async () => {
  const res = await app.inject({ method: 'PUT', url: WATCH_URL })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(watchMock.mock.calls[0]?.arguments[0], {
    siteId: SITE_ID,
    pageId: PAGE_ID,
    userId: USER_ID
  })
})
