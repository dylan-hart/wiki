import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import watchingRoutes from './watching.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

describe('watch preference routes (task 530)', () => {
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
    app = await buildTestApp({
      routes: watchingRoutes,
      // -> Stand-in for `@fastify/session` (registered app-wide in the real boot, not here) —
      //    mutable per-test via the `session` module variable.
      session: () => session,
      wiki: {
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
    })
  })

  after(() => closeTestApp(app))

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
})

describe('WATCH route — siteId threading (task 673)', () => {
  /**
   * Regression test for task 673: `loadWatchablePage`'s call to `mayOnPage` (pages.ts) passes the
   * route's `siteId` through, so a page rule scoped to one site (task 671) is enforced when deciding
   * whether the caller may watch a page, not just when reading it.
   */

  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '33333333-3333-4333-8333-333333333333'
  const USER_ID = '44444444-4444-4444-8444-444444444444'

  let app: FastifyInstance
  let checkAccessCalls: any[]

  before(async () => {
    checkAccessCalls = []
    app = await buildTestApp({
      routes: watchingRoutes,
      ajv: true,
      // -> Minimal stand-in for the real session plugin: enough for `actorFrom` to see a logged-in
      //    user.
      session: { authenticated: true, user: { id: USER_ID }, permissions: [] },
      wiki: {
        models: {
          pages: {
            getPage: async () => ({ id: PAGE_ID, path: 'some/page', locale: 'en', tags: [] })
          },
          pageWatching: {
            watch: async () => {},
            getPreference: async () => ({
              notifyMode: 'digest',
              notifyOnEdited: true,
              notifyOnMoved: true,
              notifyOnDeleted: true
            })
          },
          groups: {
            actorForRequest: () => ({ permissions: [] }),
            groupIdsForRequest: () => [],
            checkAccess: (_actor: any, _permission: string, page: any) => {
              checkAccessCalls.push(page)
              return true
            }
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  test('WATCH: passes the route siteId through to checkAccess', async () => {
    checkAccessCalls = []
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/watch`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(checkAccessCalls.length, 1)
    assert.equal(checkAccessCalls[0].siteId, SITE_ID)
    assert.equal(checkAccessCalls[0].path, 'some/page')
  })
})

describe('page watchers listing (OpenProject #2646)', () => {
  /**
   * `GET /sites/:siteId/pages/:pageId/watchers` — the producer behind the page metadata rail's
   * Watching section. What is asserted here is the ROUTE's own contract, not the model's SQL (that is
   * `models/pageWatching.test.ts`'s DB-backed `listForPage` coverage): that an anonymous caller on a
   * readable page gets the list at all, that an unreadable page answers 404 rather than 403, that the
   * order the model returns survives the response schema, and that `limit` reaches the model from the
   * schema's default rather than from a number the route invented.
   *
   * `schemas` is left at its default `'all'` on purpose — the response `$ref`s `PageWatchers#`, which
   * `$ref`s `Watcher#`, so a schema missing from `registerAllSchemas` fails here rather than only at
   * boot.
   */

  const SITE_ID = '55555555-5555-4555-8555-555555555555'
  const PAGE_ID = '66666666-6666-4666-8666-666666666666'

  const WATCHERS_URL = `/sites/${SITE_ID}/pages/${PAGE_ID}/watchers`

  let app: FastifyInstance
  let session: any
  let readable: boolean
  let locked: boolean
  let listForPageMock: ReturnType<typeof mock.fn>

  before(async () => {
    app = await buildTestApp({
      routes: watchingRoutes,
      ajv: true,
      session: () => session,
      wiki: {
        models: {
          pages: {
            getPage: async () =>
              readable
                ? { id: PAGE_ID, path: 'watched/page', locale: 'en', tags: [], isLocked: locked }
                : null
          },
          groups: {
            actorForRequest: () => ({ groupIds: [], permissions: [] }),
            groupIdsForRequest: () => [],
            checkAccess: () => readable
          },
          pageWatching: {
            listForPage: (...args: any[]) => listForPageMock(...args)
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    // -> Anonymous by default: the rail draws this section for a signed-out reader too, so that is
    //    the baseline every test here runs against rather than one special case at the end.
    session = undefined
    readable = true
    locked = false
    listForPageMock = mock.fn(async () => ({
      watchers: [
        { userId: 'a', name: 'Ada Lovelace', initials: 'AL', watchedAt: new Date(1_000) },
        { userId: 'b', name: 'Grace Hopper', initials: 'GH', watchedAt: new Date(2_000) }
      ],
      total: 7
    }))
  })

  test('an anonymous caller on a readable page gets the watchers and the full total', async () => {
    const res = await app.inject({ method: 'GET', url: WATCHERS_URL })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.total, 7, 'total counts every watcher, not only the two returned')
    assert.deepEqual(
      body.watchers.map((w: any) => w.name),
      ['Ada Lovelace', 'Grace Hopper'],
      'the order the model returned is the order the response carries'
    )
    assert.deepEqual(
      body.watchers.map((w: any) => w.initials),
      ['AL', 'GH']
    )
  })

  test('a caller who cannot read the page gets 404, not 403, and the model is never asked', async () => {
    readable = false

    const res = await app.inject({ method: 'GET', url: WATCHERS_URL })

    // -> `requireReadablePage` answers missing and unreadable identically on purpose: a 403 would
    //    confirm the page exists to somebody who may not see it.
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().message, 'This page does not exist.')
    assert.equal(listForPageMock.mock.calls.length, 0)
  })

  test('a password-protected page the reader has not unlocked is refused', async () => {
    locked = true

    const res = await app.inject({ method: 'GET', url: WATCHERS_URL })

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().message, 'This page is password protected.')
    assert.equal(listForPageMock.mock.calls.length, 0)
  })

  test('limit defaults from the schema rather than from a number the route invented', async () => {
    await app.inject({ method: 'GET', url: WATCHERS_URL })

    assert.deepEqual(listForPageMock.mock.calls[0]?.arguments, [PAGE_ID, { limit: 25 }])
  })

  test('an explicit limit is passed straight through, so the plate cap stays the caller’s', async () => {
    await app.inject({ method: 'GET', url: `${WATCHERS_URL}?limit=3` })

    assert.deepEqual(listForPageMock.mock.calls[0]?.arguments, [PAGE_ID, { limit: 3 }])
  })

  test('limit is bounded: 0 and 500 are both rejected rather than silently clamped', async () => {
    const tooSmall = await app.inject({ method: 'GET', url: `${WATCHERS_URL}?limit=0` })
    const tooLarge = await app.inject({ method: 'GET', url: `${WATCHERS_URL}?limit=500` })

    assert.equal(tooSmall.statusCode, 400)
    assert.equal(tooLarge.statusCode, 400)
    assert.equal(listForPageMock.mock.calls.length, 0)
  })

  test('a signed-in caller is served by the same route, with no account check of its own', async () => {
    session = {
      authenticated: true,
      user: { id: '88888888-8888-4888-8888-888888888888' },
      permissions: []
    }

    const res = await app.inject({ method: 'GET', url: WATCHERS_URL })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().total, 7)
  })
})
