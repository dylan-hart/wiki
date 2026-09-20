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

class FixtureSourceConnector implements SourceConnector {
  readonly kind: SourceKind = 'postgres'
  private readonly fixturePages: SourceRecord[]
  private readonly fixtureHistory: SourceRecord[]
  private readonly fixtureNavigation: SourceRecord[]
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
    // No page 999 in FIXTURE_PAGES: 2.x's pageHistory.pageId carries no FK, so history outlives a
    // deleted page.
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
    // -> A generator's resident set cannot be observed from outside, so the streaming contract is
    //    checked indirectly: each page is built fresh from its own row, an already-yielded page is
    //    never mutated, and the index (all that stays resident) carries no heavy field.
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
      assert.equal(page.content, `body-${page.oldId}`.repeat(1000))
      if (previous) {
        assert.equal(previous.content, `body-${previous.oldId}`.repeat(1000))
      }
      previous = page
    }

    assert.deepEqual(Object.keys(index), ['pageOldIds'])
  })

  test("coerces an export-bundle source's integer-valued isPrivate/isPublished flags (OpenProject #1850)", async () => {
    // -> The export bundle (the only source for MySQL/MariaDB/SQLite) carries 2.x boolean columns as
    //    JSON 0/1, not the Postgres connector's real booleans.
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

// A live PostgresSourceConnector yields a real `Date` for a timestamp column (node-postgres's default
// decoding), a bundle connector an ISO string. Staging must normalize both to ISO: `String(date)` is
// `Date.prototype.toString()`'s locale/timezone-dependent format.
describe('timestamp normalization (Date vs string ambiguity)', () => {
  test('stagePage normalizes real Date objects to ISO strings', async () => {
    const datePage: SourceRecord = {
      id: 6,
      path: 'date-sourced',
      localeCode: 'en',
      title: 'Date Sourced',
      description: null,
      content: 'body',
      render: '<p>body</p>',
      toc: [],
      contentType: 'markdown',
      isPrivate: false,
      privateNS: null,
      isPublished: true,
      publishStartDate: new Date('2020-03-01T12:00:00.000Z'),
      publishEndDate: new Date('2020-04-01T12:00:00.000Z'),
      createdAt: new Date('2019-12-01T00:00:00.000Z'),
      updatedAt: new Date('2020-01-02T00:00:00.000Z'),
      extra: {},
      editorKey: 'markdown',
      authorId: 10,
      creatorId: 10,
      tags: []
    }

    const connector = new FixtureSourceConnector([datePage], [], [])
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const page = result.pages.find((p) => p.oldId === 6)!
    assert.equal(page.createdAt, '2019-12-01T00:00:00.000Z')
    assert.equal(page.updatedAt, '2020-01-02T00:00:00.000Z')
    assert.equal(page.publishStartDate, '2020-03-01T12:00:00.000Z')
    assert.equal(page.publishEndDate, '2020-04-01T12:00:00.000Z')
  })

  test('stageHistoryEntry normalizes real Date objects, including versionDate, to ISO strings', async () => {
    const datePage: SourceRecord = {
      id: 7,
      path: 'date-sourced-history',
      localeCode: 'en',
      title: 'Date Sourced History',
      description: null,
      content: 'body',
      render: '<p>body</p>',
      toc: [],
      contentType: 'markdown',
      isPrivate: false,
      privateNS: null,
      isPublished: true,
      publishStartDate: null,
      publishEndDate: null,
      createdAt: new Date('2019-12-01T00:00:00.000Z'),
      updatedAt: new Date('2019-12-01T00:00:00.000Z'),
      extra: {},
      editorKey: 'markdown',
      authorId: 10,
      creatorId: 10,
      tags: []
    }
    const dateHistory: SourceRecord = {
      id: 700,
      pageId: 7,
      action: 'created',
      path: 'date-sourced-history',
      localeCode: 'en',
      title: 'Date Sourced History',
      description: null,
      content: 'body',
      contentType: 'markdown',
      isPrivate: false,
      isPublished: true,
      publishStartDate: new Date('2020-03-01T12:00:00.000Z'),
      publishEndDate: new Date('2020-04-01T12:00:00.000Z'),
      editorKey: 'markdown',
      versionDate: new Date('2019-12-01T00:00:00.000Z'),
      createdAt: new Date('2019-12-01T00:00:00.000Z'),
      extra: {},
      authorId: 10,
      tags: []
    }

    const connector = new FixtureSourceConnector([datePage], [dateHistory], [])
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const page = result.pages.find((p) => p.oldId === 7)!
    const history = page.history[0]
    assert.equal(history.versionDate, '2019-12-01T00:00:00.000Z')
    assert.equal(history.createdAt, '2019-12-01T00:00:00.000Z')
    assert.equal(history.publishStartDate, '2020-03-01T12:00:00.000Z')
    assert.equal(history.publishEndDate, '2020-04-01T12:00:00.000Z')
  })

  test('a null publishStartDate/publishEndDate stays null regardless of connector shape', async () => {
    const datePage: SourceRecord = {
      id: 8,
      path: 'null-dates',
      localeCode: 'en',
      title: 'Null Dates',
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
      createdAt: new Date('2019-12-01T00:00:00.000Z'),
      updatedAt: new Date('2019-12-01T00:00:00.000Z'),
      extra: {},
      editorKey: 'markdown',
      authorId: 10,
      creatorId: 10,
      tags: []
    }

    const connector = new FixtureSourceConnector([datePage], [], [])
    const result = await stageAll(connector, {
      userIdMap: makeUserIdMap(),
      fallbackActorId: 'uuid-operator'
    })

    const page = result.pages.find((p) => p.oldId === 8)!
    assert.equal(page.publishStartDate, null)
    assert.equal(page.publishEndDate, null)
  })
})
