import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { resolvePageRule } from '../../helpers/pageRules.ts'
import { CustomError } from '../../helpers/common.ts'
import type { GroupRule } from '../../models/groups.ts'

/**
 * Route-wiring tests for `GET /sites/:siteId/pages/deleted` and
 * `POST /sites/:siteId/pages/deleted/:versionId/recover`.
 *
 * `WIKI.models.pageHistory` and `WIKI.models.groups` are stubbed rather than backed by a real
 * database — the model layer (listRecoverable, getDeletedVersion, recoverDeletedPage) already has
 * its own coverage from the task that added it. What this file checks is the route's own logic: that
 * the list is filtered per row by `read:history` rather than answered as a whole-list 403, that
 * recovery is checked against the TARGET path (override when given, otherwise the deleted version's
 * own path), and that a `CustomError` thrown by the model (a duplicate path, an invalid locale)
 * reaches the client as clean JSON at its own status code rather than a generic 500.
 *
 * There is no real session plugin here: a request's `session` is set directly from the
 * `x-test-session` header (JSON-encoded), which is all `actorFrom`/`mayOnPage` ever read.
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
    // -> No authorEmail anywhere in the response (OpenProject #2168)
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
    // -> Real rule-matching engine, mirroring the `allowPublic`/`denyConfidential` pair in the
    //    `GET .../pages/alias/:alias` TAG suite above: both TAG, so only the ALLOW-vs-DENY mode
    //    tiebreak decides — reachable only because `tags` is now threaded into `mayOnPage` here.
    const rules: GroupRule[] = [
      {
        id: 'allow-public',
        name: 'Allow public',
        roles: ['read:history'],
        match: 'TAG',
        mode: 'ALLOW',
        path: 'public',
        locales: [],
        sites: []
      },
      {
        id: 'deny-secret',
        name: 'Deny secret',
        roles: ['read:history'],
        match: 'TAG',
        mode: 'DENY',
        path: 'secret',
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
          // -> Tagged BOTH: matches the broad ALLOW too, so this actually exercises the DENY tiebreak
          //    rather than just "no rule matched at all".
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
    // -> The model's own page boundary says there is more (`nextCursor` set) even though every row on
    //    THIS page gets filtered out by the actor's permissions -- the route must not let a
    //    permission-shortened (here, emptied) page read as "end of list".
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
    const original = (globalThis as any).WIKI.models.pageHistory.listRecoverable
    let seenOpts: any
    try {
      ;(globalThis as any).WIKI.models.pageHistory.listRecoverable = async (
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
      ;(globalThis as any).WIKI.models.pageHistory.listRecoverable = original
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
      // -> The source-side read:pages/read:source check (OpenProject #2168) runs first, against
      //    the version's OWN path -- granted here so this test can reach the write:pages check it
      //    actually exercises, against the TARGET path.
      if (permission === 'read:pages' || permission === 'read:source') {
        return true
      }
      if (permission === 'write:pages') {
        seenTargets.push(page)
        return false
      }
      // -> The source-side read:pages/read:source check runs first (OpenProject #2168) -- allowed
      //    here so the write:pages check below is what this test is actually exercising
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
    // -> Holds write:pages everywhere but no read:pages/read:source anywhere -- e.g. a caller who
    //    only ever held `read:history` at this path, per the vulnerability this route-level check
    //    closes (OpenProject #2168).
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
        // -> Denied at the source, regardless of the destination
        return false
      }
      // -> Freely allowed to write the (different) destination -- proves the refusal below is really
      //    about the source, not a blanket deny
      return permission === 'write:pages'
    }

    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/deleted/${VERSION_ID}/recover`,
      headers: withSession({ authenticated: true, user: { id: 'u1' } }),
      payload: { path: 'somewhere-else', locale: 'en' }
    })

    assert.equal(res.statusCode, 403)
    // -> Checked against the version's OWN path/tags/classification, not the override target
    assert.ok(
      seenSourceChecks.some(
        (c) =>
          c.page.path === 'secret-original' &&
          c.page.classification === 'restricted-level-id' &&
          c.permission === 'read:pages'
      )
    )
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
    // -> Without `minLength: 1` here, `locale: ''` would pass validation, get permission-checked
    //   against `target.locale = ''` (locale-scoped rules fail closed on that, same as null -- see
    //   `helpers/pageRules.test.ts`), and then flow into `recoverDeletedPage` -> `createPage`, whose
    //   own `input.locale || defaultLocale(siteId)` treats '' as unset and silently recreates the
    //   page in the site's PRIMARY locale instead -- a different locale than the one just checked.
    //   Rejecting '' outright at the boundary is what keeps the checked locale and the written one
    //   the same value always.
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

/**
 * OpenProject #1859: `GET /sites/:siteId/pages/:pageId/history` is now a thin pass-through onto
 * `pageHistory.list`'s own keyset pagination -- `models/pageHistory.test.ts` covers the pagination and
 * no-`authorEmail` behavior itself against a real database, so this file only proves the route wires
 * the querystring through and shapes the model's error the way every other route here does.
 */
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
    // -> No `email` anywhere on the author, matching `PageHistoryListEntry`'s narrower schema
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

/**
 * OpenProject #1864: `GET /sites/:siteId/pages/deleted`'s per-row `read:history` filter used to call
 * `mayOnPage(req, ...)` once per row, which rebuilds the actor internally on every call. It now
 * hoists `WIKI.models.groups.actorForRequest(req)` once per request and calls `checkAccess(actor,
 * ...)` per row directly -- the same shape `tree.ts`'s `visibleTreeItems()` and the graph route use.
 */
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
