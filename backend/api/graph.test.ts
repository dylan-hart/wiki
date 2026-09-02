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
  // -> `id` defaults to `path` (not a fixed constant) so a test giving several rows distinct
  //    `path`s for free also gets them distinct `id`s, without every call site having to say so.
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

  // -> OpenProject #1621/#1626: translations share `path` by design, so a node's id must be
  //    `${locale}:${path}`, not the bare path -- otherwise the `en` and `fr` copies of the same path
  //    collapse into one node/edge target.
  test('keys nodes by the composite locale:path id, so same-path translations stay distinct', () => {
    const rows = [
      makeRow({ path: 'docs/intro', locale: 'en', title: 'Intro' }),
      makeRow({ path: 'docs/intro', locale: 'fr', title: 'Introduction' })
    ]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.nodes.map((n) => n.id).sort(), ['en:docs/intro', 'fr:docs/intro'])
    // -> Both nodes keep the same display `path` -- only `id` disambiguates them.
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

  // -> OpenProject #1626: translations share a `path` by design
  //    (`docs/decisions/locale-translation-linking.md`), so the composite `${locale}:${path}` id is
  //    what actually distinguishes an `en` page from its `fr` twin at the same path -- and what a
  //    link/relation target must resolve against, or an `en` page's link would count as visible
  //    when only a `fr`-locale page occupies that path.
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
    // -> The `en` and `fr` copies of `docs/intro` are distinct nodes, not one collapsed onto the
    //    other -- both keep the same display `path`.
    assert.equal(new Set(result.nodes.map((n) => n.id)).size, result.nodes.length)
    assert.ok(result.nodes.every((n) => n.path === 'docs/intro' || n.path === 'docs/only-in-fr'))
    // -> `en:docs/intro` links to `docs/only-in-fr`, which only exists in `fr` -- no edge, because
    //    the link resolves against the source row's own locale (`en`), not any locale holding the
    //    path.
    assert.deepEqual(result.edges, [])
  })

  // -> OpenProject #1126: a CLASSIFICATION rule must be able to hide a page from the graph, the same
  //    way it already hides it from direct view, search and the sitemap. `canRead` here stands in
  //    for `mayOnPage()`, which resolves a CLASSIFICATION DENY against `row.classification` -- so
  //    this only holds if `classification` actually reaches the predicate on every row.
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

  // -> OpenProject #1217: node.classification is the resolved display name, not the raw id --
  //    `classificationName` stands in for `WIKI.models.classificationLevels.byId(id)?.name`.
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

  // -> OpenProject #1141: node.contributors is the resolved edit-volume counts, not looked up by
  //    the test itself -- `contributorsFor` stands in for `pageHistory.contributorCountsForGraph()`.
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

  // -> OpenProject #1140: node.pageviews is the resolved page-visit-volume counts, not looked up by
  //    the test itself -- `pageviewsFor` stands in for `pageviews.countsForGraph()`.
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

  // -> OpenProject #1863: `contributors`/`pageviews` dominate the per-node payload and most readers
  //    of the default view never look at them, so they're gated behind `includeSizing` (the route's
  //    `?sizing=` querystring, `Boolean`-cast) -- omitted as KEYS, not merely zeroed, when unwanted.
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

/**
 * DB-backed route test for `GET /sites/:siteId/graph` (OpenProject #2269): the caching, cold-rebuild
 * authentication gate, and the pageviews-disabled short-circuit, all of which need a real route, a
 * real permission check and a real database to exercise honestly -- `assembleGraph`'s own pure-unit
 * tests above cover node/edge assembly, not any of this. Same `req.session`-via-hook shape as
 * `api/comments.admin.test.ts`.
 */
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

    // -> `mayOnPage`'s anonymous path resolves the actor's groups through `WIKI.data.systemIds
    //    .guestsGroupId` (`models/groups.ts#groupIdsForRequest`) -- `setupTestDb()` leaves `WIKI.data`
    //    empty, so an anonymous request needs this set, with the fixture group standing in as
    //    "guests" and granted `read:pages` site-wide through a real rule (not the group-wide
    //    `permissions` column, which page-rule checks never consult).
    WIKI.data.systemIds = { guestsGroupId: fixtures.groupId }
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

    // -> `buildTestApp` installs the REAL error handler, which is what shapes a thrown
    //    `reply.unauthorized()`/`notFound()` into the `{ ok, error, statusCode, message }` the
    //    route's `401`/`403` `ApiError` responses expect. Without it, `reply.unauthorized()` fails
    //    schema serialization instead of answering 401 (`ok` is a required property `ApiError#`
    //    declares). No `wiki`: `setupTestDb()` already installed the real one.
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
      // -> `fixtures.groupId` is what `before()` above granted `read:pages` site-wide through a real
      //    rule -- an authenticated session's `groupIds` come straight from `session.groups`
      //    (`models/groups.ts#groupIdsForRequest`), not re-resolved from the database, so a session
      //    naming no group here would have no page-rule permission at all and never see the page.
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
      // -> `fixtures.groupId` is what `before()` above granted `read:pages` site-wide through a real
      //    rule -- an authenticated session's `groupIds` come straight from `session.groups`
      //    (`models/groups.ts#groupIdsForRequest`), not re-resolved from the database, so a session
      //    naming no group here would have no page-rule permission at all and never see the page.
      groups: [fixtures.groupId],
      permissions: []
    }
    // -> Warm it first (a cold rebuild has to call all three).
    const warmup = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/graph` })
    assert.equal(warmup.statusCode, 200)

    const listAllForGraph = t.mock.method(pagesModel, 'listAllForGraph')
    const contributorCountsForGraph = t.mock.method(
      WIKI.models.pageHistory,
      'contributorCountsForGraph'
    )
    const countsForGraph = t.mock.method(WIKI.models.pageviews, 'countsForGraph')

    const res = await app.inject({ method: 'GET', url: `/sites/${fixtures.siteId}/graph` })
    assert.equal(res.statusCode, 200)
    assert.equal(listAllForGraph.mock.calls.length, 0)
    assert.equal(contributorCountsForGraph.mock.calls.length, 0)
    assert.equal(countsForGraph.mock.calls.length, 0)
  })

  test('no pageview aggregate runs, and every node reports all-zero pageviews, while tracking is disabled', async (t) => {
    const previousPageviewsConfig = WIKI.config.pageviews
    WIKI.config.pageviews = { isEnabled: false }
    WIKI.cache.delete(`graph:${fixtures.siteId}`)

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
      const countsForGraph = t.mock.method(WIKI.models.pageviews, 'countsForGraph')

      testSession = {
        authenticated: true,
        user: { id: fixtures.userId },
        groups: [fixtures.groupId],
        permissions: []
      }
      // -> `?sizing=visits` (OpenProject #1863): without it `includeSizing` is false and the route
      //    omits `pageviews` from every node entirely (see `includeSizing gate` above), which isn't
      //    what this test is checking -- it wants the per-node `pageviews` object itself to be
      //    genuinely all-zero, not merely absent.
      const res = await app.inject({
        method: 'GET',
        url: `/sites/${fixtures.siteId}/graph?sizing=visits`
      })
      assert.equal(res.statusCode, 200)

      // -> countsForGraph is still called once (the route calls it unconditionally) but its own
      //    early return means it never reaches the database -- see `models/pageviews.test.ts`'s
      //    dedicated no-database assertion for that half; here what matters is the end-to-end
      //    result, every node's `pageviews` staying all-zero.
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
      WIKI.config.pageviews = previousPageviewsConfig
    }
  })

  // -> OpenProject #1587 §2 / #1612: the shared cache (#2269) fetches its bundle once with
  //    `publicOnly: false` and narrows it per caller (see `api/graph.ts#routes`'s route handler,
  //    just above `assembleGraph`) rather than re-querying `publicOnly` per request -- so this
  //    exercises that narrowing end-to-end through the real cached route, not just the model-level
  //    filter the next `describe` below covers directly.
  test('a draft page reaches an authenticated warm-cache caller but not a later anonymous one', async () => {
    testSession = {
      authenticated: true,
      user: { id: fixtures.userId },
      // -> `fixtures.groupId` is what `before()` above granted `read:pages` site-wide through a real
      //    rule -- an authenticated session's `groupIds` come straight from `session.groups`
      //    (`models/groups.ts#groupIdsForRequest`), not re-resolved from the database, so a session
      //    naming no group here would have no page-rule permission at all and never see the page.
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
 * OpenProject #1612: `listAllForGraph`'s own `publicOnly` filter -- not `assembleGraph`'s `canRead`,
 * which only ever expressed permission ("may this reader see the page"), never publication state
 * ("has this page even been published, and did its author mark it browsable"). An unauthenticated
 * caller (`publicOnly: true`) must never get a draft node back from the model layer at all -- run
 * against a real database because the filter lives in the SQL `WHERE` (`pageIsVisible`,
 * `models/tree.ts`), not in application code a mock of the query builder could stand in for.
 *
 * `isBrowsable: false` is excluded either way, authenticated or not: `pageIsVisible`'s own doc
 * comment is explicit that this column "applies either way -- it is the author saying 'not in the
 * tree', not an access rule", matching what `tree.browse()`/`tree.listPages()` already do for a
 * logged-in reader. Only `publishState` is gated by `publicOnly`.
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

/**
 * OpenProject #1864: `GET /sites/:siteId/graph`'s permission filter used to call `mayOnPage(req, ...)`
 * per row, which rebuilds the actor internally on every call. It now hoists
 * `WIKI.models.groups.actorForRequest(req)` once per request (`tree.ts`'s `visibleTreeItems()`
 * shape) and calls `checkAccess(actor, ...)` per row directly.
 *
 * Exercised at the route/HTTP level rather than through `assembleGraph()`'s pure predicate, since
 * the hoisting only exists at the call site inside the route handler.
 */
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
    // -> `createWikiStub`'s own `WIKI.cache` stub backs this: the route reads and writes the graph
    //    bundle through it (`helpers/graphCache.ts`), so `loadGraphData` needs somewhere to look
    //    before it will ever call `listAllForGraph` et al.
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
    // -> Three rows in the fixture -- checkAccess is still called per row, only actor construction
    //    is hoisted.
    assert.equal(checkAccess.mock.calls.length, 3)
    // -> Every checkAccess call reuses the exact same actor object actorForRequest returned once.
    const actor = actorForRequest.mock.calls[0]!.result
    for (const call of checkAccess.mock.calls) {
      assert.equal(call.arguments[0], actor)
    }
  })
})

// -> OpenProject #1866: the node cap, and the truncated/totalNodes signal that lets a client tell
//    the reader a graph view is partial rather than silently attempting a layout it cannot finish.
describe('assembleGraph node cap', () => {
  /** `n` rows with zero-padded paths, so lexicographic order (what the cap sorts by) matches
   *  numeric order -- makes "which rows survive" trivial to assert on. */
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
    // -> The lexicographically-first GRAPH_NODE_CAP paths, specifically -- not just "some stable
    //    subset". Confirms the sort key is `path`, not e.g. insertion order surviving a stable sort.
    assert.deepEqual(
      fromOrdered.nodes.map((n) => n.path),
      ordered.slice(0, GRAPH_NODE_CAP).map((r) => r.path)
    )
  })

  test('no returned edge references a node dropped by the cap', () => {
    const rows = makeManyRows(GRAPH_NODE_CAP + 20)
    // -> Every row links to the very last (guaranteed-dropped) row, and to the very first
    //    (guaranteed-retained) row -- if capped-out targets leaked through, half these edges would
    //    dangle.
    const droppedPath = rows.at(-1)!.path
    const retainedPath = rows[0]!.path
    for (const row of rows) {
      row.links = [droppedPath, retainedPath]
    }

    const result = assembleGraph(rows, () => true)
    // -> Edge `source`/`target` are composite `locale:path` node ids (OpenProject #1621/#1626),
    //    not bare paths -- compare against `n.id`, not `n.path`.
    const nodeIds = new Set(result.nodes.map((n) => n.id))
    const retainedId = `en:${retainedPath}`

    assert.ok(result.truncated)
    for (const edge of result.edges) {
      assert.ok(nodeIds.has(edge.source), `edge source ${edge.source} is not a returned node`)
      assert.ok(nodeIds.has(edge.target), `edge target ${edge.target} is not a returned node`)
    }
    // -> Sanity: edges to the retained target did survive, so the assertion above isn't vacuously
    //    true from every edge having been dropped.
    assert.ok(result.edges.some((e) => e.target === retainedId))
  })
})
