import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { resolvePageRule } from '../../helpers/pageRules.ts'
import { CustomError } from '../../helpers/common.ts'
import type { GroupRule } from '../../models/groups.ts'

/**
 * Every suite here stubs `CARDINAL.models`: `models/pageHistory.test.ts` covers the model against a
 * real database, so this file checks only the routes' own logic.
 */
describe('GET/POST /sites/:siteId/pages/deleted — recoverable-page routes', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const VERSION_ID = '22222222-2222-2222-2222-222222222222'

  let app: FastifyInstance
  let listRecoverableResult: { items: any[]; nextCursor: string | null }
  let getDeletedVersionResult: any
  let recoverDeletedPageImpl: (...args: any[]) => Promise<any>
  let checkAccessImpl: (actor: any, permission: string, page: any) => boolean

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
        pageHistory: {
          listRecoverable: async (_siteId: string, _opts?: any) => listRecoverableResult,
          getDeletedVersion: async (_siteId: string, _versionId: string) => getDeletedVersionResult,
          recoverDeletedPage: async (...args: any[]) => recoverDeletedPageImpl(...args)
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
    listRecoverableResult = { items: [], nextCursor: null }
    getDeletedVersionResult = null
    checkAccessImpl = () => false
    recoverDeletedPageImpl = async () => {
      throw new Error('recoverDeletedPage should not be called in this test')
    }
  })

  test('GET /sites/:siteId/pages/deleted only includes rows the actor may read the history of', async () => {
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'visible',
          locale: 'en',
          title: 'Visible',
          action: 'deleted',
          tags: [],
          classification: null,
          author: { id: 'u1', name: 'Author One' }
        },
        {
          id: 'v2',
          path: 'hidden',
          locale: 'en',
          title: 'Hidden',
          action: 'deleted',
          tags: [],
          classification: null,
          author: { id: 'u2', name: 'Author Two' }
        }
      ],
      nextCursor: null
    }
    checkAccessImpl = (_actor, permission, page) =>
      permission === 'read:history' && page.path === 'visible'

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].path, 'visible')
    assert.equal(body.nextCursor, null)
    assert.equal(body.items[0].author.email, undefined)
    assert.ok(!JSON.stringify(body).includes('email'))
  })

  test("GET /sites/:siteId/pages/deleted checks read:history with the version's own tags/classification (OpenProject #2168)", async () => {
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'classified',
          locale: 'en',
          title: 'Classified',
          action: 'deleted',
          tags: ['secret'],
          classification: 'restricted-level-id',
          author: { id: 'u1', name: 'Author One' }
        }
      ],
      nextCursor: null
    }
    const seenChecks: any[] = []
    checkAccessImpl = (_actor, permission, page) => {
      if (permission === 'read:history') {
        seenChecks.push(page)
      }
      return false
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().items.length, 0)
    assert.deepEqual(seenChecks, [
      {
        path: 'classified',
        locale: 'en',
        tags: ['secret'],
        classification: 'restricted-level-id',
        siteId: SITE_ID
      }
    ])
  })

  test('GET /sites/:siteId/pages/deleted never carries authorEmail, even for a row the actor may read', async () => {
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'visible',
          locale: 'en',
          title: 'Visible',
          action: 'deleted',
          author: { id: 'u2', name: 'Someone' },
          tags: [],
          classification: null
        }
      ],
      nextCursor: null
    }
    checkAccessImpl = () => true

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].author.email, undefined)
  })

  test('GET /sites/:siteId/pages/deleted narrows by a TAG-scoped DENY rule', async () => {
    const rules: GroupRule[] = [
      {
        id: 'allow-public',
        name: 'Allow public',
        roles: ['read:history'],
        match: 'TAG',
        mode: 'ALLOW',
        path: '',
        tags: ['public'],
        locales: [],
        sites: []
      },
      {
        id: 'deny-secret',
        name: 'Deny secret',
        roles: ['read:history'],
        match: 'TAG',
        mode: 'DENY',
        path: '',
        tags: ['secret'],
        locales: [],
        sites: []
      }
    ]
    checkAccessImpl = (_actor, permission, page) => {
      const rule = resolvePageRule(rules, permission, {
        path: page.path,
        locale: page.locale,
        siteId: SITE_ID,
        classification: page.classification ?? null,
        tags: page.tags ?? []
      })
      return rule ? rule.mode !== 'DENY' : false
    }
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'open',
          locale: 'en',
          title: 'Open',
          action: 'deleted',
          tags: ['public']
        },
        {
          id: 'v2',
          path: 'closed',
          locale: 'en',
          title: 'Closed',
          action: 'deleted',
          // -> Tagged BOTH, so the ALLOW-vs-DENY tiebreak decides rather than "no rule matched"
          tags: ['public', 'secret']
        }
      ],
      nextCursor: null
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].path, 'open')
  })

  test('GET /sites/:siteId/pages/deleted forwards nextCursor unchanged even when the permission filter shortens items', async () => {
    // -> A page the permission filter empties must not read as "end of list"
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'hidden',
          locale: 'en',
          title: 'Hidden',
          action: 'deleted',
          tags: [],
          classification: null,
          author: { id: 'u1', name: 'Author One' }
        }
      ],
      nextCursor: 'opaque-cursor-token'
    }
    checkAccessImpl = () => false

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.deepEqual(body.items, [])
    assert.equal(body.nextCursor, 'opaque-cursor-token')
  })

  test('GET /sites/:siteId/pages/deleted forwards limit and cursor query params to the model', async () => {
    const original = (globalThis as any).CARDINAL.models.pageHistory.listRecoverable
    let seenOpts: any
    try {
      ;(globalThis as any).CARDINAL.models.pageHistory.listRecoverable = async (
        _siteId: string,
        opts: any
      ) => {
        seenOpts = opts
        return { items: [], nextCursor: null }
      }
      checkAccessImpl = () => true

      const res = await app.inject({
        method: 'GET',
        url: `/sites/${SITE_ID}/pages/deleted?limit=10&cursor=abc123`
      })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(seenOpts, { limit: 10, cursor: 'abc123' })
    } finally {
      ;(globalThis as any).CARDINAL.models.pageHistory.listRecoverable = original
    }
  })

  test('POST recover requires a logged in user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({}),
      payload: {}
    })

    assert.equal(res.statusCode, 401)
  })

  test('POST recover answers 404 for an id that names no deleted version', async () => {
    getDeletedVersionResult = null

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 404)
  })

  test('POST recover checks write:pages against the target path, not the original', async () => {
    getDeletedVersionResult = {
      path: 'original',
      locale: 'en',
      title: 'T',
      content: 'c',
      meta: {},
      tags: [],
      classification: null
    }
    const seenTargets: any[] = []
    checkAccessImpl = (_actor, permission, page) => {
      // -> The source-side read check runs first: granted so the request reaches the write:pages
      //    check this test exercises
      if (permission === 'read:pages' || permission === 'read:source') {
        return true
      }
      if (permission === 'write:pages') {
        seenTargets.push(page)
        return false
      }
      return permission === 'read:pages' || permission === 'read:source'
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: { path: 'overridden', locale: 'fr' }
    })

    assert.equal(res.statusCode, 403)
    assert.deepEqual(seenTargets, [
      { path: 'overridden', locale: 'fr', classification: null, siteId: SITE_ID }
    ])
  })

  test('POST recover refuses when the caller cannot read the deleted path, even though they can write the destination (OpenProject #2168)', async () => {
    getDeletedVersionResult = {
      path: 'secret-original',
      locale: 'en',
      title: 'T',
      content: 'c',
      meta: {},
      tags: ['confidential'],
      classification: 'restricted-level-id'
    }
    // -> Otherwise recovering into a writable path would disclose source the caller cannot read
    checkAccessImpl = (_actor, permission) => permission === 'write:pages'

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 403)
    const body = res.json()
    assert.match(body.message, /not allowed to read/)
  })

  test('POST recover checks read:pages/read:source against the SOURCE path even when the target is overridden', async () => {
    getDeletedVersionResult = {
      path: 'secret-original',
      locale: 'en',
      title: 'T',
      content: 'c',
      meta: { tags: ['confidential'], classification: 'restricted-level-id' },
      tags: ['confidential'],
      classification: 'restricted-level-id'
    }
    const seenSourceChecks: any[] = []
    checkAccessImpl = (_actor, permission, page) => {
      if (permission === 'read:pages' || permission === 'read:source') {
        seenSourceChecks.push({ permission, page })
        return false
      }
      // -> The destination is writable, so the 403 can only come from the source check
      return permission === 'write:pages'
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: { path: 'somewhere-else', locale: 'en' }
    })

    assert.equal(res.statusCode, 403)
    assert.ok(
      seenSourceChecks.some(
        (c) =>
          c.page.path === 'secret-original' &&
          c.page.classification === 'restricted-level-id' &&
          c.permission === 'read:pages'
      )
    )
  })

  test('POST recover refuses when the source is readable but none of read:source/write:pages/manage:pages is held there', async () => {
    getDeletedVersionResult = {
      path: 'original',
      locale: 'en',
      title: 'T',
      content: 'c',
      meta: {},
      tags: [],
      classification: null
    }
    checkAccessImpl = (_actor, permission) => permission === 'read:pages'

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /not allowed to read/)
  })

  test('POST recover succeeds when the caller can read the deleted path and write the destination', async () => {
    getDeletedVersionResult = {
      path: 'original',
      locale: 'en',
      title: 'T',
      content: 'c',
      meta: {},
      tags: [],
      classification: null
    }
    checkAccessImpl = () => true
    recoverDeletedPageImpl = async () => ({ id: 'p1', path: 'original', locale: 'en', title: 'T' })

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
  })

  // -> `read:pages` is required separately from `mayReadSource()`, so the stub grants it too
  test('POST recover succeeds reading the source with write:pages alone, with no read:source', async () => {
    getDeletedVersionResult = {
      path: 'original',
      locale: 'en',
      title: 'T',
      content: 'c',
      meta: {},
      tags: [],
      classification: null
    }
    checkAccessImpl = (_actor, permission) =>
      permission === 'read:pages' || permission === 'write:pages'
    recoverDeletedPageImpl = async () => ({ id: 'p1', path: 'original', locale: 'en', title: 'T' })

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
  })

  test('GET /sites/:siteId/pages/deleted carries no authorEmail on any row (OpenProject #2168)', async () => {
    listRecoverableResult = {
      items: [
        {
          id: 'v1',
          path: 'visible',
          locale: 'en',
          title: 'Visible',
          action: 'deleted',
          tags: [],
          classification: null,
          author: { id: 'u1', name: 'Someone' }
        }
      ],
      nextCursor: null
    }
    checkAccessImpl = () => true

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/deleted`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].author.email, undefined)
    assert.equal('authorEmail' in body.items[0], false)
  })

  test('POST recover recreates the page and returns it', async () => {
    getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
    checkAccessImpl = () => true
    let calledWith: any[] = []
    recoverDeletedPageImpl = async (...args: any[]) => {
      calledWith = args
      return { id: 'p1', path: 'original', locale: 'en', title: 'T' }
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.page.path, 'original')
    assert.equal(calledWith[0], SITE_ID)
    assert.equal(calledWith[1], VERSION_ID)
    assert.equal(calledWith[2].id, 'u1')
  })

  test('POST recover surfaces a duplicate-path conflict as 409 JSON, not a 500', async () => {
    getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
    checkAccessImpl = () => true
    recoverDeletedPageImpl = async () => {
      throw new CustomError('pageDuplicatePath', 'A page already exists at this path.', 409)
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: {}
    })

    assert.equal(res.statusCode, 409)
    const body = res.json()
    assert.equal(body.error, 'pageDuplicatePath')
    assert.equal(body.statusCode, 409)
  })

  test('POST recover surfaces an invalid-locale rejection as 400 JSON, not a 500', async () => {
    getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
    checkAccessImpl = () => true
    recoverDeletedPageImpl = async () => {
      throw new CustomError('pageInvalidLocale', 'This locale does not exist for this site.', 400)
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: { locale: 'zz' }
    })

    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.equal(body.error, 'pageInvalidLocale')
    assert.equal(body.statusCode, 400)
  })

  test('POST recover rejects an empty-string locale at the schema, before it can reach the handler (OpenProject #1024)', async () => {
    // -> `locale: ''` would be permission-checked as '' but written by `createPage` in the site's
    //    default locale ('' reads as unset there), so the checked locale and the written one differ
    getDeletedVersionResult = { path: 'original', locale: 'en', title: 'T', content: 'c', meta: {} }
    checkAccessImpl = () => true
    recoverDeletedPageImpl = async () => {
      throw new Error('recoverDeletedPage should not be called for a schema-invalid body')
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: { locale: '' }
    })

    assert.equal(res.statusCode, 400)
  })
})

describe('GET /sites/:siteId/pages/:pageId/history — querystring wiring', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'

  let app: FastifyInstance
  let getPageResult: any
  let listCalledWith: any[]
  let listImpl: (...args: any[]) => Promise<any>

  before(async () => {
    const wiki = {
      models: {
        pages: {
          getPage: async () => getPageResult
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true,
          groupIdsForRequest: () => []
        },
        pageHistory: {
          list: async (...args: any[]) => {
            listCalledWith = args
            return listImpl(...args)
          }
        }
      }
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      ajv: true,
      wiki
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    getPageResult = { id: PAGE_ID, path: 'some-page', locale: 'en', isLocked: false }
    listCalledWith = []
    listImpl = async () => ({ items: [], nextCursor: null })
  })

  test('forwards limit and cursor from the querystring to the model, and returns its shape verbatim', async () => {
    listImpl = async () => ({
      items: [
        {
          id: 'v1',
          action: 'updated',
          via: 'editor',
          changedFields: [],
          reason: '',
          versionDate: '2026-01-01T00:00:00.000Z',
          locale: 'en',
          path: 'some-page',
          title: 'Some Page',
          author: { id: 'u1', name: 'Ada' }
        }
      ],
      nextCursor: 'opaque-cursor-token'
    })

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history?limit=10&cursor=abc`
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(listCalledWith, [SITE_ID, PAGE_ID, { limit: 10, cursor: 'abc' }])
    const body = res.json()
    assert.equal(body.nextCursor, 'opaque-cursor-token')
    assert.equal(body.items.length, 1)
    assert.equal('email' in body.items[0].author, false)
  })

  test('omitting the querystring applies the schema default (50) for limit, and no cursor', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history`
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(listCalledWith, [SITE_ID, PAGE_ID, { limit: 50, cursor: undefined }])
  })

  test('surfaces an invalid-cursor rejection from the model as 400 JSON, not a 500', async () => {
    listImpl = async () => {
      throw new CustomError('pageHistoryInvalidCursor', 'This history cursor is not valid.', 400)
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history?cursor=not-valid`
    })

    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.equal(body.error, 'pageHistoryInvalidCursor')
  })

  test('404s for a page the actor cannot read, without ever reaching pageHistory.list', async () => {
    getPageResult = null
    listImpl = async () => {
      throw new Error('list should not be called when the page is unreadable')
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history`
    })

    assert.equal(res.statusCode, 404)
  })

  test('403s for a password-locked page, without ever reaching pageHistory.list', async () => {
    getPageResult = { id: PAGE_ID, path: 'some-page', locale: 'en', isLocked: true }
    listImpl = async () => {
      throw new Error('list should not be called for a locked page')
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history`
    })

    assert.equal(res.statusCode, 403)
  })

  test('rejects a limit outside [1, 200] at the schema, before it can reach the handler', async () => {
    listImpl = async () => {
      throw new Error('list should not be called for a schema-invalid limit')
    }

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/history?limit=201`
    })

    assert.equal(res.statusCode, 400)
  })
})

describe('GET /sites/:siteId/pages/deleted — actor hoisted out of the per-row filter (OpenProject #1864)', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'

  function makeRow(path: string) {
    return {
      id: path,
      action: 'deleted',
      via: 'editor',
      changedFields: [],
      reason: '',
      versionDate: new Date('2026-01-01T00:00:00.000Z'),
      locale: 'en',
      path,
      title: path,
      tags: [],
      classification: null,
      author: { id: 'user-1', name: 'Alice' }
    }
  }

  let app: FastifyInstance
  let actorForRequest: ReturnType<typeof mock.fn>
  let checkAccess: ReturnType<typeof mock.fn>

  before(async () => {
    actorForRequest = mock.fn(() => ({ groupIds: [], permissions: [] }))
    checkAccess = mock.fn(
      (_actor: unknown, _permission: string, page: { path: string }) => page.path !== 'secret'
    )
    const wiki = {
      sites: {},
      models: {
        pageHistory: {
          listRecoverable: async () => ({
            items: [makeRow('open-a'), makeRow('secret'), makeRow('open-b')],
            nextCursor: null
          })
        },
        groups: {
          actorForRequest,
          checkAccess
        }
      }
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      wiki
    })
  })

  after(() => closeTestApp(app))

  test('filters out a row checkAccess refuses, keeping the rest', async () => {
    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/pages/deleted` })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(
      res
        .json()
        .items.map((row: { path: string }) => row.path)
        .sort(),
      ['open-a', 'open-b']
    )
  })

  test('builds the actor exactly once per request, not once per row', async () => {
    actorForRequest.mock.resetCalls()
    checkAccess.mock.resetCalls()

    await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/pages/deleted` })

    assert.equal(actorForRequest.mock.calls.length, 1)
    assert.equal(checkAccess.mock.calls.length, 3)
    const actor = actorForRequest.mock.calls[0]!.result
    for (const call of checkAccess.mock.calls) {
      assert.equal(call.arguments[0], actor)
    }
  })
})
