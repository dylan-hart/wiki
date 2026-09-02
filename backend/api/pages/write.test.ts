import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import pagesRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { resolvePageRule, type RulePageRef } from '../../helpers/pageRules.ts'
import { CustomError } from '../../helpers/common.ts'
import type { GroupRule } from '../../models/groups.ts'

/**
 * OpenProject #1720: once `models/pages.ts#createPage()`/`updatePage()` refuse a render-less write up
 * front via `ensureCanRender()` (#1716), the two named errors it throws --
 * `renderUnsupportedEditor`/`renderPuppeteerMissing` -- must reach a REST caller as an actionable
 * `@fastify/sensible` error (400/503 with a message naming the cause), not an opaque 500. `WIKI.models
 * .pages.createPage`/`updatePage` are stubbed to throw directly, standing in for a render-less write
 * against a lean/non-markdown-unsupported instance without needing a real Puppeteer-less environment.
 */
describe('pages API — renderPuppeteerMissing / renderUnsupportedEditor mapped to actionable errors', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'

  let app: FastifyInstance
  let createPageCalls: any[]
  let updatePageCalls: any[]
  let createPageImpl: (...args: any[]) => Promise<any>
  let updatePageImpl: (...args: any[]) => Promise<any>

  function currentPage() {
    return {
      id: PAGE_ID,
      path: 'some-page',
      locale: 'en',
      tags: [],
      classification: null,
      editor: 'markdown'
    }
  }

  before(async () => {
    const wiki = {
      models: {
        pages: {
          getPage: async () => currentPage(),
          createPage: async (...args: any[]) => {
            createPageCalls.push(args)
            return createPageImpl(...args)
          },
          updatePage: async (...args: any[]) => {
            updatePageCalls.push(args)
            return updatePageImpl(...args)
          }
        },
        groups: {
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true,
          groupIdsForRequest: () => []
        }
      },
      sites: {}
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      wiki,
      session: { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    createPageCalls = []
    updatePageCalls = []
  })

  test('CREATE page: renderPuppeteerMissing maps to 503 naming the missing extension, and no page is returned', async () => {
    createPageImpl = async () => {
      throw new CustomError(
        'renderPuppeteerMissing',
        'Rendering a page on the server needs the Puppeteer extension, which is not installed.',
        503
      )
    }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages`,
      payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
    })
    assert.equal(res.statusCode, 503)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.match(body.message, /Puppeteer extension/)
    assert.equal(body.page, undefined)
    assert.equal(createPageCalls.length, 1)
  })

  test('CREATE page: renderUnsupportedEditor maps to 400 naming the editor', async () => {
    createPageImpl = async () => {
      throw new CustomError(
        'renderUnsupportedEditor',
        'Server-side rendering is not implemented for the ckeditor editor.'
      )
    }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages`,
      payload: { path: 'test-page', title: 'Test', editor: 'ckeditor', content: 'hello' }
    })
    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.match(body.message, /ckeditor/)
    assert.equal(body.page, undefined)
    assert.equal(createPageCalls.length, 1)
  })

  test('CREATE page: an unrelated model error still falls through to the generic 500, not swallowed as a render refusal', async () => {
    createPageImpl = async () => {
      throw new Error('Something else entirely broke.')
    }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages`,
      payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
    })
    assert.equal(res.statusCode, 500)
    assert.equal(createPageCalls.length, 1)
  })

  test('UPDATE page: renderPuppeteerMissing maps to 503 naming the missing extension, and the page is left unmodified', async () => {
    updatePageImpl = async () => {
      throw new CustomError(
        'renderPuppeteerMissing',
        'Rendering a page on the server needs the Puppeteer extension, which is not installed.',
        503
      )
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      payload: { content: 'new content, no render' }
    })
    assert.equal(res.statusCode, 503)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.match(body.message, /Puppeteer extension/)
    assert.equal(body.page, undefined)
    assert.equal(updatePageCalls.length, 1)
  })

  test('UPDATE page: renderUnsupportedEditor maps to 400 naming the editor', async () => {
    updatePageImpl = async () => {
      throw new CustomError(
        'renderUnsupportedEditor',
        'Server-side rendering is not implemented for the ckeditor editor.'
      )
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`,
      payload: { content: 'new content, no render' }
    })
    assert.equal(res.statusCode, 400)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.match(body.message, /ckeditor/)
    assert.equal(body.page, undefined)
    assert.equal(updatePageCalls.length, 1)
  })
})

/**
 * Route-level test for `PUT /sites/:siteId/pages/:pageId/path` — the destination permission check.
 *
 * `movePage` can now change a page's locale as well as its path, which makes where a page is going a
 * different place, in page-rule terms, from where it is: rules are matched on path AND locale, so the
 * source check alone would let a caller who may manage `en` push a page into a locale somebody else's
 * rules govern. The handler checks `manage:pages` against the page as it stands, and `write:pages`
 * against the destination ref — not `manage:pages` again: the group editor's own hint for
 * `manage:pages` promises "other locations the user has WRITE ACCESS to", and `write:pages` is the
 * same destination check `POST .../deleted/:versionId/recover` already makes (OpenProject #937).
 *
 * `checkAccess` is wired to the real `resolvePageRule` rather than a canned answer, so what passes
 * here is the actual rule-matching engine seeing the destination ref, not a stub agreeing it was
 * called.
 */
describe('PUT /sites/:siteId/pages/:pageId/path — destination permission', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'

  /**
   * Manage AND write anything in `en`, and nothing anywhere else — the rule the destination check
   * exists for. Both roles are needed: `manage:pages` for the source-page check, `write:pages` for
   * the destination check the same rule also has to satisfy in these "moving within `en`" cases.
   */
  const manageEnglish: GroupRule = {
    id: 'manage-en',
    name: 'Manage English',
    roles: ['manage:pages', 'write:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: ['en'],
    sites: []
  }

  const realCheckAccess = (_actor: unknown, permission: string, page: RulePageRef) => {
    const rule = resolvePageRule([manageEnglish], permission, page)
    return rule ? rule.mode !== 'DENY' : false
  }

  let app: FastifyInstance
  let movePageCalls: any[] = []

  before(async () => {
    const wiki = {
      sites: { [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'fr'] } } } },
      models: {
        pages: {
          getPage: async () => ({
            id: PAGE_ID,
            path: 'docs/source',
            hash: 'hash-1',
            locale: 'en',
            title: 'Source',
            tags: []
          }),
          movePage: async (siteId: string, id: string, patch: any) => {
            movePageCalls.push({ siteId, id, patch })
            return {
              id,
              path: patch.path,
              locale: patch.locale ?? 'en',
              title: 'Source',
              hash: 'hash-2'
            }
          }
        },
        groups: {
          actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
          groupIdsForRequest: () => ['g1'],
          checkAccess: realCheckAccess
        }
      }
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      ajv: true,
      wiki,
      session: { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    movePageCalls = []
    ;(globalThis as any).WIKI.models.groups.checkAccess = realCheckAccess
  })

  test('a move within the locale the caller manages is allowed, and carries no locale', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/destination' }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(movePageCalls.length, 1)
    assert.equal(movePageCalls[0].patch.path, 'docs/destination')
    assert.equal(movePageCalls[0].patch.locale, undefined)
  })

  test('a move into a locale the caller does not manage is refused, before the model is asked', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/source', locale: 'fr' }
    })

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().message, 'You are not allowed to move this page there.')
    assert.equal(movePageCalls.length, 0)
  })

  test('the requested locale reaches the model when the caller may manage the destination', async () => {
    ;(globalThis as any).WIKI.models.groups.checkAccess = () => true

    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/source', locale: 'fr' }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(movePageCalls.length, 1)
    assert.equal(movePageCalls[0].patch.locale, 'fr')
    assert.equal(res.json().page.locale, 'fr')
  })

  test('managing the destination branch is not enough on its own: write:pages there is also required (OpenProject #937)', async () => {
    // -> A caller who may MANAGE (move things around within) `fr`, but was never granted WRITE access
    //    there, is exactly the gap #937 found: `manage:pages` on a destination branch used to be
    //    treated as sufficient to land a page in it, when the group editor's own copy for
    //    `manage:pages` promises only "locations the user has write access to".
    const manageFrenchOnly: GroupRule = {
      id: 'manage-fr-no-write',
      name: 'Manage (not write) French',
      roles: ['manage:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: ['fr'],
      sites: []
    }
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      actor: unknown,
      permission: string,
      page: RulePageRef
    ) => {
      const rule = resolvePageRule([manageEnglish, manageFrenchOnly], permission, page)
      return rule ? rule.mode !== 'DENY' : false
    }

    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/source', locale: 'fr' }
    })

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().message, 'You are not allowed to move this page there.')
    assert.equal(movePageCalls.length, 0)
  })
})

/**
 * Route-level test for `PUT /sites/:siteId/pages/:pageId/path`'s `includeTranslations` gate
 * (OpenProject #1026, spec item 3): the batch needs `manage:pages` on each twin's own path AND
 * `write:pages` on the shared destination for EVERY twin, not just the primary page -- checked here,
 * before the model is asked to do anything, so a caller who may manage `en` cannot drag a `de`
 * translation they have no rule over along for the ride. The destination check is `write:pages`, not
 * `manage:pages`, for the same reason the primary move's destination check is (OpenProject #937).
 */
describe('PUT /sites/:siteId/pages/:pageId/path — includeTranslations permission gate', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'
  const FR_ID = '33333333-3333-4333-8333-333333333333'
  const DE_ID = '44444444-4444-4444-8444-444444444444'

  /**
   * Manage AND write `en` and `fr`, nothing else -- `de` is deliberately left ungoverned. Both roles
   * are needed on the same rule here since every twin's own path and the shared destination all fall
   * within `en`/`fr` in these fixtures.
   */
  const manageEnAndFr: GroupRule = {
    id: 'manage-en-fr',
    name: 'Manage EN+FR',
    roles: ['manage:pages', 'write:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: ['en', 'fr'],
    sites: []
  }

  const realCheckAccess = (_actor: unknown, permission: string, page: RulePageRef) => {
    const rule = resolvePageRule([manageEnAndFr], permission, page)
    return rule ? rule.mode !== 'DENY' : false
  }

  let app: FastifyInstance
  let movePageCalls: any[] = []
  let translations: Array<{
    id: string
    path: string
    locale: string
    title: string
    tags: string[]
  }>

  before(async () => {
    const wiki = {
      sites: { [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'fr', 'de'] } } } },
      models: {
        pages: {
          getPage: async () => ({
            id: PAGE_ID,
            path: 'docs/source',
            hash: 'hash-1',
            locale: 'en',
            title: 'Source',
            tags: []
          }),
          getTranslations: async () => translations,
          movePage: async (siteId: string, id: string, patch: any) => {
            movePageCalls.push({ siteId, id, patch })
            return {
              id,
              path: patch.path,
              locale: patch.locale ?? 'en',
              title: 'Source',
              hash: 'hash-2'
            }
          }
        },
        groups: {
          actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
          groupIdsForRequest: () => ['g1'],
          checkAccess: realCheckAccess
        }
      }
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      ajv: true,
      wiki,
      session: { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    movePageCalls = []
    translations = []
    ;(globalThis as any).WIKI.models.groups.checkAccess = realCheckAccess
  })

  test('no twins: includeTranslations reaches the model with nothing to permission-check', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/destination', includeTranslations: true }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(movePageCalls.length, 1)
    assert.equal(movePageCalls[0].patch.includeTranslations, true)
  })

  test('every twin permitted: the batch reaches the model', async () => {
    translations = [{ id: FR_ID, path: 'docs/source', locale: 'fr', title: 'Source FR', tags: [] }]
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/destination', includeTranslations: true }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(movePageCalls.length, 1)
  })

  test('a twin whose destination the caller may manage but not write to refuses the whole batch (OpenProject #937)', async () => {
    // -> `en` keeps a full manage+write rule (the primary page's own path AND its destination both
    //    sit in `en`); `fr` is scoped to manage-only, on its own -- unlike `manageEnAndFr` above,
    //    this rule set gives the FR twin's OWN path `manage:pages` but grants `write:pages` nowhere
    //    in `fr`, so the twin may be moved away from `docs/source` but not written into the shared
    //    destination. That gap is exactly what #937 closes.
    const manageWriteEn: GroupRule = {
      id: 'manage-write-en',
      name: 'Manage+write English',
      roles: ['manage:pages', 'write:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: ['en'],
      sites: []
    }
    const manageOnlyFr: GroupRule = {
      id: 'manage-only-fr',
      name: 'Manage (not write) French',
      roles: ['manage:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: ['fr'],
      sites: []
    }
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      actor: unknown,
      permission: string,
      page: RulePageRef
    ) => {
      const rule = resolvePageRule([manageWriteEn, manageOnlyFr], permission, page)
      return rule ? rule.mode !== 'DENY' : false
    }
    translations = [{ id: FR_ID, path: 'docs/source', locale: 'fr', title: 'Source FR', tags: [] }]

    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/destination', includeTranslations: true }
    })

    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /"fr"/)
    assert.equal(movePageCalls.length, 0)
  })

  test('a twin outside every rule refuses the whole batch, naming its locale, before the model is asked', async () => {
    translations = [
      { id: FR_ID, path: 'docs/source', locale: 'fr', title: 'Source FR', tags: [] },
      { id: DE_ID, path: 'docs/source', locale: 'de', title: 'Source DE', tags: [] }
    ]
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/destination', includeTranslations: true }
    })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /"de"/)
    assert.equal(movePageCalls.length, 0)
  })

  test('includeTranslations is ignored on a locale-only move: getTranslations is never consulted', async () => {
    let getTranslationsCalled = false
    ;(globalThis as any).WIKI.models.pages.getTranslations = async () => {
      getTranslationsCalled = true
      return []
    }
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/path`,
      payload: { path: 'docs/source', title: 'Retitled', includeTranslations: true }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(getTranslationsCalled, false)
  })
})

/**
 * `POST /sites/:siteId/pages/bulk` (OpenProject #1882): the admin page inventory's bulk
 * delete/re-render/retag action. The behavior this proves is the thing that distinguishes it from
 * `POST …/classification-conflicts/resolve` elsewhere in this file -- that route refuses the WHOLE
 * request on the first page the caller may not act on; this one reports that one page as `skipped`
 * and keeps going, since a bulk action starts from an arbitrary admin-picked selection rather than a
 * conflict list the caller already knows they may act on.
 */
describe('POST /sites/:siteId/pages/bulk', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ALLOWED = '22222222-2222-4222-8222-222222222222'
  const PAGE_DENIED = '33333333-3333-4333-8333-333333333333'
  const PAGE_UNSAFE_RENDER = '44444444-4444-4444-8444-444444444444'

  let app: FastifyInstance
  let pageRows: Map<
    string,
    { id: string; path: string; locale: string; tags: string[]; classification: string }
  >
  let deleteCalls: string[]
  let renderCalls: string[]
  let updateCalls: { id: string; patch: any }[]
  let deniedIds: Set<string>

  function withSession(session: Record<string, any>) {
    return { 'x-test-session': JSON.stringify(session) }
  }

  before(async () => {
    const wiki = {
      config: { port: 3000 },
      models: {
        rateLimits: {
          consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
        },
        groups: {
          actorForRequest: (req: any) => ({
            id: req.session?.user?.id ?? null,
            permissions: req.session?.permissions ?? [],
            groups: req.session?.groups ?? []
          }),
          // -> Denies exactly the page ids this test session put in `deniedIds` -- everything else
          //    passes, whatever permission is actually being asked for.
          checkAccess: (_actor: any, _permission: string, page: any) => !deniedIds.has(page.id),
          groupIdsForRequest: () => []
        },
        pages: {
          getPagesByIds: async (_siteId: string, ids: string[]) => {
            const out = new Map()
            for (const id of ids) {
              if (pageRows.has(id)) {
                out.set(id, pageRows.get(id))
              }
            }
            return out
          },
          deletePage: async (_siteId: string, id: string) => {
            deleteCalls.push(id)
            return true
          },
          queueRerender: async (_siteId: string, id: string) => {
            renderCalls.push(id)
            if (id === PAGE_UNSAFE_RENDER) {
              throw new Error('This editor cannot be rendered.')
            }
            return true
          },
          updatePage: async (_siteId: string, id: string, patch: any) => {
            updateCalls.push({ id, patch })
            return { id, ...patch }
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
    deleteCalls = []
    renderCalls = []
    updateCalls = []
    deniedIds = new Set()
    pageRows = new Map([
      [
        PAGE_ALLOWED,
        {
          id: PAGE_ALLOWED,
          path: 'docs/allowed',
          locale: 'en',
          tags: ['a', 'b'],
          classification: ''
        }
      ],
      [
        PAGE_DENIED,
        { id: PAGE_DENIED, path: 'docs/denied', locale: 'en', tags: [], classification: '' }
      ],
      [
        PAGE_UNSAFE_RENDER,
        { id: PAGE_UNSAFE_RENDER, path: 'docs/unsafe', locale: 'en', tags: [], classification: '' }
      ]
    ])
  })

  const AUTHED = withSession({ authenticated: true, user: { id: 'u1' }, permissions: [] })

  test('401 for an anonymous request, before touching any page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      payload: { pageIds: [PAGE_ALLOWED], action: 'delete' }
    })
    assert.equal(res.statusCode, 401)
    assert.equal(deleteCalls.length, 0)
  })

  test('a mixed selection deletes the allowed page and reports the denied one skipped, not a batch failure', async () => {
    deniedIds = new Set([PAGE_DENIED])
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: { pageIds: [PAGE_ALLOWED, PAGE_DENIED], action: 'delete' }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.deepEqual(deleteCalls, [PAGE_ALLOWED])
    const byId = Object.fromEntries(body.results.map((r: any) => [r.id, r]))
    assert.equal(byId[PAGE_ALLOWED].status, 'done')
    assert.equal(byId[PAGE_DENIED].status, 'skipped')
    assert.equal(byId[PAGE_DENIED].path, 'docs/denied')
    assert.deepEqual(body.counts, { done: 1, skipped: 1 })
  })

  test('an id that does not exist on this site comes back notFound, not an error', async () => {
    const missing = '99999999-9999-4999-8999-999999999999'
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: { pageIds: [missing], action: 'delete' }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.results[0].status, 'notFound')
    assert.equal(body.counts.notFound, 1)
  })

  test('a page that throws while rendering is reported as error, and the rest of the batch still runs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: { pageIds: [PAGE_UNSAFE_RENDER, PAGE_ALLOWED], action: 'render' }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.deepEqual(renderCalls, [PAGE_UNSAFE_RENDER, PAGE_ALLOWED])
    const byId = Object.fromEntries(body.results.map((r: any) => [r.id, r]))
    assert.equal(byId[PAGE_UNSAFE_RENDER].status, 'error')
    assert.match(byId[PAGE_UNSAFE_RENDER].message, /cannot be rendered/)
    assert.equal(byId[PAGE_ALLOWED].status, 'done')
  })

  test('retag adds and removes tags relative to each page’s own existing tags', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: {
        pageIds: [PAGE_ALLOWED],
        action: 'retag',
        addTags: ['c'],
        removeTags: ['a']
      }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updateCalls.length, 1)
    assert.deepEqual(new Set(updateCalls[0].patch.tags), new Set(['b', 'c']))
  })

  test('400 when retag is called with neither addTags nor removeTags', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: { pageIds: [PAGE_ALLOWED], action: 'retag' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(updateCalls.length, 0)
  })

  test('a repeated id in the selection is only acted on once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/bulk`,
      headers: AUTHED,
      payload: { pageIds: [PAGE_ALLOWED, PAGE_ALLOWED], action: 'delete' }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(deleteCalls, [PAGE_ALLOWED])
    assert.equal(res.json().results.length, 1)
  })
})
