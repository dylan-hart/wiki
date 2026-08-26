import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { NotYetImplementedError } from './connector.ts'
import {
  compareAgainstDryRunReports,
  compareEntityCounts,
  countDestinationEntities,
  countSourceEntities,
  createDestinationCounter,
  formatVerifySummary,
  hashContent,
  ReservoirSampler,
  runContentSpotCheck,
  VERIFY_ENTITIES
} from './verify.ts'
import type { DestinationCounter, DestinationPageLookup } from './verify.ts'
import type { SourceAssetFile, SourceConnector, SourceRecord } from './connector.ts'
import type { PhaseReport } from './report.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { pages as pagesTable } from '../db/schema.ts'

/** Every entity generator throws, matching both real connectors' current stub state — same pattern
 * `phases/phases.test.ts` uses. */
function stubConnector(): SourceConnector {
  const notImplemented = (method: string) => () => {
    throw new NotYetImplementedError(method, 'some later task')
  }
  return {
    kind: 'postgres',
    connect: async () => {},
    disconnect: async () => {},
    describe: async () => ({ kind: 'postgres', location: 'stub', notes: [] }),
    users: notImplemented('users'),
    groups: notImplemented('groups'),
    pages: notImplemented('pages'),
    pageHistory: notImplemented('pageHistory'),
    tags: notImplemented('tags'),
    navigation: notImplemented('navigation'),
    settings: notImplemented('settings'),
    assets: notImplemented('assets')
  }
}

async function* recordsOf(count: number): AsyncGenerator<SourceRecord> {
  for (let i = 0; i < count; i++) {
    yield { id: i }
  }
}

function workingConnector(counts: Partial<Record<keyof SourceConnector, number>>): SourceConnector {
  const base = stubConnector()
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(counts).map(([entity, count]) => [entity, () => recordsOf(count!)])
    )
  } as SourceConnector
}

function fakeDestinationCounter(counts: Partial<Record<string, number>>): DestinationCounter {
  return {
    users: async () => counts.users ?? 0,
    groups: async () => counts.groups ?? 0,
    pages: async () => counts.pages ?? 0,
    pageHistory: async () => counts.pageHistory ?? 0,
    tags: async () => counts.tags ?? 0,
    assets: async () => counts.assets ?? 0,
    navigation: async () => counts.navigation ?? 0
  }
}

describe('countSourceEntities', () => {
  test('reports not_implemented for every entity against the current connector stubs', async () => {
    const counts = await countSourceEntities(stubConnector())
    for (const entity of VERIFY_ENTITIES) {
      assert.equal(counts[entity], 'not_implemented')
    }
  })

  test('counts records from a working connector, per entity', async () => {
    const counts = await countSourceEntities(
      workingConnector({ users: 3, groups: 2, pages: 5, pageHistory: 8, tags: 1, assets: 4 })
    )
    assert.equal(counts.users, 3)
    assert.equal(counts.groups, 2)
    assert.equal(counts.pages, 5)
    assert.equal(counts.pageHistory, 8)
    assert.equal(counts.tags, 1)
    assert.equal(counts.assets, 4)
    assert.equal(counts.navigation, 'not_implemented')
  })

  test('a real (non-stub) error propagates rather than being swallowed', async () => {
    const connector = stubConnector()
    connector.users = () => {
      throw new Error('connection reset')
    }
    await assert.rejects(() => countSourceEntities(connector), /connection reset/)
  })
})

describe('countDestinationEntities', () => {
  test('runs every DestinationCounter method for the given site', async () => {
    const counter = fakeDestinationCounter({ users: 10, groups: 2, pages: 40, assets: 6 })
    const counts = await countDestinationEntities(counter, 'site-1')
    assert.deepEqual(counts, {
      users: 10,
      groups: 2,
      pages: 40,
      pageHistory: 0,
      tags: 0,
      assets: 6,
      navigation: 0
    })
  })
})

describe('createDestinationCounter.tags', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
  })

  after(async () => {
    await teardownTestDb()
  })

  /** Minimal `.values()` object satisfying every NOT NULL column on `pages`, same shape
   * `models/pages.test.ts`'s `rawPageRow` uses for a raw insert. */
  function rawPageRow(overrides: { path: string; tags: string[] }) {
    return {
      siteId: fixtures.siteId,
      locale: 'en',
      path: overrides.path,
      hash: `raw-hash-${overrides.path}`,
      title: 'Raw Row',
      editor: 'markdown',
      contentType: 'markdown',
      authorId: fixtures.userId,
      creatorId: fixtures.userId,
      ownerId: fixtures.userId,
      classification: fixtures.classificationId,
      tags: overrides.tags
    }
  }

  test('counts DISTINCT tags unnested from pages.tags, not the dead tags table', async () => {
    await fixtures.db
      .insert(pagesTable)
      .values(rawPageRow({ path: 'tag-probe/one', tags: ['a', 'b'] }))
    await fixtures.db
      .insert(pagesTable)
      .values(rawPageRow({ path: 'tag-probe/two', tags: ['b', 'c'] }))

    const counter = createDestinationCounter(fixtures.db)
    const destinationCount = await counter.tags(fixtures.siteId)
    assert.equal(destinationCount, 3)

    const reconciled = compareEntityCounts(
      {
        users: 0,
        groups: 0,
        pages: 0,
        pageHistory: 0,
        tags: 3,
        assets: 0,
        navigation: 0
      },
      {
        users: 0,
        groups: 0,
        pages: 0,
        pageHistory: 0,
        tags: destinationCount,
        assets: 0,
        navigation: 0
      }
    )
    assert.deepEqual(
      reconciled.find((entry) => entry.entity === 'tags'),
      { entity: 'tags', sourceCount: 3, destinationCount: 3, status: 'match' }
    )
  })
})

describe('compareEntityCounts', () => {
  test('matches when source and destination agree', () => {
    const [result] = compareEntityCounts(
      { users: 5, groups: 0, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { users: 5, groups: 0, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 }
    )
    assert.deepEqual(result, {
      entity: 'users',
      sourceCount: 5,
      destinationCount: 5,
      status: 'match'
    })
  })

  test('flags a mismatch when counts disagree', () => {
    const results = compareEntityCounts(
      { users: 5, groups: 0, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { users: 4, groups: 0, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 }
    )
    const users = results.find((r) => r.entity === 'users')!
    assert.equal(users.status, 'mismatch')
    assert.equal(users.sourceCount, 5)
    assert.equal(users.destinationCount, 4)
  })

  test('reports source_not_implemented instead of a false mismatch', () => {
    const results = compareEntityCounts(
      {
        users: 'not_implemented',
        groups: 0,
        pages: 0,
        pageHistory: 0,
        tags: 0,
        assets: 0,
        navigation: 0
      },
      { users: 999, groups: 0, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 }
    )
    const users = results.find((r) => r.entity === 'users')!
    assert.equal(users.status, 'source_not_implemented')
    assert.equal(users.sourceCount, null)
    assert.equal(users.destinationCount, 999)
  })

  test('covers every VERIFY_ENTITIES entry exactly once', () => {
    const zeroSource = Object.fromEntries(VERIFY_ENTITIES.map((e) => [e, 0])) as any
    const zeroDest = Object.fromEntries(VERIFY_ENTITIES.map((e) => [e, 0])) as any
    const results = compareEntityCounts(zeroSource, zeroDest)
    assert.deepEqual(
      results.map((r) => r.entity),
      VERIFY_ENTITIES
    )
  })

  test('a source with two system groups against a destination holding three seeded ones reports match', () => {
    // -> The importer skips 2.x's two system groups (Administrators/Guests); 3.0 seeds its own three
    //    (Administrators/Users/Guests). A flawless import with zero non-system groups therefore leaves
    //    the source reporting exactly its two system rows against a destination of exactly three.
    const results = compareEntityCounts(
      { users: 0, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { users: 0, groups: 3, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 }
    )
    const groups = results.find((r) => r.entity === 'groups')!
    assert.equal(groups.status, 'match')
    assert.equal(groups.sourceCount, 2)
    assert.equal(groups.destinationCount, 3)
  })

  test('a destination two groups off the expected +1 delta still reports mismatch', () => {
    const results = compareEntityCounts(
      { users: 0, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { users: 0, groups: 5, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 }
    )
    const groups = results.find((r) => r.entity === 'groups')!
    assert.equal(groups.status, 'mismatch')
  })

  test('users has no expected delta: a matching users count still reports match unchanged', () => {
    // -> On a fresh single-site import 2.x's two skipped system users net out exactly against 3.0's
    //    own two seeded users, so bare equality (no offset) is still the right comparison for users.
    const results = compareEntityCounts(
      { users: 7, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { users: 7, groups: 3, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 }
    )
    const users = results.find((r) => r.entity === 'users')!
    assert.equal(users.status, 'match')
  })
})

describe('compareAgainstDryRunReports', () => {
  function report(phase: PhaseReport['phase'], found: number): PhaseReport {
    return { phase, found, wouldCreate: found, wouldSkipExisting: 0, conflicts: [], unmappable: [] }
  }

  test('matches when the live sum for a phase equals the captured report', () => {
    const results = compareAgainstDryRunReports(
      { users: 3, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      [report('users', 5)]
    )
    const users = results.find((r) => r.phase === 'users')!
    assert.equal(users.status, 'match')
    assert.equal(users.reportFound, 5)
    assert.equal(users.liveFound, 5)
  })

  test('flags a mismatch between the live total and the captured report', () => {
    const results = compareAgainstDryRunReports(
      { users: 3, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      [report('users', 6)]
    )
    const users = results.find((r) => r.phase === 'users')!
    assert.equal(users.status, 'mismatch')
  })

  test('reports live_not_implemented when any owned entity is still a stub', () => {
    const results = compareAgainstDryRunReports(
      {
        users: 'not_implemented',
        groups: 2,
        pages: 0,
        pageHistory: 0,
        tags: 0,
        assets: 0,
        navigation: 0
      },
      [report('users', 5)]
    )
    const users = results.find((r) => r.phase === 'users')!
    assert.equal(users.status, 'live_not_implemented')
    assert.equal(users.liveFound, null)
  })

  test('reports no_report when no captured report names that phase', () => {
    const results = compareAgainstDryRunReports(
      { users: 3, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      []
    )
    const users = results.find((r) => r.phase === 'users')!
    assert.equal(users.status, 'no_report')
  })

  test('sums pages+pageHistory+tags for the content phase, matching PhaseReport.found granularity', () => {
    const results = compareAgainstDryRunReports(
      { users: 0, groups: 0, pages: 4, pageHistory: 7, tags: 1, assets: 0, navigation: 0 },
      [report('content', 12)]
    )
    const content = results.find((r) => r.phase === 'content')!
    assert.equal(content.liveFound, 12)
    assert.equal(content.status, 'match')
  })

  test('covers every phase an entity is currently wired to (settings has none)', () => {
    const results = compareAgainstDryRunReports(
      { users: 0, groups: 0, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      []
    )
    const phases = results.map((r) => r.phase).sort()
    assert.deepEqual(phases, ['assets', 'content', 'users'])
  })
})

describe('hashContent', () => {
  test('is deterministic', () => {
    assert.equal(hashContent('hello'), hashContent('hello'))
  })

  test('differs for different content', () => {
    assert.notEqual(hashContent('hello'), hashContent('hello!'))
  })

  test('treats null and undefined the same as an empty string', () => {
    assert.equal(hashContent(null), hashContent(undefined))
    assert.equal(hashContent(null), hashContent(''))
  })
})

describe('ReservoirSampler', () => {
  test('keeps every item when fewer than the reservoir size are offered', () => {
    const sampler = new ReservoirSampler<number>(5)
    ;[1, 2, 3].forEach((n) => sampler.offer(n))
    assert.deepEqual(sampler.result().sort(), [1, 2, 3])
  })

  test('never exceeds the requested size', () => {
    const sampler = new ReservoirSampler<number>(3)
    for (let i = 0; i < 100; i++) {
      sampler.offer(i)
    }
    assert.equal(sampler.result().length, 3)
  })

  test('with a deterministic rng that never replaces, keeps exactly the first N items', () => {
    const sampler = new ReservoirSampler<number>(3, () => 1) // Math.floor(1 * seen) is never < size
    for (let i = 0; i < 10; i++) {
      sampler.offer(i)
    }
    assert.deepEqual(sampler.result(), [0, 1, 2])
  })
})

describe('runContentSpotCheck', () => {
  function fakeLookup(pagesByPath: Record<string, string | null>): DestinationPageLookup {
    return async (_siteId, _locale, path) => {
      if (!(path in pagesByPath)) {
        return undefined
      }
      return { content: pagesByPath[path] }
    }
  }

  test('reports source_not_implemented against the current connector stubs', async () => {
    const results = await runContentSpotCheck(stubConnector(), fakeLookup({}), {
      siteId: 'site-1',
      sampleSize: 5
    })
    assert.deepEqual(results, [{ path: '(all pages)', status: 'source_not_implemented' }])
  })

  test('matches when source and destination content hash the same', async () => {
    async function* pages(): AsyncGenerator<SourceRecord> {
      yield { id: 1, path: 'en/home', localeCode: 'en', content: '# hello' }
    }
    const connector = { ...stubConnector(), pages }
    const results = await runContentSpotCheck(connector, fakeLookup({ 'en/home': '# hello' }), {
      siteId: 'site-1',
      paths: ['en/home']
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].status, 'match')
    assert.equal(results[0].sourceHash, results[0].destinationHash)
  })

  test('flags a mismatch when the stored bodies differ (truncation/corruption)', async () => {
    async function* pages(): AsyncGenerator<SourceRecord> {
      yield { id: 1, path: 'en/home', localeCode: 'en', content: '# hello world' }
    }
    const connector = { ...stubConnector(), pages }
    const results = await runContentSpotCheck(connector, fakeLookup({ 'en/home': '# hello' }), {
      siteId: 'site-1',
      paths: ['en/home']
    })
    assert.equal(results[0].status, 'mismatch')
  })

  test('reports destination_missing when the destination has no such page', async () => {
    async function* pages(): AsyncGenerator<SourceRecord> {
      yield { id: 1, path: 'en/home', localeCode: 'en', content: '# hello' }
    }
    const connector = { ...stubConnector(), pages }
    const results = await runContentSpotCheck(connector, fakeLookup({}), {
      siteId: 'site-1',
      paths: ['en/home']
    })
    assert.equal(results[0].status, 'destination_missing')
  })

  test('reports source_missing for an explicit path never found at the source', async () => {
    async function* pages(): AsyncGenerator<SourceRecord> {
      yield { id: 1, path: 'en/home', localeCode: 'en', content: '# hello' }
    }
    const connector = { ...stubConnector(), pages }
    const results = await runContentSpotCheck(connector, fakeLookup({}), {
      siteId: 'site-1',
      paths: ['en/does-not-exist']
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].path, 'en/does-not-exist')
    assert.equal(results[0].status, 'source_missing')
  })

  test('random-samples up to sampleSize pages when no explicit paths are given', async () => {
    async function* pages(): AsyncGenerator<SourceRecord> {
      for (let i = 0; i < 50; i++) {
        yield { id: i, path: `en/page-${i}`, localeCode: 'en', content: `body-${i}` }
      }
    }
    const connector = { ...stubConnector(), pages }
    const results = await runContentSpotCheck(connector, fakeLookup({}), {
      siteId: 'site-1',
      sampleSize: 5,
      rng: () => 1 // Math.floor(1 * seen) is never < size once full -> deterministic first-5
    })
    assert.equal(results.length, 5)
    assert.deepEqual(
      results.map((r) => r.path),
      ['en/page-0', 'en/page-1', 'en/page-2', 'en/page-3', 'en/page-4']
    )
  })

  test('assets() being not_implemented does not affect a pages-only spot-check', async () => {
    // Defends against a spot-check that accidentally reads through more of SourceConnector than
    // pages() alone.
    async function* pages(): AsyncGenerator<SourceRecord> {
      yield { id: 1, path: 'en/home', localeCode: 'en', content: 'x' }
    }
    const connector: SourceConnector = { ...stubConnector(), pages }
    assert.throws(() => connector.assets() as AsyncIterable<SourceAssetFile>)
    const results = await runContentSpotCheck(connector, fakeLookup({ 'en/home': 'x' }), {
      siteId: 'site-1',
      paths: ['en/home']
    })
    assert.equal(results[0].status, 'match')
  })

  test('normalizes an uppercase/underscored 2.x source path before the destination lookup', async () => {
    // The source path is exactly what a real 2.x row would carry -- uppercase segments and an
    // underscore -- while the destination is keyed the way `assignTreePaths`/`normalizeMigratedPath`
    // actually wrote it on import: lowercased, underscores folded to hyphens. An unnormalized lookup
    // would miss this row entirely and report `destination_missing`.
    async function* pages(): AsyncGenerator<SourceRecord> {
      yield { id: 1, path: 'Guide/Getting_Started', localeCode: 'en', content: '# intro' }
    }
    const connector = { ...stubConnector(), pages }
    const results = await runContentSpotCheck(
      connector,
      fakeLookup({ 'guide/getting-started': '# intro' }),
      { siteId: 'site-1', paths: ['Guide/Getting_Started'] }
    )
    assert.equal(results.length, 1)
    assert.equal(results[0].path, 'Guide/Getting_Started') // reported path stays the raw source path
    assert.equal(results[0].status, 'match')
  })

  test('reports destination_missing, not a crash, when a source path fails to normalize at all', async () => {
    async function* pages(): AsyncGenerator<SourceRecord> {
      yield { id: 1, path: '///', localeCode: 'en', content: '# unreachable' }
    }
    const connector = { ...stubConnector(), pages }
    const results = await runContentSpotCheck(connector, fakeLookup({}), {
      siteId: 'site-1',
      paths: ['///']
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].status, 'destination_missing')
  })
})

describe('formatVerifySummary', () => {
  test('outcome is pass when every entity matches and no phase report is given', () => {
    const entityCounts = VERIFY_ENTITIES.map((entity) => ({
      entity,
      sourceCount: 0,
      destinationCount: 0,
      status: 'match' as const
    }))
    const summary = formatVerifySummary({ entityCounts, phaseComparisons: [], spotCheck: [] })
    assert.equal(summary.outcome, 'pass')
    assert.match(summary.text, /Overall: PASS/)
  })

  test('outcome is incomplete when nothing is a mismatch but something is not_implemented', () => {
    const entityCounts = VERIFY_ENTITIES.map((entity) => ({
      entity,
      sourceCount: entity === 'users' ? null : 0,
      destinationCount: 0,
      status: entity === 'users' ? ('source_not_implemented' as const) : ('match' as const)
    }))
    const summary = formatVerifySummary({ entityCounts, phaseComparisons: [], spotCheck: [] })
    assert.equal(summary.outcome, 'incomplete')
  })

  test('outcome is fail when any entity count mismatches', () => {
    const entityCounts = [
      { entity: 'users' as const, sourceCount: 5, destinationCount: 4, status: 'mismatch' as const }
    ]
    const summary = formatVerifySummary({ entityCounts, phaseComparisons: [], spotCheck: [] })
    assert.equal(summary.outcome, 'fail')
    assert.match(summary.text, /Overall: FAIL/)
  })

  test('outcome is fail when the content spot-check finds a mismatch', () => {
    const summary = formatVerifySummary({
      entityCounts: [],
      phaseComparisons: [],
      spotCheck: [{ path: 'en/home', status: 'mismatch', sourceHash: 'a', destinationHash: 'b' }]
    })
    assert.equal(summary.outcome, 'fail')
  })

  test('the rendered text lists every entity, phase comparison and spot-check row', () => {
    const summary = formatVerifySummary({
      entityCounts: [
        { entity: 'users' as const, sourceCount: 3, destinationCount: 3, status: 'match' as const }
      ],
      phaseComparisons: [{ phase: 'users', reportFound: 3, liveFound: 3, status: 'match' }],
      spotCheck: [{ path: 'en/home', status: 'match', sourceHash: 'a', destinationHash: 'a' }]
    })
    assert.match(summary.text, /users: source=3 destination=3/)
    assert.match(summary.text, /users: dry-run found=3 live found=3/)
    assert.match(summary.text, /en\/home: match/)
  })
})
