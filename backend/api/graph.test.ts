import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import graphRoutes, { assembleGraph, folderOf, GRAPH_NODE_CAP, type GraphPageRow } from './graph.ts'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { groups as groupsTable } from '../db/schema.ts'
import type { GroupRule } from '../models/groups.ts'
import type { PageActor, PageInput } from '../models/pages.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

function makeRow(overrides: Partial<GraphPageRow> = {}): GraphPageRow {
  // -> `id` defaults to `path`, so rows given distinct paths get distinct ids for free.
  const path = overrides.path ?? 'docs/intro'
  return {
    id: path,
    path,
    locale: 'en',
    title: 'Intro',
    icon: null,
    tags: [],
    classification: 'level-public',
    relations: [],
    links: [],
    publishState: 'published',
    ...overrides
  }
}

describe('folderOf', () => {
  test('takes the first path segment', () => {
    assert.equal(folderOf('docs/child/page'), 'docs')
  })

  test('is the whole path for a root-level page', () => {
    assert.equal(folderOf('about'), 'about')
  })

  test('is empty for the home page (path "")', () => {
    assert.equal(folderOf(''), '')
  })
})

describe('assembleGraph', () => {
  test('includes only nodes canRead allows', () => {
    const rows = [makeRow({ path: 'a' }), makeRow({ path: 'b' })]

    const result = assembleGraph(rows, (row) => row.path === 'a')

    assert.deepEqual(
      result.nodes.map((n) => n.path),
      ['a']
    )
  })

  test('derives folder on each node', () => {
    const rows = [makeRow({ path: 'docs/child/page' })]

    const result = assembleGraph(rows, () => true)

    assert.equal(result.nodes[0]!.folder, 'docs')
  })

  test('builds a relation edge between two visible pages, carrying its label', () => {
    const rows = [
      makeRow({
        path: 'a',
        relations: [{ pos: 'left', label: 'See also', caption: '', icon: '', target: 'b' }]
      }),
      makeRow({ path: 'b' })
    ]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.edges, [
      { source: 'en:a', target: 'en:b', type: 'relation', label: 'See also' }
    ])
  })

  test('builds a link edge between two visible pages, unlabeled', () => {
    const rows = [makeRow({ path: 'a', links: ['b'] }), makeRow({ path: 'b' })]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.edges, [{ source: 'en:a', target: 'en:b', type: 'link' }])
  })

  test('keys nodes by the composite locale:path id, so same-path translations stay distinct', () => {
    const rows = [
      makeRow({ path: 'docs/intro', locale: 'en', title: 'Intro' }),
      makeRow({ path: 'docs/intro', locale: 'fr', title: 'Introduction' })
    ]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.nodes.map((n) => n.id).sort(), ['en:docs/intro', 'fr:docs/intro'])
    assert.deepEqual(
      result.nodes.map((n) => n.path),
      ['docs/intro', 'docs/intro']
    )
  })

  test('a link from an en page to a path that only exists in fr produces no edge', () => {
    const rows = [
      makeRow({ path: 'a', locale: 'en', links: ['docs/intro'] }),
      makeRow({ path: 'docs/intro', locale: 'fr' })
    ]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.edges, [])
  })

  test('a relation from an en page to a path that only exists in fr produces no edge', () => {
    const rows = [
      makeRow({
        path: 'a',
        locale: 'en',
        relations: [{ pos: 'left', label: '', caption: '', icon: '', target: 'docs/intro' }]
      }),
      makeRow({ path: 'docs/intro', locale: 'fr' })
    ]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.edges, [])
  })

  test('a link resolves against the same-locale copy of its target path when both locales have one', () => {
    const rows = [
      makeRow({ path: 'a', locale: 'en', links: ['docs/intro'] }),
      makeRow({ path: 'docs/intro', locale: 'en' }),
      makeRow({ path: 'docs/intro', locale: 'fr' })
    ]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.edges, [{ source: 'en:a', target: 'en:docs/intro', type: 'link' }])
  })

  test('drops a relation edge whose target is not readable', () => {
    const rows = [
      makeRow({
        path: 'a',
        relations: [{ pos: 'left', label: '', caption: '', icon: '', target: 'secret' }]
      }),
      makeRow({ path: 'secret' })
    ]

    const result = assembleGraph(rows, (row) => row.path !== 'secret')

    assert.deepEqual(result.edges, [])
  })

  test('drops a link edge whose source page is not readable', () => {
    const rows = [makeRow({ path: 'a', links: ['b'] }), makeRow({ path: 'b' })]

    const result = assembleGraph(rows, (row) => row.path !== 'a')

    assert.deepEqual(result.edges, [])
    assert.deepEqual(
      result.nodes.map((n) => n.path),
      ['b']
    )
  })

  test('gives same-path translations distinct ids, and does not link across locales', () => {
    const rows = [
      makeRow({ id: 'page-en', path: 'docs/intro', locale: 'en', links: ['docs/only-in-fr'] }),
      makeRow({ id: 'page-fr', path: 'docs/intro', locale: 'fr' }),
      makeRow({ id: 'page-fr-2', path: 'docs/only-in-fr', locale: 'fr' })
    ]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(
      result.nodes.map((n) => n.id).sort(),
      ['en:docs/intro', 'fr:docs/intro', 'fr:docs/only-in-fr'].sort()
    )
    assert.equal(new Set(result.nodes.map((n) => n.id)).size, result.nodes.length)
    assert.ok(result.nodes.every((n) => n.path === 'docs/intro' || n.path === 'docs/only-in-fr'))
    // -> The `en` page's link resolves within `en`, where `docs/only-in-fr` does not exist.
    assert.deepEqual(result.edges, [])
  })

  test("canRead sees each row's classification, so a CLASSIFICATION-based DENY can hide it", () => {
    const rows = [
      makeRow({ path: 'open', classification: 'level-public' }),
      makeRow({ path: 'secret', classification: 'level-restricted' })
    ]

    const result = assembleGraph(rows, (row) => row.classification !== 'level-restricted')

    assert.deepEqual(
      result.nodes.map((n) => n.path),
      ['open']
    )
  })

  test("resolves each node's classification id through the classificationName accessor", () => {
    const rows = [makeRow({ path: 'a', classification: 'level-restricted' })]

    const result = assembleGraph(
      rows,
      () => true,
      (id) => (id === 'level-restricted' ? 'Restricted' : null)
    )

    assert.equal(result.nodes[0]!.classification, 'Restricted')
  })

  test('classification id passes through unresolved when no classificationName accessor is given', () => {
    const rows = [makeRow({ path: 'a', classification: 'level-restricted' })]

    const result = assembleGraph(rows, () => true)

    assert.equal(result.nodes[0]!.classification, 'level-restricted')
  })

  test('a classification id with no matching level resolves to null', () => {
    const rows = [makeRow({ path: 'a', classification: 'stale-id' })]

    const result = assembleGraph(
      rows,
      () => true,
      () => null
    )

    assert.equal(result.nodes[0]!.classification, null)
  })

  const ZERO_TOTAL_CONTRIBUTORS = { editor: 0, mcp: 0, all: 0 }

  test("resolves each node's contributor counts through the contributorsFor accessor, keyed by id", () => {
    const rows = [makeRow({ path: 'a', id: 'page-a' }), makeRow({ path: 'b', id: 'page-b' })]
    const pageAContributors = { editor: 3, mcp: 1, all: 4, total: { editor: 5, mcp: 2, all: 7 } }
    const zeroContributors = { editor: 0, mcp: 0, all: 0, total: ZERO_TOTAL_CONTRIBUTORS }

    const result = assembleGraph(
      rows,
      () => true,
      undefined,
      (pageId) => (pageId === 'page-a' ? pageAContributors : zeroContributors)
    )

    assert.deepEqual(result.nodes.find((n) => n.path === 'a')!.contributors, pageAContributors)
    assert.deepEqual(result.nodes.find((n) => n.path === 'b')!.contributors, zeroContributors)
  })

  test('contributors default to all-zero when no contributorsFor accessor is given', () => {
    const rows = [makeRow({ path: 'a' })]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.nodes[0]!.contributors, {
      editor: 0,
      mcp: 0,
      all: 0,
      total: ZERO_TOTAL_CONTRIBUTORS
    })
  })

  const ZERO_TOTAL_PAGEVIEW_WINDOW = { browser: 0, api: 0, mcp: 0, all: 0 }
  const ZERO_PAGEVIEW_WINDOW = {
    browser: 0,
    api: 0,
    mcp: 0,
    all: 0,
    total: ZERO_TOTAL_PAGEVIEW_WINDOW
  }
  const ZERO_PAGEVIEWS = {
    last30d: ZERO_PAGEVIEW_WINDOW,
    last6mo: ZERO_PAGEVIEW_WINDOW,
    last2yr: ZERO_PAGEVIEW_WINDOW
  }

  test("resolves each node's pageview counts through the pageviewsFor accessor, keyed by id", () => {
    const rows = [makeRow({ path: 'a', id: 'page-a' }), makeRow({ path: 'b', id: 'page-b' })]
    const pageAViews = {
      last30d: {
        browser: 5,
        api: 2,
        mcp: 0,
        all: 7,
        total: { browser: 9, api: 3, mcp: 0, all: 12 }
      },
      last6mo: {
        browser: 20,
        api: 8,
        mcp: 1,
        all: 29,
        total: { browser: 40, api: 15, mcp: 2, all: 57 }
      },
      last2yr: {
        browser: 50,
        api: 10,
        mcp: 3,
        all: 63,
        total: { browser: 80, api: 18, mcp: 5, all: 103 }
      }
    }

    const result = assembleGraph(
      rows,
      () => true,
      undefined,
      undefined,
      (pageId) => (pageId === 'page-a' ? pageAViews : ZERO_PAGEVIEWS)
    )

    assert.deepEqual(result.nodes.find((n) => n.path === 'a')!.pageviews, pageAViews)
    assert.deepEqual(result.nodes.find((n) => n.path === 'b')!.pageviews, ZERO_PAGEVIEWS)
  })

  test('pageviews default to all-zero across every window when no pageviewsFor accessor is given', () => {
    const rows = [makeRow({ path: 'a' })]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.nodes[0]!.pageviews, ZERO_PAGEVIEWS)
  })

  describe('includeSizing gate', () => {
    test('omits both contributors and pageviews keys entirely when includeSizing is false', () => {
      const rows = [makeRow({ path: 'a' })]

      const result = assembleGraph(rows, () => true, undefined, undefined, undefined, false)

      assert.equal('contributors' in result.nodes[0]!, false)
      assert.equal('pageviews' in result.nodes[0]!, false)
    })

    test('includes both contributors and pageviews when includeSizing is true, regardless of which sizing mode they came from', () => {
      const rows = [makeRow({ path: 'a', id: 'page-a' })]
      const contributors = { editor: 2, mcp: 0, all: 2, total: { editor: 2, mcp: 0, all: 2 } }
      const pageviews = {
        last30d: {
          browser: 1,
          api: 0,
          mcp: 0,
          all: 1,
          total: { browser: 1, api: 0, mcp: 0, all: 1 }
        },
        last6mo: ZERO_PAGEVIEW_WINDOW,
        last2yr: ZERO_PAGEVIEW_WINDOW
      }

      const result = assembleGraph(
        rows,
        () => true,
        undefined,
        () => contributors,
        () => pageviews,
        true
      )

      assert.deepEqual(result.nodes[0]!.contributors, contributors)
      assert.deepEqual(result.nodes[0]!.pageviews, pageviews)
    })

    test('defaults to including sizing data when includeSizing is not passed at all (backward compatible)', () => {
      const rows = [makeRow({ path: 'a' })]

      const result = assembleGraph(rows, () => true)

      assert.ok('contributors' in result.nodes[0]!)
      assert.ok('pageviews' in result.nodes[0]!)
    })
  })
})

describe('GET /sites/:siteId/graph (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let app: FastifyInstance
  let groupsModel: typeof import('../models/groups.ts').groups
  let pagesModel: typeof import('../models/pages.ts').pages
  let testSession: any = null
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ groups: groupsModel } = await import('../models/groups.ts'))
    ;({ pages: pagesModel } = await import('../models/pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }

    // -> An anonymous request resolves its groups through `systemIds.guestsGroupId`, which
    //    `setupTestDb()` leaves unset. The fixture group stands in as "guests", granted `read:pages`
    //    through a real rule: page-rule checks never consult the `permissions` column.
    CARDINAL.data.systemIds = { guestsGroupId: fixtures.groupId }
    const guestRule: GroupRule = {
      id: 'guest-read-rule',
      name: 'Guest read',
      roles: ['read:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: [],
      sites: []
    }
    await fixtures.db
      .update(groupsTable)
      .set({ rules: [guestRule] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    // -> No `wiki`: `setupTestDb()` already installed the real one.
    app = await buildTestApp({ routes: graphRoutes, session: () => testSession })
  })

  after(async () => {
    await closeTestApp(app)
    await teardownTestDb()
  })

  test('an anonymous caller gets a 401 while the cache is cold, rather than triggering a rebuild', async () => {
    testSession = null
    const res = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/graph` })
    assert.equal(res.statusCode, 401)
  })

  test('a signed-in caller rebuilds a cold cache, and it then serves a later anonymous caller warm', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'graph-warm-cache/page', title: 'Warm Cache', editor: 'markdown', content: 'x' },
      actor
    )

    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      // -> An authenticated session's group ids come straight from `session.groups`, never the
      //    database: without the group `before()` granted `read:pages`, it would see no page.
      groups: [fixtures.groupId],
      permissions: []
    }
    const cold = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/graph` })
    assert.equal(cold.statusCode, 200)
    assert.ok(cold.json().nodes.some((n: any) => n.path === page.path))

    testSession = null
    const warm = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/graph` })
    assert.equal(warm.statusCode, 200)
    assert.ok(warm.json().nodes.some((n: any) => n.path === page.path))
  })

  test('a warm cache answers with no call to any of the three underlying aggregate queries', async (t) => {
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [fixtures.groupId],
      permissions: []
    }
    // -> Warm it first (a cold rebuild has to call all three).
    const warmup = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/graph` })
    assert.equal(warmup.statusCode, 200)

    const listAllForGraph = t.mock.method(pagesModel, 'listAllForGraph')
    const contributorCountsForGraph = t.mock.method(
      CARDINAL.models.pageHistory,
      'contributorCountsForGraph'
    )
    const countsForGraph = t.mock.method(CARDINAL.models.pageviews, 'countsForGraph')

    const res = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/graph` })
    assert.equal(res.statusCode, 200)
    assert.equal(listAllForGraph.mock.calls.length, 0)
    assert.equal(contributorCountsForGraph.mock.calls.length, 0)
    assert.equal(countsForGraph.mock.calls.length, 0)
  })

  test('no pageview aggregate runs, and every node reports all-zero pageviews, while tracking is disabled', async (t) => {
    const previousPageviewsConfig = CARDINAL.config.pageviews
    CARDINAL.config.pageviews = { isEnabled: false }
    CARDINAL.cache.delete(`graph:${fixtures.siteId}`)

    try {
      const page = await pagesModel.createPage(
        fixtures.siteId,
        {
          path: 'graph-pageviews-disabled/page',
          title: 'No Pageviews',
          editor: 'markdown',
          content: 'x'
        },
        actor
      )
      const countsForGraph = t.mock.method(CARDINAL.models.pageviews, 'countsForGraph')

      testSession = {
        authenticated: true,
        user: { id: fixtures.userId },
        groups: [fixtures.groupId],
        permissions: []
      }
      // -> Without `?sizing=` the route omits `pageviews` from every node; this wants it present and
      //    all-zero, not merely absent.
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${fixtures.siteId}/graph?sizing=visits`
      })
      assert.equal(res.statusCode, 200)

      // -> Still called once -- the route calls it unconditionally; its own early return is what
      //    never reaches the database.
      assert.equal(countsForGraph.mock.calls.length, 1)
      const node = res.json().nodes.find((n: any) => n.path === page.path)
      assert.ok(node)
      assert.deepEqual(node.pageviews.last2yr, {
        browser: 0,
        api: 0,
        mcp: 0,
        all: 0,
        total: { browser: 0, api: 0, mcp: 0, all: 0 }
      })
    } finally {
      CARDINAL.config.pageviews = previousPageviewsConfig
    }
  })

  test('a draft page reaches an authenticated warm-cache caller but not a later anonymous one', async () => {
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      groups: [fixtures.groupId],
      permissions: []
    }
    const draft = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'graph-draft-visibility/page',
        title: 'Draft Visibility',
        editor: 'markdown',
        content: 'x',
        publishState: 'draft'
      },
      actor
    )

    const authed = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/graph` })
    assert.equal(authed.statusCode, 200)
    assert.ok(authed.json().nodes.some((n: any) => n.path === draft.path))

    testSession = null
    const anon = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/graph` })
    assert.equal(anon.statusCode, 200)
    assert.ok(!anon.json().nodes.some((n: any) => n.path === draft.path))
  })
})

/**
 * Against a real database because the filter lives in the SQL `WHERE` (`pageIsVisible`), not in
 * application code. `isBrowsable: false` is excluded for every caller -- it is the author saying
 * "not in the tree", not an access rule; only `publishState` is gated by `publicOnly`.
 */
describe('listAllForGraph publication filtering (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('../models/pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    ;({ pages: pagesModel } = await import('../models/pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'default-path',
      title: 'Default Title',
      editor: 'markdown',
      content: '# Hello',
      ...overrides
    }
  }

  test('excludes a draft and an isBrowsable:false page (and edges to them) for an unauthenticated caller; an authenticated caller gets the draft back but isBrowsable:false stays excluded', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'graph-filter/published',
        title: 'Published',
        relations: [
          { pos: 'left', label: 'Draft', caption: '', icon: '', target: 'graph-filter/draft' },
          {
            pos: 'left',
            label: 'Hidden',
            caption: '',
            icon: '',
            target: 'graph-filter/hidden'
          },
          {
            pos: 'left',
            label: 'Also Published',
            caption: '',
            icon: '',
            target: 'graph-filter/also-published'
          }
        ]
      }),
      actor
    )
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'graph-filter/draft',
        title: 'Draft',
        publishState: 'draft'
      }),
      actor
    )
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'graph-filter/hidden',
        title: 'Hidden',
        isBrowsable: false
      }),
      actor
    )
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'graph-filter/also-published',
        title: 'Also Published'
      }),
      actor
    )

    const publicRows = await pagesModel.listAllForGraph(fixtures.siteId, true)
    const publicGraph = assembleGraph(publicRows, () => true)
    const publicPaths = publicGraph.nodes.map((n) => n.path)
    assert.ok(publicPaths.includes('graph-filter/published'))
    assert.ok(publicPaths.includes('graph-filter/also-published'))
    assert.ok(!publicPaths.includes('graph-filter/draft'))
    assert.ok(!publicPaths.includes('graph-filter/hidden'))
    assert.deepEqual(publicGraph.edges.map((e) => e.target).sort(), [
      'en:graph-filter/also-published'
    ])

    const authedRows = await pagesModel.listAllForGraph(fixtures.siteId, false)
    const authedGraph = assembleGraph(authedRows, () => true)
    const authedPaths = authedGraph.nodes.map((n) => n.path)
    assert.ok(authedPaths.includes('graph-filter/published'))
    assert.ok(authedPaths.includes('graph-filter/also-published'))
    assert.ok(authedPaths.includes('graph-filter/draft'))
    assert.ok(!authedPaths.includes('graph-filter/hidden'))
    assert.deepEqual(authedGraph.edges.map((e) => e.target).sort(), [
      'en:graph-filter/also-published',
      'en:graph-filter/draft'
    ])
  })
})

/** At the route level, not through `assembleGraph()`: the hoisting exists only in the handler. */
describe('GET /sites/:siteId/graph — actor hoisted out of the per-row filter (OpenProject #1864)', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'

  function makeGraphRow(path: string): GraphPageRow {
    return {
      id: path,
      path,
      locale: 'en',
      title: path,
      icon: null,
      tags: [],
      classification: 'level-public',
      relations: [],
      links: [],
      publishState: 'published'
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
      models: {
        pages: {
          listAllForGraph: async () => [
            makeGraphRow('open-a'),
            makeGraphRow('open-b'),
            makeGraphRow('secret')
          ]
        },
        pageHistory: {
          contributorCountsForGraph: async () => new Map()
        },
        pageviews: {
          countsForGraph: async () => new Map()
        },
        groups: {
          actorForRequest,
          checkAccess
        },
        classificationLevels: {
          byId: () => null
        }
      }
    }

    app = await buildTestApp({
      routes: graphRoutes,
      wiki,
      session: { authenticated: true }
    })
  })

  after(() => closeTestApp(app))

  test('filters out a row checkAccess refuses, keeping the rest -- same node set as the unhoisted call', async () => {
    const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/graph` })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(
      res
        .json()
        .nodes.map((n: { path: string }) => n.path)
        .sort(),
      ['open-a', 'open-b']
    )
  })

  test('builds the actor exactly once per request, not once per row', async () => {
    actorForRequest.mock.resetCalls()
    checkAccess.mock.resetCalls()

    await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/graph` })

    assert.equal(actorForRequest.mock.calls.length, 1)
    // -> Still once per row: only actor construction is hoisted.
    assert.equal(checkAccess.mock.calls.length, 3)
    const actor = actorForRequest.mock.calls[0]!.result
    for (const call of checkAccess.mock.calls) {
      assert.equal(call.arguments[0], actor)
    }
  })
})

describe('assembleGraph node cap', () => {
  /** Zero-padded paths, so the lexicographic order the cap sorts by matches numeric order. */
  function makeManyRows(n: number): GraphPageRow[] {
    return Array.from({ length: n }, (_, i) => makeRow({ path: `p${String(i).padStart(6, '0')}` }))
  }

  test('an under-cap site is not truncated, and totalNodes equals nodes.length', () => {
    const rows = makeManyRows(3)

    const result = assembleGraph(rows, () => true)

    assert.equal(result.truncated, false)
    assert.equal(result.totalNodes, result.nodes.length)
    assert.equal(result.totalNodes, 3)
  })

  test('an over-cap site is truncated to exactly the cap, reporting the true totalNodes', () => {
    const rows = makeManyRows(GRAPH_NODE_CAP + 137)

    const result = assembleGraph(rows, () => true)

    assert.equal(result.truncated, true)
    assert.equal(result.nodes.length, GRAPH_NODE_CAP)
    assert.equal(result.totalNodes, GRAPH_NODE_CAP + 137)
  })

  test('the cap only counts readable rows -- totalNodes reflects canRead, not the raw row count', () => {
    const rows = makeManyRows(GRAPH_NODE_CAP + 50)

    const result = assembleGraph(
      rows,
      (row) => row.path < `p${String(GRAPH_NODE_CAP).padStart(6, '0')}`
    )

    assert.equal(result.truncated, false)
    assert.equal(result.totalNodes, GRAPH_NODE_CAP)
    assert.equal(result.nodes.length, GRAPH_NODE_CAP)
  })

  test('selection is deterministic (sorted by path), not raw row order', () => {
    const ordered = makeManyRows(GRAPH_NODE_CAP + 10)
    const shuffled = [...ordered].reverse()

    const fromOrdered = assembleGraph(ordered, () => true)
    const fromShuffled = assembleGraph(shuffled, () => true)

    assert.deepEqual(
      fromOrdered.nodes.map((n) => n.path),
      fromShuffled.nodes.map((n) => n.path)
    )
    // -> The lexicographically-first paths specifically, not merely some stable subset.
    assert.deepEqual(
      fromOrdered.nodes.map((n) => n.path),
      ordered.slice(0, GRAPH_NODE_CAP).map((r) => r.path)
    )
  })

  test('no returned edge references a node dropped by the cap', () => {
    const rows = makeManyRows(GRAPH_NODE_CAP + 20)
    const droppedPath = rows.at(-1)!.path
    const retainedPath = rows[0]!.path
    for (const row of rows) {
      row.links = [droppedPath, retainedPath]
    }

    const result = assembleGraph(rows, () => true)
    const nodeIds = new Set(result.nodes.map((n) => n.id))
    const retainedId = `en:${retainedPath}`

    assert.ok(result.truncated)
    for (const edge of result.edges) {
      assert.ok(nodeIds.has(edge.source), `edge source ${edge.source} is not a returned node`)
      assert.ok(nodeIds.has(edge.target), `edge target ${edge.target} is not a returned node`)
    }
    // -> Guards the loop above against passing vacuously with every edge dropped.
    assert.ok(result.edges.some((e) => e.target === retainedId))
  })
})
