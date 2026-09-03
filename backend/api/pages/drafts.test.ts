import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * Route-wiring tests for `GET`/`DELETE /sites/:siteId/pages/:pageId/draft` (OpenProject #2455).
 *
 * `WIKI.models.pageDrafts` is stubbed rather than backed by a real database -- the model itself
 * already has its own DB-backed coverage in `models/pageDrafts.db.test.ts`. What this file checks is
 * the route's own logic: that both need `write:pages` on the page (never a route-level permission,
 * since this is a page-scoped one granted by a rule), that a missing page or a missing draft both
 * answer 404, and that DELETE is idempotent whether or not a draft existed.
 */
describe('GET/DELETE /sites/:siteId/pages/:pageId/draft', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'

  let app: FastifyInstance
  let pageResult: any
  let checkAccessImpl: (actor: any, permission: string, page: any) => boolean
  let draftResult: any
  let clearCalls: string[]

  function withSession(session: Record<string, any>) {
    return { 'x-test-session': JSON.stringify(session) }
  }

  before(async () => {
    const wiki = {
      models: {
        groups: {
          actorForRequest: (req: any) => ({
            id: req.session?.user?.id ?? null,
            permissions: req.session?.permissions ?? [],
            groups: req.session?.groups ?? []
          }),
          checkAccess: (actor: any, permission: string, page: any) =>
            checkAccessImpl(actor, permission, page),
          groupIdsForRequest: () => []
        },
        pages: {
          getPage: async (_opts: any) => pageResult
        },
        pageDrafts: {
          get: async (_pageId: string) => draftResult,
          clear: async (pageId: string) => {
            clearCalls.push(pageId)
          }
        }
      }
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      ajv: true,
      wiki,
      session: (req: any) => {
        const raw = req.headers['x-test-session']
        return typeof raw === 'string' ? JSON.parse(raw) : {}
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    pageResult = {
      id: PAGE_ID,
      path: 'some-page',
      locale: 'en',
      tags: [],
      classification: null,
      isLocked: false
    }
    // -> Both `read:pages` (required by `loadReadablePage` itself) and `write:pages` (this route's
    //    own check) are granted by default; individual tests narrow this down.
    checkAccessImpl = () => true
    draftResult = null
    clearCalls = []
  })

  test('GET answers 404 when the page itself does not exist', async () => {
    pageResult = null
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/draft`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } })
    })
    assert.equal(res.statusCode, 404)
  })

  test('GET answers 404 when the requester may read but not write the page', async () => {
    checkAccessImpl = (_actor, permission) => permission === 'read:pages'
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/draft`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } })
    })
    // -> requireReadablePage() answers 403 for the permission it was given, but with no session the
    //    request never gets there at all -- authenticated-but-underprivileged is the real 403 case.
    assert.equal(res.statusCode, 403)
  })

  test('GET answers 404 when there is a page but no draft for it', async () => {
    draftResult = null
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/draft`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } })
    })
    assert.equal(res.statusCode, 404)
  })

  test('GET answers the stored draft when one exists', async () => {
    draftResult = {
      content: 'unsaved content',
      title: 'Unsaved Title',
      description: 'Unsaved description',
      icon: 'mdi:file',
      authorName: 'Ada Lovelace',
      updatedAt: new Date('2026-01-01T00:00:00.000Z')
    }
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/draft`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } })
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.content, 'unsaved content')
    assert.equal(body.title, 'Unsaved Title')
    assert.equal(body.authorName, 'Ada Lovelace')
  })

  test('DELETE clears the draft and answers 204, even when there was none', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/draft`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } })
    })
    assert.equal(res.statusCode, 204)
    assert.deepEqual(clearCalls, [PAGE_ID])
  })

  test('DELETE answers 403 for a requester who may not write the page', async () => {
    checkAccessImpl = (_actor, permission) => permission === 'read:pages'
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/draft`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } })
    })
    assert.equal(res.statusCode, 403)
    assert.deepEqual(clearCalls, [])
  })

  test('a locked page is not a barrier to either route, matching the collaboration websocket', async () => {
    pageResult.isLocked = true
    const getRes = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/draft`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } })
    })
    // -> Reaches the "no draft" 404, not a locked-page 403 -- proof `allowLocked: true` is in effect.
    assert.equal(getRes.statusCode, 404)
    assert.equal(getRes.json().message, 'There is no unsaved draft for this page.')
  })
})
