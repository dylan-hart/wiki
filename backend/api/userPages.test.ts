import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import userPagesRoutes from './userPages.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

describe('userPages routes', () => {
  let app: FastifyInstance
  let session: any
  let readable: boolean
  let getPageMock: ReturnType<typeof mock.fn>
  let touchRecentMock: ReturnType<typeof mock.fn>
  let addMock: ReturnType<typeof mock.fn>
  let removeMock: ReturnType<typeof mock.fn>
  let listMock: ReturnType<typeof mock.fn>

  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'
  const USER_ID = '33333333-3333-3333-3333-333333333333'
  const PAGE = { id: PAGE_ID, path: 'some/page', locale: 'en', tags: [] }
  const PAGE_URL = `/sites/${SITE_ID}/pages/${PAGE_ID}`

  before(async () => {
    app = await buildTestApp({
      routes: userPagesRoutes,
      session: () => session,
      wiki: {
        models: {
          pages: {
            getPage: (...args: any[]) => getPageMock(...args)
          },
          groups: {
            actorForRequest: () => ({ groupIds: [], permissions: [] }),
            checkAccess: () => readable,
            groupIdsForRequest: () => []
          },
          userPages: {
            touchRecent: (...args: any[]) => touchRecentMock(...args),
            add: (...args: any[]) => addMock(...args),
            remove: (...args: any[]) => removeMock(...args),
            list: (...args: any[]) => listMock(...args)
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    session = { authenticated: true, user: { id: USER_ID }, permissions: [] }
    readable = true
    getPageMock = mock.fn(async () => PAGE)
    touchRecentMock = mock.fn(async () => {})
    addMock = mock.fn(async () => {})
    removeMock = mock.fn(async () => true)
    listMock = mock.fn(async () => [])
  })

  const WRITES = [
    { name: 'visit', method: 'PUT', url: `${PAGE_URL}/visit` },
    { name: 'favorite', method: 'PUT', url: `${PAGE_URL}/favorite` },
    { name: 'pin', method: 'PUT', url: `${PAGE_URL}/pin` },
    { name: 'unfavorite', method: 'DELETE', url: `${PAGE_URL}/favorite` },
    { name: 'unpin', method: 'DELETE', url: `${PAGE_URL}/pin` }
  ] as const

  function modelCalls() {
    return (
      touchRecentMock.mock.calls.length +
      addMock.mock.calls.length +
      removeMock.mock.calls.length +
      listMock.mock.calls.length
    )
  }

  for (const { name, method, url } of WRITES) {
    test(`${name} answers 401 for a guest and never touches the model`, async () => {
      session = { authenticated: false }

      const res = await app.inject({ method, url })

      assert.equal(res.statusCode, 401)
      assert.equal(modelCalls(), 0)
    })
  }

  test('GET answers 401 for a guest and never touches the model', async () => {
    session = { authenticated: false }

    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/user-pages` })

    assert.equal(res.statusCode, 401)
    assert.equal(modelCalls(), 0)
  })

  for (const { name, method, url } of WRITES.filter((w) => w.method === 'PUT')) {
    test(`${name} answers 404 for a page the caller cannot read`, async () => {
      readable = false

      const res = await app.inject({ method, url })

      assert.equal(res.statusCode, 404)
      assert.equal(modelCalls(), 0)
    })

    test(`${name} answers 404 for a page that does not exist`, async () => {
      getPageMock = mock.fn(async () => null)

      const res = await app.inject({ method, url })

      assert.equal(res.statusCode, 404)
      assert.equal(modelCalls(), 0)
    })
  }

  test('visit records the visit for the caller', async () => {
    const res = await app.inject({ method: 'PUT', url: `${PAGE_URL}/visit` })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })
    assert.deepEqual(touchRecentMock.mock.calls[0]?.arguments[0], {
      siteId: SITE_ID,
      userId: USER_ID,
      pageId: PAGE_ID
    })
  })

  test('favorite is idempotent: repeating it answers 200 both times', async () => {
    const first = await app.inject({ method: 'PUT', url: `${PAGE_URL}/favorite` })
    const second = await app.inject({ method: 'PUT', url: `${PAGE_URL}/favorite` })

    assert.equal(first.statusCode, 200)
    assert.equal(second.statusCode, 200)
    assert.deepEqual(second.json(), { ok: true, isFavorite: true })
    assert.equal(addMock.mock.calls.length, 2)
    assert.deepEqual(addMock.mock.calls[1]?.arguments[0], {
      siteId: SITE_ID,
      userId: USER_ID,
      pageId: PAGE_ID,
      kind: 'favorite'
    })
  })

  test('pin adds a pinned row and answers isPinned', async () => {
    const res = await app.inject({ method: 'PUT', url: `${PAGE_URL}/pin` })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true, isPinned: true })
    assert.deepEqual(addMock.mock.calls[0]?.arguments[0], {
      siteId: SITE_ID,
      userId: USER_ID,
      pageId: PAGE_ID,
      kind: 'pinned'
    })
  })

  test('DELETE removes without loading the page, and answers 200 when nothing was there', async () => {
    readable = false
    removeMock = mock.fn(async () => false)

    const fav = await app.inject({ method: 'DELETE', url: `${PAGE_URL}/favorite` })
    const pin = await app.inject({ method: 'DELETE', url: `${PAGE_URL}/pin` })

    assert.equal(fav.statusCode, 200)
    assert.deepEqual(fav.json(), { ok: true, isFavorite: false })
    assert.equal(pin.statusCode, 200)
    assert.deepEqual(pin.json(), { ok: true, isPinned: false })
    assert.equal(getPageMock.mock.calls.length, 0)
    assert.deepEqual(
      removeMock.mock.calls.map((c) => c.arguments[0]),
      [
        { userId: USER_ID, pageId: PAGE_ID, kind: 'favorite' },
        { userId: USER_ID, pageId: PAGE_ID, kind: 'pinned' }
      ]
    )
  })

  test('GET returns the three lists, each asked for its own kind', async () => {
    const entry = (kind: string, position: number | null) => ({
      pageId: PAGE_ID,
      path: 'some/page',
      locale: 'en',
      title: 'Some page',
      description: null,
      icon: null,
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      kind,
      position,
      touchedAt: new Date('2026-09-02T00:00:00Z')
    })
    listMock = mock.fn(async ({ kind }: { kind: string }) => [
      entry(kind, kind === 'pinned' ? 0 : null)
    ])

    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/user-pages` })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.deepEqual(Object.keys(body).sort(), ['favorites', 'pinned', 'recent'])
    assert.equal(body.recent[0].kind, 'recent')
    assert.equal(body.favorites[0].kind, 'favorite')
    assert.equal(body.pinned[0].kind, 'pinned')
    assert.equal(body.pinned[0].position, 0)
    assert.equal(body.recent[0].position, null)
    assert.equal(body.recent[0].touchedAt, '2026-09-02T00:00:00.000Z')
    assert.deepEqual(
      listMock.mock.calls.map((c) => c.arguments[0]),
      [
        { siteId: SITE_ID, userId: USER_ID, kind: 'recent' },
        { siteId: SITE_ID, userId: USER_ID, kind: 'favorite' },
        { siteId: SITE_ID, userId: USER_ID, kind: 'pinned' }
      ]
    )
  })
})
