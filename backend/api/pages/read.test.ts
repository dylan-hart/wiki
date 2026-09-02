import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import pagesRoutes from './index.ts'
import { installTestWiki } from '../../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { resolvePageRule, type RulePageRef } from '../../helpers/pageRules.ts'
import type { GroupRule } from '../../models/groups.ts'

/**
 * Task 601: `GET /sites/:siteId/pages/:pageIdOrHash` — the page-read route — must carry a real
 * `commentsCount` alongside `allowComments`, so the frontend's dead `commentsCount` store field
 * (`frontend/src/stores/page.js`) has something to hold once a page is fetched.
 *
 * Only that route is exercised here. The other handlers touching the `Page#` response schema
 * (create/update/unlock) are unaffected by this task and are left alone, matching the task's own
 * scope note.
 */
describe('GET /sites/:siteId/pages/:pageIdOrHash — commentsCount', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'

  /** Minimal stand-in for what `WIKI.models.pages.getPage` hands back — nothing the route inspects. */
  function makeFakePage(overrides: Record<string, unknown> = {}) {
    return {
      id: PAGE_ID,
      path: 'some-page',
      hash: 'abc123',
      locale: 'en',
      title: 'Some Page',
      allowComments: true,
      allowContributions: true,
      tags: [],
      ...overrides
    }
  }

  let countForPageCalls: string[] = []
  let countForPageResult = 0

  let wikiHandle: { restore(): void }

  function stubWiki() {
    countForPageCalls = []
    wikiHandle = installTestWiki({
      models: {
        pages: {
          getPage: async () => makeFakePage()
        },
        groups: {
          // -> Grants every check, so the route reaches the response body under test
          actorForRequest: () => ({ permissions: [] }),
          checkAccess: () => true,
          groupIdsForRequest: () => []
        },
        approvals: {
          pageViewerState: async () => ({
            canSuggestEdits: false,
            hasOpenSuggestion: false,
            canReview: false,
            pendingSubmissions: []
          })
        },
        pageWatching: {
          isWatching: async () => false
        },
        comments: {
          countForPage: async (pageId: string) => {
            countForPageCalls.push(pageId)
            return countForPageResult
          }
        }
      }
    })
  }

  let app: FastifyInstance

  before(async () => {
    // -> No `wiki` here: `stubWiki()` installs a fresh one per test, and this app has to run
    //    against whichever is current.
    app = await buildTestApp({ routes: pagesRoutes })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    stubWiki()
  })

  afterEach(() => {
    wikiHandle.restore()
  })

  it('includes commentsCount from the comments model in the response', async () => {
    countForPageResult = 4
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.commentsCount, 4)
    assert.equal(body.allowComments, true)
    assert.deepEqual(countForPageCalls, [PAGE_ID])
  })

  it('reflects a page with no comments as zero, not absent', async () => {
    countForPageResult = 0
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.commentsCount, 0)
    assert.ok(Object.hasOwn(body, 'commentsCount'))
  })
})

/**
 * Task 602 regression coverage for `pages.ts`, the file this task's TDD change actually lands in:
 *
 * 1. `relations` and `toc` used to be `{ type: 'object', additionalProperties: true }` — accurate to
 *    nothing in particular. Both have exactly one producer (`PageRelationDialog.vue` for relations,
 *    `rendering.ts`'s `anchorHeadings`/`nestHeadings` for toc) with a fixed shape, so they are now
 *    `PageRelation#` / `PageTocNode#`. The first block below proves the tightened schema is not just
 *    documentation: fast-json-stringify silently drops a field the schema doesn't declare, so a
 *    response carrying one is proof the schema is actually narrower than before.
 * 2. `GET /sites/:siteId/pages/:pageIdOrHash` can reply 403 and 404 (`mayOnPage` / `getPage` returning
 *    null) but declared neither. The second block proves both are now declared AND that what the
 *    handler actually sends on those paths validates against the declared `ApiError` schema.
 */
describe('pages API — response schema completeness (task 602)', () => {
  const samplePage = {
    id: '11111111-1111-1111-1111-111111111111',
    path: 'foo',
    hash: 'abc123',
    alias: null,
    title: 'Foo',
    description: null,
    icon: null,
    locale: 'en',
    editor: 'markdown',
    contentType: 'text',
    publishState: 'published',
    publishStartDate: null,
    publishEndDate: null,
    isBrowsable: true,
    isSearchable: true,
    isLocked: false,
    relations: [
      {
        id: 'r1',
        position: 'left',
        label: 'Next',
        icon: 'la:arrow-left',
        target: '/bar',
        // -> Not part of `PageRelation`'s declared properties: proves the schema is enforced, not
        //    merely descriptive, since it must NOT survive serialization.
        bogusField: 'should be stripped'
      }
    ],
    tags: [],
    toc: [
      {
        key: 'h-intro',
        label: 'Intro',
        level: 1,
        children: []
      }
    ],
    render: '<p>hi</p>',
    allowComments: true,
    allowContributions: true,
    showSidebar: true,
    showTags: true,
    showToc: true,
    tocDepth: { min: 1, max: 2 },
    navigationId: null,
    navigationMode: 'default',
    authorId: '22222222-2222-2222-2222-222222222222',
    authorName: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z'
  }

  let app: FastifyInstance
  let mayOnPageResult = true
  let getPageResult: any = samplePage

  before(async () => {
    const wiki = {
      models: {
        pages: {
          getPage: async () => getPageResult
        },
        groups: {
          actorForRequest: () => ({ groupIds: [], permissions: [] }),
          checkAccess: () => mayOnPageResult,
          groupIdsForRequest: () => []
        },
        approvals: {
          pageViewerState: async () => ({
            canSuggestEdits: false,
            hasOpenSuggestion: false,
            canReview: false,
            pendingSubmissions: []
          })
        },
        pageWatching: {
          isWatching: async () => false
        },
        comments: {
          countForPage: async () => 0
        }
      },
      sites: {}
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      swagger: true,
      wiki
    })
  })

  after(() => closeTestApp(app))

  /** Follows a `$ref` (however `@fastify/swagger` named the component) to the schema it points at. */
  function resolveRef(doc: any, schema: any): any {
    if (!schema?.$ref) return schema
    const name = schema.$ref.replace('#/components/schemas/', '')
    return doc.components.schemas[name]
  }

  test('Page relations and toc are no longer bare additionalProperties blobs', () => {
    const doc: any = app.swagger()
    const pageSchema = resolveRef(
      doc,
      doc.paths['/sites/{siteId}/pages/{pageIdOrHash}'].get.responses['200'].content[
        'application/json'
      ].schema
    )

    const relation = resolveRef(doc, pageSchema.properties.relations.items)
    assert.deepEqual(Object.keys(relation.properties).sort(), [
      'caption',
      'icon',
      'id',
      'label',
      'position',
      'target'
    ])
    assert.notEqual(relation.additionalProperties, true)

    const tocNode = resolveRef(doc, pageSchema.properties.toc.items)
    assert.deepEqual(Object.keys(tocNode.properties).sort(), ['children', 'key', 'label', 'level'])
    assert.notEqual(tocNode.additionalProperties, true)
  })

  test('GET single page declares its 403 and 404 responses', () => {
    const doc: any = app.swagger()
    const responses = doc.paths['/sites/{siteId}/pages/{pageIdOrHash}'].get.responses
    assert.ok(responses['403'], '403 must be declared: mayOnPage can refuse')
    assert.ok(responses['404'], '404 must be declared: getPage can return null')
  })

  test('a bogus field on a relation is stripped by the tightened schema', async () => {
    mayOnPageResult = true
    getPageResult = samplePage
    const res = await app.inject({
      method: 'GET',
      url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.relations[0].bogusField, undefined)
    assert.equal(body.relations[0].id, 'r1')
    assert.deepEqual(body.toc[0], { key: 'h-intro', label: 'Intro', level: 1, children: [] })
  })

  /**
   * OpenProject #2232: `pages.password` now stores a one-way `bcrypt` verifier, and the point of
   * that is defeated if the API still hands the value back to whoever may edit the page. The `Page`
   * response schema has no `password` property any more — only `hasPassword` — so even a model that
   * (bug, or a future regression re-adding the field) put a raw `password` on the object would be
   * stripped by response serialization before it ever reached a client. This proves the whole path.
   */
  test('GET single page never returns a password field, even if the model handed one back', async () => {
    mayOnPageResult = true
    getPageResult = { ...samplePage, password: 'should-never-be-sent', hasPassword: true }
    const res = await app.inject({
      method: 'GET',
      url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.password, undefined)
    assert.equal(body.hasPassword, true)
  })

  test('GET single page: 404 when the page does not exist, matching ApiError', async () => {
    getPageResult = null
    const res = await app.inject({
      method: 'GET',
      url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
    })
    assert.equal(res.statusCode, 404)
    const body = res.json()
    assert.equal(body.ok, false)
    assert.equal(typeof body.message, 'string')
  })

  test('GET single page: 403 when mayOnPage refuses', async () => {
    getPageResult = samplePage
    mayOnPageResult = false
    const res = await app.inject({
      method: 'GET',
      url: '/sites/33333333-3333-3333-3333-333333333333/pages/abc123'
    })
    assert.equal(res.statusCode, 403)
    const body = res.json()
    assert.equal(body.ok, false)
    mayOnPageResult = true
  })
})

/**
 * Regression test for `GET /_api/sites/:siteId/pages/:pageIdOrHash`'s `withContent=true` path:
 * `PAGE_PERMISSIONS` in `pages.ts` declares `read:source`, but only `read:pages` was ever checked
 * before returning the raw `content` field — so a reader granted `read:pages` but not `read:source`
 * (a group that may see a page but not its markdown, e.g. one meant only to browse the rendered
 * result) could pull the source anyway by asking for `withContent=true`. Fixed by checking
 * `read:source` too, but only when content was actually requested — the plain page view (`render`
 * only) needs no more than `read:pages`, exactly as before.
 *
 * `WIKI.models.groups.actorForRequest` / `checkAccess` are stubbed to a minimal permission set
 * carried on the test session (`testPagePermissions`) rather than pulling in the real page-rules
 * resolver — this is a route-wiring test, not a `helpers/pageRules.ts` test (see
 * `helpers/pageRules.test.ts` for that). `WIKI.models.pages.getPage` is stubbed to hand back
 * `content` exactly when asked, mirroring the real model's `withContent` contract, so the test
 * would fail the same way the bug did if the route stopped checking `read:source`.
 */
describe('GET /sites/:siteId/pages/:pageIdOrHash — withContent requires read:source', () => {
  const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const AUTHOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const PAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const PAGE_HASH = 'deadbeef'
  const RENDER_HTML = '<p>Hello</p>'
  const RAW_CONTENT = '# Hello'

  async function getPage({ withContent }: { withContent?: boolean }) {
    return {
      id: PAGE_ID,
      path: 'foo',
      hash: PAGE_HASH,
      alias: null,
      title: 'Foo',
      description: null,
      icon: null,
      locale: 'en',
      editor: 'markdown',
      contentType: 'markdown',
      publishState: 'published',
      publishStartDate: null,
      publishEndDate: null,
      isBrowsable: true,
      isSearchable: true,
      isLocked: false,
      relations: [],
      tags: [],
      toc: [],
      render: RENDER_HTML,
      ...(withContent ? { content: RAW_CONTENT } : {}),
      allowComments: false,
      allowContributions: false,
      showSidebar: true,
      showTags: true,
      showToc: true,
      tocDepth: { min: 1, max: 2 },
      navigationId: null,
      navigationMode: 'default',
      authorId: AUTHOR_ID,
      authorName: 'Test Author',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  }

  function actorForRequest(req: any) {
    const session = req.session as unknown as { testPagePermissions?: string[] } | undefined
    // -> `permissions` (empty here) is the GLOBAL list `pagePermissionsFor`'s `manage:system` bypass
    //    reads; `pagePermissions` is this test's stand-in for what a group's RULES would grant.
    return { permissions: [] as string[], pagePermissions: session?.testPagePermissions ?? [] }
  }

  function checkAccess(
    actor: { permissions: string[]; pagePermissions: string[] },
    permission: string
  ): boolean {
    return actor.pagePermissions.includes(permission)
  }

  let app: FastifyInstance

  before(async () => {
    const wiki = {
      // -> `recordPageview()`'s isEnabled gate (OpenProject #2251) reads this; on, matching this
      //    fixture's pre-existing unconditional pageview stub, since pageviews are not what this
      //    describe block is testing.
      config: { pageviews: { isEnabled: true } },
      models: {
        pages: { getPage },
        groups: { actorForRequest, checkAccess, groupIdsForRequest: () => [] },
        approvals: {
          pageViewerState: async () => ({
            canSuggestEdits: false,
            hasOpenSuggestion: false,
            canReview: false,
            pendingSubmissions: []
          })
        },
        pageWatching: { isWatching: async () => false },
        comments: { countForPage: async () => 0 },
        // -> The route's best-effort pageview logging (OpenProject #1238) -- a no-op stub, since
        //    this suite is about the read:source gate, not pageviews.
        pageviews: { record: async () => {} }
      },
      sites: {}
    }

    app = await buildTestApp({
      routes: pagesRoutes,
      ajv: true,
      wiki,
      session: 'header'
    })
  })

  after(() => closeTestApp(app))

  function sessionHeader(pagePermissions: string[]) {
    return {
      'x-test-session': JSON.stringify({
        authenticated: true,
        user: { id: 'reader-1' },
        permissions: [],
        groups: [],
        testPagePermissions: pagePermissions
      })
    }
  }

  test('read:pages alone renders the page without withContent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`,
      headers: sessionHeader(['read:pages'])
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.render, RENDER_HTML)
    assert.equal(body.content, undefined)
  })

  test('read:pages without read:source is forbidden from withContent=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}?withContent=true`,
      headers: sessionHeader(['read:pages'])
    })
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().content, undefined)
  })

  test('read:pages plus read:source is allowed withContent=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}?withContent=true`,
      headers: sessionHeader(['read:pages', 'read:source'])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().content, RAW_CONTENT)
  })

  test('no read:pages at all is forbidden regardless of withContent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`,
      headers: sessionHeader([])
    })
    assert.equal(res.statusCode, 403)
  })
})

/**
 * Regression test for OpenProject #2251: `recordPageview()` in `pages.ts` used to write
 * `req.session.pageViewed = true` for every anonymous browser read unconditionally -- deliberately,
 * to defeat `saveUninitialized: false` so a returning anonymous reader is not miscounted as new --
 * *before* calling `WIKI.models.pageviews.record()`, whose own `isEnabled` guard lives in
 * `models/pageviews.ts`. That meant disabling pageview tracking still minted a session (and the
 * `Set-Cookie` + permanent `sessions` row that comes with it) for every anonymous page read; only the
 * `pageviews` insert itself stopped.
 *
 * This suite has no real `@fastify/session` plugin registered (see the other describes' own doc
 * comments for why), so it cannot observe an actual `Set-Cookie` header. What it CAN observe -- and
 * what is the exact mechanism that decides whether `@fastify/session` would emit one -- is whether
 * the route touches the session object at all: a session `@fastify/session` never sees written to
 * stays uninitialized and is never persisted or cookied. The `onRequest` hook below always attaches
 * an empty `session` object up front, mirroring what the real plugin lazily provides to every
 * request (including an anonymous one) before any handler runs.
 */
describe('GET /sites/:siteId/pages/:pageIdOrHash — pageview session write respects isEnabled (OpenProject #2251)', () => {
  const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const PAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const PAGE_HASH = 'deadbeef'

  async function getPage() {
    return {
      id: PAGE_ID,
      path: 'foo',
      hash: PAGE_HASH,
      alias: null,
      title: 'Foo',
      description: null,
      icon: null,
      locale: 'en',
      editor: 'markdown',
      contentType: 'markdown',
      publishState: 'published',
      publishStartDate: null,
      publishEndDate: null,
      isBrowsable: true,
      isSearchable: true,
      isLocked: false,
      relations: [],
      tags: [],
      toc: [],
      render: '<p>Hello</p>',
      allowComments: false,
      allowContributions: false,
      showSidebar: true,
      showTags: true,
      showToc: true,
      tocDepth: { min: 1, max: 2 },
      navigationId: null,
      navigationMode: 'default',
      authorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      authorName: 'Test Author',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  }

  // -> Every anonymous reader is granted `read:pages` -- what is under test here is the pageview
  //    session write, not page-rule resolution (covered by `helpers/pageRules.test.ts`).
  function actorForRequest() {
    return { permissions: [] as string[], pagePermissions: ['read:pages'] }
  }

  function checkAccess(
    actor: { permissions: string[]; pagePermissions: string[] },
    permission: string
  ): boolean {
    return actor.pagePermissions.includes(permission)
  }

  let app: FastifyInstance
  let recordMock: ReturnType<typeof mock.fn>
  let capturedSession: { pageViewed?: boolean } | undefined

  beforeEach(async () => {
    recordMock = mock.fn(async () => {})
    capturedSession = undefined
    const wiki = {
      config: { pageviews: { isEnabled: false } },
      models: {
        pages: { getPage },
        groups: { actorForRequest, checkAccess, groupIdsForRequest: () => [] },
        approvals: {
          pageViewerState: async () => ({
            canSuggestEdits: false,
            hasOpenSuggestion: false,
            canReview: false,
            pendingSubmissions: []
          })
        },
        pageWatching: { isWatching: async () => false },
        comments: { countForPage: async () => 0 },
        pageviews: { record: recordMock }
      },
      sites: {}
    }

    const wrappedRoutes: FastifyPluginAsync = async (instance) => {
      // -> Captured post-handler so the test can assert on the exact object the route wrote to,
      //    without needing a real `@fastify/session` plugin to serialize/cookie it.
      instance.addHook('onResponse', async (req: any) => {
        capturedSession = req.session
      })
      await instance.register(pagesRoutes)
    }

    app = await buildTestApp({
      routes: wrappedRoutes,
      ajv: true,
      wiki,
      session: {}
    })
  })

  afterEach(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('pageviews disabled: anonymous read never writes to the session and never records', async () => {
    ;(globalThis as any).WIKI.config.pageviews.isEnabled = false
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(capturedSession?.pageViewed, undefined)
    assert.equal(recordMock.mock.callCount(), 0)
  })

  test('pageviews enabled: anonymous read writes pageViewed onto the session and records', async () => {
    ;(globalThis as any).WIKI.config.pageviews.isEnabled = true
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(capturedSession?.pageViewed, true)
    assert.equal(recordMock.mock.callCount(), 1)
  })
})

/**
 * Regression test for `GET .../pages/alias/:alias` (feature 357, task 446).
 *
 * `Pages.getPathFromAlias()` used to select only `{ id, path }`, so this route's
 * `mayOnPage(req, 'read:pages', { path: target.path })` never saw a locale or any tags — a
 * locale- or tag-scoped page rule could never be evaluated for a page reached through its alias,
 * only a path-based one, silently. Fixed by selecting `locale`/`tags` too (`models/pages.ts`) and
 * threading both through into the `mayOnPage` call (`api/pages.ts`).
 *
 * `WIKI.models.groups.checkAccess` is wired to the real `resolvePageRule` from `helpers/pageRules.ts`
 * rather than a canned true/false, so a passing test here proves the actual rule-matching mechanism
 * sees the tags this route now passes through — not just that some stub was called with the right
 * shape. `WIKI.models.pages.getPathFromAlias` is stubbed to stand in for the (separately, DB-backed,
 * tested in `models/pages.test.ts`) fixed model method.
 */
describe('GET /sites/:siteId/pages/alias/:alias — locale/tags reach the page rule (task 446)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  // -> Tagged both 'public' (generally readable) and 'confidential' (specifically restricted), so the
  //    two rules below only disagree because of the tags this route now passes through.
  const ALIAS_TARGET = {
    id: 'page-1',
    path: 'engineering/roadmap',
    locale: 'en',
    tags: ['public', 'confidential']
  }

  let app: FastifyInstance
  let rules: GroupRule[]

  /** Grants read access to anything tagged 'public' — the baseline, page-context-independent ALLOW. */
  const allowPublic: GroupRule = {
    id: 'allow-public',
    name: 'Allow public',
    roles: ['read:pages'],
    match: 'TAG',
    mode: 'ALLOW',
    path: 'public',
    locales: [],
    sites: []
  }

  /** Same specificity and match type as `allowPublic` (both TAG), so only the mode tiebreak decides. */
  const denyConfidential: GroupRule = {
    id: 'deny-confidential',
    name: 'Deny confidential',
    roles: ['read:pages'],
    match: 'TAG',
    mode: 'DENY',
    path: 'confidential',
    locales: [],
    sites: []
  }

  before(async () => {
    const wiki = {
      models: {
        pages: {
          getPathFromAlias: async () => ALIAS_TARGET
        },
        groups: {
          actorForRequest: () => ({ groupIds: ['fixture-group'], permissions: [] }),
          // -> The real rule-matching engine, not a stub answer — see file header.
          checkAccess: (_actor: unknown, permission: string, page: RulePageRef) => {
            const rule = resolvePageRule(rules, permission, page)
            return rule ? rule.mode !== 'DENY' : false
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
    rules = []
  })

  test('an alias-resolved read is allowed when only a TAG rule grants it', async () => {
    // -> Baseline: with no DENY in play, the tags the route now passes through are what let this
    //    TAG-scoped ALLOW rule fire at all (it cannot match without them).
    rules = [allowPublic]

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/alias/roadmap-alias`
    })

    assert.equal(res.statusCode, 200)
    // -> The response schema publishes `id`/`path`/`locale` — `tags` is for the permission check
    //    only and is not part of the wire response.
    assert.deepEqual(res.json(), { id: 'page-1', path: 'engineering/roadmap', locale: 'en' })
  })

  test('a TAG-scoped DENY rule is honored on an alias-resolved read', async () => {
    // -> Both rules match this page (tagged 'public' AND 'confidential'); equal specificity and match
    //    type means the DENY wins the tiebreak. Reachable only because the route now threads
    //    `target.tags` into `mayOnPage` — before the fix, neither TAG rule could ever match at all,
    //    since `page.tags` was always empty.
    rules = [allowPublic, denyConfidential]

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/alias/roadmap-alias`
    })

    // -> Resolving an alias the caller may not read answers 404, identically to an alias that does
    //    not exist at all — see the route's own comment.
    assert.equal(res.statusCode, 404)
  })
})

/**
 * Route-level test for `GET /sites/:siteId/pages/:pageId/translations` (OpenProject #1026): the
 * query the move/rename dialog uses to decide whether to offer `includeTranslations` at all, and
 * how many. Gated on `manage:pages` on the page -- the same permission actually moving it needs.
 */
describe('GET /sites/:siteId/pages/:pageId/translations', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  const PAGE_ID = '22222222-2222-4222-8222-222222222222'

  let app: FastifyInstance
  let mayOnPageResult = true

  before(async () => {
    const wiki = {
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
          getTranslations: async () => [
            { id: 'fr-id', locale: 'fr', path: 'docs/source', title: 'Source FR' }
          ]
        },
        groups: {
          actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
          checkAccess: () => mayOnPageResult
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
    mayOnPageResult = true
  })

  test('returns the twins as a flat list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/translations`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [
      { id: 'fr-id', locale: 'fr', path: 'docs/source', title: 'Source FR' }
    ])
  })

  test('403 when the caller may not manage this page', async () => {
    mayOnPageResult = false
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/translations`
    })
    assert.equal(res.statusCode, 403)
  })
})

/**
 * Regression test for bug #949 / task 995: `POST .../pages/userPermissions` used to default the
 * ref's locale to the site primary unconditionally (task 4's interim), so a caller asking about a
 * path in a non-primary locale got the PRIMARY locale's rule answer instead of the real one — rules
 * now fail closed on locale (`RulePageRef` requires it), so the wrong locale silently returns the
 * wrong permissions rather than erroring. The body now takes an explicit `locale`, which the frontend
 * threads through from the (path, locale) pair `Index.vue`'s route watcher already computed.
 *
 * `WIKI.models.groups.checkAccess` is wired to the real `resolvePageRule`, so a passing test proves
 * the locale in the request body is what reaches the rule engine — not just that some stub saw it.
 */
describe('POST /sites/:siteId/pages/userPermissions — locale (bug #949, task 995)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'

  /** Grants write:pages only in `fr` — the rule the locale param exists to let a caller reach. */
  const writeFrench: GroupRule = {
    id: 'write-fr',
    name: 'Write French',
    roles: ['write:pages'],
    match: 'START',
    mode: 'ALLOW',
    path: '',
    locales: ['fr'],
    sites: []
  }

  let app: FastifyInstance

  before(async () => {
    const wiki = {
      sites: { [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'fr'] } } } },
      models: {
        groups: {
          actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
          checkAccess: (_actor: unknown, permission: string, page: RulePageRef) => {
            const rule = resolvePageRule([writeFrench], permission, page)
            return rule ? rule.mode !== 'DENY' : false
          }
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

  test('an explicit French locale sees the French-scoped grant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/userPermissions`,
      payload: { path: 'x', locale: 'fr' }
    })

    assert.equal(res.statusCode, 200)
    assert.ok(res.json().includes('write:pages'))
  })

  test('an explicit English locale does not see the French-scoped grant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/userPermissions`,
      payload: { path: 'x', locale: 'en' }
    })

    assert.equal(res.statusCode, 200)
    assert.ok(!res.json().includes('write:pages'))
  })

  test('omitting locale falls back to the site primary (en), not the French grant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/userPermissions`,
      payload: { path: 'x' }
    })

    assert.equal(res.statusCode, 200)
    assert.ok(!res.json().includes('write:pages'))
  })
})
