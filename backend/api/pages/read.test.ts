import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import pagesRoutes from './index.ts'
import { installTestWiki } from '../../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { resolvePageRule, type RulePageRef } from '../../helpers/pageRules.ts'
import type { GroupRule } from '../../models/groups.ts'

describe('GET /sites/:siteId/pages/:pageIdOrHash — commentsCount', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'

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
        },
        // -> `checkAccess` grants `read:history` too, so the read reaches the revision summary.
        pageHistory: {
          revisionSummary: async () => ({ ordinal: 1 })
        }
      }
    })
  }

  let app: FastifyInstance

  before(async () => {
    // -> No `wiki` here: `stubWiki()` installs a fresh one per test.
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

  it('answers a read by page id with the current path and locale, which the /i/:id permalink redirects to', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}`
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.id, PAGE_ID)
    assert.equal(body.path, 'some-page')
    assert.equal(body.locale, 'en')
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
        },
        // -> `checkAccess` grants `read:history` too, so the read reaches the revision summary.
        pageHistory: {
          revisionSummary: async () => ({ ordinal: 1 })
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

  // -> The `Page` response schema declares no `password`, so serialization strips it.
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

  /*
    Anonymous: `authenticated: false` makes `actorFrom()` return null, while `testPagePermissions`
    stands in for the guests group's rules, which `mayOnPage()` checks for an anonymous caller.
  */
  function anonymousSessionHeader(pagePermissions: string[]) {
    return {
      'x-test-session': JSON.stringify({
        authenticated: false,
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

  // -> `mayReadSource()` folds `write:pages` in: an editor must be able to read what it edits.
  test('read:pages plus write:pages, with no read:source, is allowed withContent=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}?withContent=true`,
      headers: sessionHeader(['read:pages', 'write:pages'])
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

  test('anonymous with read:pages and read:source (guests) is allowed withContent=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}?withContent=true`,
      headers: anonymousSessionHeader(['read:pages', 'read:source'])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().content, RAW_CONTENT)
  })

  test('anonymous with read:pages but without read:source is forbidden from withContent=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}?withContent=true`,
      headers: anonymousSessionHeader(['read:pages'])
    })
    assert.equal(res.statusCode, 403)
    assert.equal(res.json().content, undefined)
  })
})

/**
 * No real `@fastify/session` is registered, so no `Set-Cookie` can be observed. What decides
 * whether the plugin would mint a session is whether the route writes to the session object at all
 * (an untouched one stays uninitialized under `saveUninitialized: false`), so that is asserted.
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
    delete (globalThis as any).CARDINAL
  })

  test('pageviews disabled: anonymous read never writes to the session and never records', async () => {
    ;(globalThis as any).CARDINAL.config.pageviews.isEnabled = false
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(capturedSession?.pageViewed, undefined)
    assert.equal(recordMock.mock.callCount(), 0)
  })

  test('pageviews enabled: anonymous read writes pageViewed onto the session and records', async () => {
    ;(globalThis as any).CARDINAL.config.pageviews.isEnabled = true
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_HASH}`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(capturedSession?.pageViewed, true)
    assert.equal(recordMock.mock.callCount(), 1)
  })
})

describe('GET /sites/:siteId/pages/alias/:alias — locale/tags reach the page rule (task 446)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'
  // -> Tagged for both rules below, so they disagree only through the tags the route passes on.
  const ALIAS_TARGET = {
    id: 'page-1',
    path: 'engineering/roadmap',
    locale: 'en',
    tags: ['public', 'confidential']
  }

  let app: FastifyInstance
  let rules: GroupRule[]

  const allowPublic: GroupRule = {
    id: 'allow-public',
    name: 'Allow public',
    roles: ['read:pages'],
    match: 'TAG',
    mode: 'ALLOW',
    path: '',
    tags: ['public'],
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
    path: '',
    tags: ['confidential'],
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
          // -> The real rule engine, so a pass proves the route's locale/tags reach rule matching.
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
    rules = [allowPublic]

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/alias/roadmap-alias`
    })

    assert.equal(res.statusCode, 200)
    // -> `tags` feeds the permission check only; the response schema omits it.
    assert.deepEqual(res.json(), { id: 'page-1', path: 'engineering/roadmap', locale: 'en' })
  })

  test('a TAG-scoped DENY rule is honored on an alias-resolved read', async () => {
    rules = [allowPublic, denyConfidential]

    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/alias/roadmap-alias`
    })

    // -> 404, not 403: an unreadable alias is indistinguishable from a missing one.
    assert.equal(res.statusCode, 404)
  })
})

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
 * `checkAccess` is wired to the real `resolvePageRule`, so a pass proves the body's locale is what
 * reaches the rule engine.
 */
describe('POST /sites/:siteId/pages/userPermissions — locale (bug #949, task 995)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'

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
        },
        // -> The route looks the page up for its stored tags; none exists at `x`.
        pages: {
          getPage: async () => null
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

describe('POST /sites/:siteId/pages/userPermissions — tags (OpenProject #3409)', () => {
  const SITE_ID = '11111111-1111-4111-8111-111111111111'

  const readSecretTag: GroupRule = {
    id: 'read-secret-tag',
    name: 'Read Secret Tag',
    roles: ['read:pages'],
    match: 'TAG',
    mode: 'ALLOW',
    path: '',
    tags: ['secret'],
    locales: [],
    sites: []
  }

  let app: FastifyInstance
  let storedPage: { tags: string[]; classification: string | null } | null

  before(async () => {
    const wiki = {
      sites: { [SITE_ID]: { config: { locales: { primary: 'en', active: ['en'] } } } },
      models: {
        groups: {
          actorForRequest: () => ({ id: 'user-1', groupIds: ['g1'], permissions: [] }),
          checkAccess: (_actor: unknown, permission: string, page: RulePageRef) => {
            const rule = resolvePageRule([readSecretTag], permission, page)
            return rule ? rule.mode !== 'DENY' : false
          }
        },
        pages: {
          getPage: async () => storedPage
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

  test('a page carrying the tagged-for rule grants the tag-scoped permission', async () => {
    storedPage = { tags: ['secret'], classification: null }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/userPermissions`,
      payload: { path: 'x', locale: 'en' }
    })
    assert.equal(res.statusCode, 200)
    assert.ok(res.json().includes('read:pages'))
  })

  test('a page not carrying the tag does not grant the tag-scoped permission', async () => {
    storedPage = { tags: [], classification: null }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/userPermissions`,
      payload: { path: 'x', locale: 'en' }
    })
    assert.equal(res.statusCode, 200)
    assert.ok(!res.json().includes('read:pages'))
  })

  test('a tags array posted by the client is ignored -- only the stored page’s own tags decide', async () => {
    storedPage = { tags: [], classification: null }
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/userPermissions`,
      payload: { path: 'x', locale: 'en', tags: ['secret'] }
    })
    assert.equal(res.statusCode, 200)
    assert.ok(!res.json().includes('read:pages'))
  })

  test('a path with no page behind it yet (create-permission check) resolves with no tags, same as before', async () => {
    storedPage = null
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/userPermissions`,
      payload: { path: 'brand-new-page', locale: 'en' }
    })
    assert.equal(res.statusCode, 200)
    assert.ok(!res.json().includes('read:pages'))
  })
})
