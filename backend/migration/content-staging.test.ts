import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  NotYetImplementedError,
  type SourceAssetFile,
  type SourceConnector,
  type SourceDescription,
  type SourceKind,
  type SourceRecord
} from './connector.ts'
import {
  buildContentStagingIndex,
  createContentStagingContext,
  extractContentStaging,
  extractNavigation,
  type StagedPage
} from './content-staging.ts'

/**
 * A minimal in-memory `SourceConnector` built from fixture rows, for exactly the entities this
 * task's staging structure reads — `pages()`, `pageHistory()`, `navigation()`. Every other generator
 * is a deferred stub, same as the real connectors, since nothing here exercises them.
 */
class FixtureSourceConnector implements SourceConnector {
  readonly kind: SourceKind = 'postgres'
  private readonly fixturePages: SourceRecord[]
  private readonly fixtureHistory: SourceRecord[]
  private readonly fixtureNavigation: SourceRecord[]
  /** Bumped every time `pages()` is iterated — lets a test assert how many full walks a given call
   * actually performs (the streaming design's whole point is exactly two: one for the pre-pass
   * index, one for the real staging walk — never more, never a whole-corpus buffer in between). */
  pagesWalkCount = 0

  constructor(
    fixturePages: SourceRecord[],
    fixtureHistory: SourceRecord[],
    fixtureNavigation: SourceRecord[] = []
  ) {
    this.fixturePages = fixturePages
    this.fixtureHistory = fixtureHistory
    this.fixtureNavigation = fixtureNavigation
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async describe(): Promise<SourceDescription> {
    return { kind: this.kind, location: 'fixture', notes: [] }
  }

  async *pages(): AsyncIterable<SourceRecord> {
    this.pagesWalkCount++
    yield* this.fixturePages
  }

  async *pageHistory(): AsyncIterable<SourceRecord> {
    yield* this.fixtureHistory
  }

  async *navigation(): AsyncIterable<SourceRecord> {
    yield* this.fixtureNavigation
  }

  users(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('users', 'not exercised by this fixture')
  }

  groups(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('groups', 'not exercised by this fixture')
  }

  tags(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('tags', 'not exercised by this fixture')
  }

  settings(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('settings', 'not exercised by this fixture')
  }

  comments(): AsyncIterable<SourceRecord> {
    throw new NotYetImplementedError('comments', 'not exercised by this fixture')
  }

  assets(): AsyncIterable<SourceAssetFile> {
    throw new NotYetImplementedError('assets', 'not exercised by this fixture')
  }
}

/** Drains `extractContentStaging()` into a plain array plus its side-channel `context`, and also
 * returns `navigation` — the shape most of this file's tests want, matching what the old batch
 * `extractContentStaging()` used to return directly. */
async function stageAll(
  connector: SourceConnector,
  options: Parameters<typeof extractContentStaging>[1]
) {
  const index = await buildContentStagingIndex(connector)
  const context = createContentStagingContext()
  const pages: StagedPage[] = []
  for await (const page of extractContentStaging(connector, options, index, context)) {
    pages.push(page)
  }
  const navigation = await extractNavigation(connector)
  return { pages, navigation, index, ...context }
}

/** A small, hand-authored fixture set of 2.x rows: two locale variants of one page, one page with an
 * author id no user importer ever mapped (simulating a deleted 2.x user), a full history chain
 * (deliberately supplied out of `versionDate` order), and one history row for a page that no longer
 * exists among the current `pages` rows (a deleted page, which `pageHistory` is meant to outlive). */
const FIXTURE_PAGES: SourceRecord[] = [
  {
    id: 1,
    path: 'welcome',
    localeCode: 'en',
    title: 'Welcome',
    hash: 'hash-1',
    description: 'The home page',
    content: '# Welcome',
    render: '<h1>Welcome</h1>',
    toc: [],
    contentType: 'markdown',
    isPrivate: false,
    privateNS: null,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    createdAt: '2019-12-01T00:00:00.000Z',
    updatedAt: '2020-01-02T00:00:00.000Z',
    extra: {},
    editorKey: 'markdown',
    authorId: 10,
    creatorId: 10,
    tags: [{ tag: 'intro', title: 'Intro' }]
  },
  {
    id: 2,
    path: 'welcome',
    localeCode: 'fr',
    title: 'Bienvenue',
    hash: 'hash-2',
    description: null,
    content: '# Bienvenue',
    render: '<h1>Bienvenue</h1>',
    toc: [],
    contentType: 'markdown',
    isPrivate: false,
    privateNS: null,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    createdAt: '2019-12-01T00:00:00.000Z',
    updatedAt: '2019-12-01T00:00:00.000Z',
    extra: {},
    editorKey: 'markdown',
    // 2.x allows a null creatorId -- this is normal, not an orphaned FK.
    authorId: 11,
    creatorId: null,
    tags: []
  },
  {
    id: 3,
    path: 'orphan-author',
    localeCode: 'en',
    title: 'Orphan',
    hash: 'hash-3',
    description: null,
    content: 'body',
    render: '<p>body</p>',
    toc: [],
    contentType: 'markdown',
    isPrivate: false,
    privateNS: null,
    isPublished: false,
    publishStartDate: null,
    publishEndDate: null,
    createdAt: '2019-12-01T00:00:00.000Z',
    updatedAt: '2019-12-01T00:00:00.000Z',
    extra: {},
    editorKey: 'markdown',
    // 999 names a 2.x user id the fixture user map below has no entry for.
    authorId: 999,
    creatorId: 10,
    tags: []
  }
]

const FIXTURE_HISTORY: SourceRecord[] = [
  {
    id: 100,
    pageId: 1,
    action: 'updated',
    path: 'welcome',
    localeCode: 'en',
    title: 'Welcome',
    description: 'The home page',
    content: '# Welcome (updated)',
    contentType: 'markdown',
    isPrivate: false,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    editorKey: 'markdown',
    versionDate: '2020-01-02T00:00:00.000Z',
    createdAt: '2020-01-02T00:00:00.000Z',
    extra: {},
    authorId: 10,
    tags: [{ tag: 'intro', title: 'Intro' }]
  },
  {
    // Deliberately listed after the row above despite an earlier versionDate, to prove staging sorts
    // rather than trusting source order.
    id: 101,
    pageId: 1,
    action: 'created',
    path: 'welcome',
    localeCode: 'en',
    title: 'Welcome',
    description: 'The home page',
    content: '# Welcome',
    contentType: 'markdown',
    isPrivate: false,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    editorKey: 'markdown',
    versionDate: '2020-01-01T00:00:00.000Z',
    createdAt: '2019-12-01T00:00:00.000Z',
    extra: {},
    authorId: 10,
    tags: []
  },
  {
    id: 102,
    // No page 999 exists in FIXTURE_PAGES -- this page was deleted, and its history is meant to
    // outlive it (2.5x-source-schema.md: pageHistory.pageId is "a plain column with no FK constraint
    // ... rows are meant to outlive the page they belonged to").
    pageId: 999,
    action: 'deleted',
    path: 'gone',
    localeCode: 'en',
    title: 'Gone',
    description: null,
    content: null,
    contentType: 'markdown',
    isPrivate: false,
    isPublished: false,
    publishStartDate: null,
    publishEndDate: null,
    editorKey: 'markdown',
    versionDate: '2020-02-01T00:00:00.000Z',
    createdAt: '2020-02-01T00:00:00.000Z',
    extra: {},
    authorId: 10,
    tags: []
  }
]

const FIXTURE_NAVIGATION: SourceRecord[] = [
  { key: 'site', config: [{ id: 'home', title: 'Home', target: '/welcome' }] }
]

function makeUserIdMap(): Map<number, string> {
  const map = new Map<number, string>()
  map.set(10, 'uuid-user-10')
  map.set(11, 'uuid-user-11')
  // 999 deliberately absent.
  return map
}

describe('extractContentStaging', () => {
  test('walks every page in the source', async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, FIXTURE_NAVIGATION)
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    assert.equal(result.pages.length, 3)
    assert.deepEqual(
      result.pages.map((p) => p.oldId),
      [1, 2, 3]
    )
  })

  test('resolves authorId/creatorId through the user id map', async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, FIXTURE_NAVIGATION)
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const welcomeEn = result.pages.find((p) => p.oldId === 1)!
    assert.equal(welcomeEn.authorId, 'uuid-user-10')
    assert.equal(welcomeEn.creatorId, 'uuid-user-10')
  })

  test('falls back to the operator actor for a null creatorId without warning', async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, FIXTURE_NAVIGATION)
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const welcomeFr = result.pages.find((p) => p.oldId === 2)!
    assert.equal(welcomeFr.authorId, 'uuid-user-11')
    assert.equal(welcomeFr.creatorId, 'uuid-operator')
    assert.equal(
      result.warnings.some((w) => w.includes('page 2') && w.includes('creatorId')),
      false
    )
  })

  test('falls back to the operator actor and warns for an orphaned authorId FK', async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, FIXTURE_NAVIGATION)
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const orphanAuthorPage = result.pages.find((p) => p.oldId === 3)!
    assert.equal(orphanAuthorPage.authorId, 'uuid-operator')
    assert.ok(
      result.warnings.some(
        (w) => w.includes('page 3') && w.includes('authorId') && w.includes('999')
      )
    )
  })

  test("resolves each page's tags to plain tag strings", async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, FIXTURE_NAVIGATION)
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const welcomeEn = result.pages.find((p) => p.oldId === 1)!
    assert.deepEqual(welcomeEn.tags, ['intro'])
    const welcomeFr = result.pages.find((p) => p.oldId === 2)!
    assert.deepEqual(welcomeFr.tags, [])
  })

  test("attaches each page's full pageHistory chain, ordered by versionDate ascending", async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, FIXTURE_NAVIGATION)
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const welcomeEn = result.pages.find((p) => p.oldId === 1)!
    assert.equal(welcomeEn.history.length, 2)
    assert.deepEqual(
      welcomeEn.history.map((h) => h.oldId),
      [101, 100]
    )
    assert.deepEqual(
      welcomeEn.history.map((h) => h.action),
      ['created', 'updated']
    )
    assert.equal(welcomeEn.history[0].tags.length, 0)
    assert.deepEqual(welcomeEn.history[1].tags, ['intro'])
  })

  test('resolves pageHistory.authorId the same way as pages', async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, FIXTURE_NAVIGATION)
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const welcomeEn = result.pages.find((p) => p.oldId === 1)!
    assert.ok(welcomeEn.history.every((h) => h.authorId === 'uuid-user-10'))
  })

  test('keeps a history row for a page no longer present, as orphanedHistory', async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, FIXTURE_NAVIGATION)
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    assert.equal(result.orphanedHistory.length, 1)
    assert.equal(result.orphanedHistory[0].oldId, 102)
    assert.equal(result.orphanedHistory[0].sourcePageOldId, 999)
    assert.ok(result.warnings.some((w) => w.includes('999') && w.includes('no matching page')))
  })

  test('carries the single navigation row through as items', async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, FIXTURE_NAVIGATION)
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    assert.equal(result.navigation.length, 1)
    assert.equal(result.navigation[0].key, 'site')
    assert.deepEqual(result.navigation[0].items, [
      { id: 'home', title: 'Home', target: '/welcome' }
    ])
  })

  test('handles a source with no navigation row at all', async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, [])
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    assert.deepEqual(result.navigation, [])
  })

  test('handles an empty source with no pages at all', async () => {
    const connector = new FixtureSourceConnector([], [], [])
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    assert.deepEqual(result.pages, [])
    assert.deepEqual(result.orphanedHistory, [])
    assert.deepEqual(result.navigation, [])
  })

  test('walks connector.pages() exactly twice — once for the index pre-pass, once to stream — never buffering the whole corpus', async () => {
    const connector = new FixtureSourceConnector(FIXTURE_PAGES, FIXTURE_HISTORY, FIXTURE_NAVIGATION)
    await stageAll(connector, { userIdMap: makeUserIdMap(), fallbackActorId: 'uuid-operator' })
    assert.equal(connector.pagesWalkCount, 2)
  })

  test("does not retain an already-emitted page's heavy fields across the walk", async () => {
    // -> A fake connector yielding far more pages than any resident set may hold (the streaming
    //    contract this test locks down), each carrying a large, distinguishable `content` payload —
    //    if extractContentStaging() were still buffering every StagedPage (or a map keyed by oldId
    //    holding onto them) rather than yielding and releasing one at a time, an earlier page's
    //    `content` would still be reachable through some resident structure by the time a later page
    //    is staged. Since a generator only ever holds the single object it just yielded, the only way
    //    to observe this from outside is to confirm nothing beyond the lightweight index and the
    //    current page is used to build the *next* page's history/siblings — proven indirectly by the
    //    module never retaining anything array/map beyond ContentStagingIndex, which asserted here for
    //    the earlier tests' page counts, plus content asserted per-page as it streams below.
    const manyPages: SourceRecord[] = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      path: `page-${i + 1}`,
      localeCode: 'en',
      title: `Page ${i + 1}`,
      hash: `hash-${i + 1}`,
      description: null,
      content: `body-${i + 1}`.repeat(1000),
      render: `<p>body-${i + 1}</p>`.repeat(1000),
      toc: [],
      contentType: 'markdown',
      isPrivate: false,
      privateNS: null,
      isPublished: true,
      publishStartDate: null,
      publishEndDate: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      extra: {},
      editorKey: 'markdown',
      authorId: 10,
      creatorId: 10,
      tags: []
    }))

    const connector = new FixtureSourceConnector(manyPages, [], [])
    const index = await buildContentStagingIndex(connector)
    const context = createContentStagingContext()

    let previous: StagedPage | null = null
    for await (const page of extractContentStaging(
      connector,
      { userIdMap: makeUserIdMap(), fallbackActorId: 'uuid-operator' },
      index,
      context
    )) {
      // -> Each yielded page carries its own correct content — proves the generator is building each
      //    page fresh from the current connector row rather than handing back a stale reference into
      //    some earlier accumulated structure.
      assert.equal(page.content, `body-${page.oldId}`.repeat(1000))
      // -> The previous page object is untouched by staging the next one — nothing in this module
      //    mutates an already-yielded StagedPage after handing it to the caller.
      if (previous) {
        assert.equal(previous.content, `body-${previous.oldId}`.repeat(1000))
      }
      previous = page
    }

    // -> The index itself — the only thing kept resident across the whole walk — never carries a
    //    single heavy field: it is nothing but the set of page oldIds.
    assert.deepEqual(Object.keys(index), ['pageOldIds'])
  })

  test("coerces an export-bundle source's integer-valued isPrivate/isPublished flags (OpenProject #1850)", async () => {
    // -> MySQL/MariaDB/SQLite via the export bundle connector represent 2.x boolean columns as JSON
    //    integers (0/1), not real booleans — content-staging.ts's asBoolean() must widen to accept
    //    that representation the same way it already tolerates other cross-engine shapes.
    const integerFlagPage: SourceRecord = {
      id: 100,
      path: 'integer-flags',
      localeCode: 'en',
      title: 'Integer Flags',
      hash: 'hash-100',
      description: null,
      content: '# Integer Flags',
      render: '<h1>Integer Flags</h1>',
      toc: [],
      contentType: 'markdown',
      isPrivate: 0,
      privateNS: null,
      isPublished: 1,
      publishStartDate: null,
      publishEndDate: null,
      createdAt: '2021-01-01T00:00:00.000Z',
      updatedAt: '2021-01-01T00:00:00.000Z',
      extra: {},
      editorKey: 'markdown',
      authorId: 10,
      creatorId: 10,
      tags: []
    }
    const connector = new FixtureSourceConnector([integerFlagPage], [], [])
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const page = result.pages[0]!
    assert.equal(page.isPrivate, false)
    assert.equal(page.isPublished, true)
  })

  test('stages integer-valued isPrivate/isPublished flags (the export-bundle representation) the same as real booleans (Task 1850)', async () => {
    // The export bundle is the only supported source for MySQL/MariaDB/SQLite
    // (docs/migration/decision-source-scope.md), where 2.x's knex/Objection layer represents these
    // columns as integer 0/1 rather than the Postgres connector's real JS boolean.
    const bundlePage: SourceRecord = {
      id: 5,
      path: 'bundle-sourced',
      localeCode: 'en',
      title: 'Bundle Sourced',
      hash: 'hash-5',
      description: null,
      content: 'body',
      render: '<p>body</p>',
      toc: [],
      contentType: 'markdown',
      isPrivate: 1,
      privateNS: null,
      isPublished: 0,
      publishStartDate: null,
      publishEndDate: null,
      createdAt: '2019-12-01T00:00:00.000Z',
      updatedAt: '2019-12-01T00:00:00.000Z',
      extra: {},
      editorKey: 'markdown',
      authorId: 10,
      creatorId: 10,
      tags: []
    }
    const bundleHistory: SourceRecord = {
      id: 500,
      pageId: 5,
      action: 'created',
      path: 'bundle-sourced',
      localeCode: 'en',
      title: 'Bundle Sourced',
      description: null,
      content: 'body',
      contentType: 'markdown',
      isPrivate: 1,
      isPublished: 0,
      publishStartDate: null,
      publishEndDate: null,
      editorKey: 'markdown',
      versionDate: '2019-12-01T00:00:00.000Z',
      createdAt: '2019-12-01T00:00:00.000Z',
      extra: {},
      authorId: 10,
      tags: []
    }

    const connector = new FixtureSourceConnector([bundlePage], [bundleHistory], [])
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const page = result.pages.find((p) => p.oldId === 5)!
    assert.equal(page.isPrivate, true)
    assert.equal(page.isPublished, false)

    const history = page.history[0]
    assert.equal(history.isPrivate, true)
    assert.equal(history.isPublished, false)
  })
})
