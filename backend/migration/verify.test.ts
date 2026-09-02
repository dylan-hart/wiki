import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Readable } from 'node:stream'
import {
  compareAgainstDryRunReports,
  compareEntityCounts,
  countDestinationEntities,
  countPhaseOnlySourceCounts,
  countSourceEntities,
  createDestinationCounter,
  formatVerifySummary,
  hashContent,
  ReservoirSampler,
  runContentSpotCheck,
  VERIFY_ENTITIES
} from './verify.ts'
import type { DestinationCounter, DestinationPageLookup, PhaseOnlySourceCounts } from './verify.ts'
import type { SourceAssetFile, SourceConnector, SourceRecord } from './connector.ts'
import type { PhaseReport } from './report.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { pages as pagesTable } from '../db/schema.ts'
import { assetsPhase } from './phases/assets.ts'
import { usersPhase } from './phases/users.ts'
import { stubSourceConnector } from '../test/migrationFixtures.ts'

async function* recordsOf(count: number): AsyncGenerator<SourceRecord> {
  for (let i = 0; i < count; i++) {
    yield { id: i }
  }
}

function workingConnector(counts: Partial<Record<keyof SourceConnector, number>>): SourceConnector {
  const base = stubSourceConnector()
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
    const counts = await countSourceEntities(stubSourceConnector())
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
    const connector = stubSourceConnector()
    connector.users = () => {
      throw new Error('connection reset')
    }
    await assert.rejects(() => countSourceEntities(connector), /connection reset/)
  })
})

/** Whole-branch review Critical #2: the two counts `VERIFY_ENTITIES`/`countSourceEntities()` don't
 * cover — see `PhaseOnlySourceCounts`'s own doc comment in `verify.ts`. */
describe('countPhaseOnlySourceCounts', () => {
  test('reports not_implemented for both counts against the current connector stubs', async () => {
    const counts = await countPhaseOnlySourceCounts(stubSourceConnector())
    assert.equal(counts.userGroups, 'not_implemented')
    assert.equal(counts.comments, 'not_implemented')
  })

  test('userGroups counts embedded group memberships across every user, not the raw user count', async () => {
    async function* users(): AsyncGenerator<SourceRecord> {
      yield {
        id: 1,
        groups: [
          { id: 1, name: 'Editors' },
          { id: 2, name: 'Reviewers' }
        ]
      }
      yield { id: 2, groups: [{ id: 1, name: 'Editors' }] }
      yield { id: 3, groups: [] }
    }
    const connector = { ...stubSourceConnector(), users }
    const counts = await countPhaseOnlySourceCounts(connector)
    assert.equal(counts.userGroups, 3, '2 memberships from user 1 + 1 from user 2 + 0 from user 3')
  })

  test('comments counts every source comment', async () => {
    async function* comments(): AsyncGenerator<SourceRecord> {
      yield { id: 1, pageId: 1, authorId: null, content: 'a' }
      yield { id: 2, pageId: 1, authorId: null, content: 'b' }
    }
    const connector = { ...stubSourceConnector(), comments }
    const counts = await countPhaseOnlySourceCounts(connector)
    assert.equal(counts.comments, 2)
  })

  test('userGroups reports not_implemented when users() itself is a stub, without touching comments', async () => {
    async function* comments(): AsyncGenerator<SourceRecord> {
      yield { id: 1, pageId: 1, authorId: null, content: 'a' }
    }
    const connector = { ...stubSourceConnector(), comments }
    const counts = await countPhaseOnlySourceCounts(connector)
    assert.equal(counts.userGroups, 'not_implemented')
    assert.equal(counts.comments, 1)
  })

  test('a real (non-stub) error propagates rather than being swallowed', async () => {
    const connector = stubSourceConnector()
    connector.comments = () => {
      throw new Error('connection reset')
    }
    await assert.rejects(() => countPhaseOnlySourceCounts(connector), /connection reset/)
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

  test('groups: source reporting two system groups against a destination seeded with three matches', () => {
    // 2.x skips two isSystem source groups (Administrators, Guests); 3.0 seeds three
    // (Administrators, Users, Guests) — see task 1813 / EXPECTED_COUNT_DELTA's doc comment.
    const results = compareEntityCounts(
      { users: 0, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { users: 0, groups: 3, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 }
    )
    const groups = results.find((r) => r.entity === 'groups')!
    assert.equal(groups.status, 'match')
    assert.equal(groups.sourceCount, 2)
    assert.equal(groups.destinationCount, 3)
  })

  test('groups: a destination two groups off the expected +1 delta still reports mismatch', () => {
    const results = compareEntityCounts(
      { users: 0, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { users: 0, groups: 5, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 }
    )
    const groups = results.find((r) => r.entity === 'groups')!
    assert.equal(groups.status, 'mismatch')
  })

  test('users: matching behaviour is unchanged (expected delta stays 0)', () => {
    const matching = compareEntityCounts(
      { users: 5, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { users: 5, groups: 3, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 }
    )
    assert.equal(matching.find((r) => r.entity === 'users')!.status, 'match')

    const mismatching = compareEntityCounts(
      { users: 5, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { users: 4, groups: 3, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 }
    )
    assert.equal(mismatching.find((r) => r.entity === 'users')!.status, 'mismatch')
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
})

describe('compareAgainstDryRunReports', () => {
  function report(phase: PhaseReport['phase'], found: number): PhaseReport {
    return { phase, found, wouldCreate: found, wouldSkipExisting: 0, conflicts: [], unmappable: [] }
  }

  // -> No memberships/comments in play for these tests — they exercise the pages/pageHistory/tags/
  //    users/groups arithmetic these already covered before Critical #2's fix, unaffected by it.
  const ZERO_PHASE_ONLY: PhaseOnlySourceCounts = { userGroups: 0, comments: 0 }

  test('matches when the live sum for a phase equals the captured report', () => {
    const results = compareAgainstDryRunReports(
      { users: 3, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      ZERO_PHASE_ONLY,
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
      ZERO_PHASE_ONLY,
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
      ZERO_PHASE_ONLY,
      [report('users', 5)]
    )
    const users = results.find((r) => r.phase === 'users')!
    assert.equal(users.status, 'live_not_implemented')
    assert.equal(users.liveFound, null)
  })

  test('reports no_report when no captured report names that phase', () => {
    const results = compareAgainstDryRunReports(
      { users: 3, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      ZERO_PHASE_ONLY,
      []
    )
    const users = results.find((r) => r.phase === 'users')!
    assert.equal(users.status, 'no_report')
  })

  test('sums only pages (not pageHistory/tags) plus the site-navigation sentinel for the content phase, matching PhaseReport.found granularity post-Task-13', () => {
    // -> Task 13's content-staging rewrite folded pageHistory/tags into the `pages` entity and added a
    //    one-record `site-navigation` sentinel (see verify.ts's ENTITY_OWNING_PHASE and
    //    PHASE_FOUND_SENTINEL_OFFSET doc comments) — so a real `content` PhaseReport.found is
    //    `pagesFound + 1`, not `pages + pageHistory + tags`. pageHistory/tags carry large,
    //    unrelated-scale live counts here specifically to prove they're no longer summed in.
    const results = compareAgainstDryRunReports(
      { users: 0, groups: 0, pages: 4, pageHistory: 700, tags: 100, assets: 0, navigation: 0 },
      ZERO_PHASE_ONLY,
      [report('content', 5)]
    )
    const content = results.find((r) => r.phase === 'content')!
    assert.equal(content.liveFound, 5)
    assert.equal(content.status, 'match')
  })

  test('does not report live_not_implemented for the content phase when only pageHistory/tags are stubs, since neither is owned any more', () => {
    const results = compareAgainstDryRunReports(
      {
        users: 0,
        groups: 0,
        pages: 4,
        pageHistory: 'not_implemented',
        tags: 'not_implemented',
        assets: 0,
        navigation: 0
      },
      ZERO_PHASE_ONLY,
      [report('content', 5)]
    )
    const content = results.find((r) => r.phase === 'content')!
    assert.equal(content.liveFound, 5)
    assert.equal(content.status, 'match')
  })

  test('flags a real content-phase mismatch even with the sentinel offset applied', () => {
    const results = compareAgainstDryRunReports(
      { users: 0, groups: 0, pages: 4, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      ZERO_PHASE_ONLY,
      [report('content', 999)]
    )
    const content = results.find((r) => r.phase === 'content')!
    assert.equal(content.liveFound, 5)
    assert.equal(content.status, 'mismatch')
  })

  test('covers every phase an entity is currently wired to (settings has none)', () => {
    const results = compareAgainstDryRunReports(
      { users: 0, groups: 0, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      ZERO_PHASE_ONLY,
      []
    )
    const phases = results.map((r) => r.phase).sort()
    assert.deepEqual(phases, ['assets', 'content', 'users'])
  })

  /**
   * Whole-branch review Critical #2, the `users` phase half: `PhaseReport.found` for `users` is
   * `groups + users + userGroups` (a third `userGroups` entity was added after the entity-owning-phase
   * table was written), but before this fix `liveFound` only summed `sourceCounts.users +
   * sourceCounts.groups` — mismatching whenever any user belongs to any group.
   */
  test('folds userGroups (the users phase third entity) into liveFound — Critical #2', () => {
    const results = compareAgainstDryRunReports(
      { users: 3, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { userGroups: 4, comments: 0 },
      [report('users', 9)] // -> groups(2) + users(3) + userGroups(4) = 9, matching a real PhaseReport.found
    )
    const users = results.find((r) => r.phase === 'users')!
    assert.equal(users.liveFound, 9)
    assert.equal(users.status, 'match')
    // -> Without the fix, liveFound would have been 5 (users+groups only), reporting a spurious
    //    mismatch against a real found of 9.
  })

  /**
   * Whole-branch review Critical #2, the `assets` phase half: `PhaseReport.found` for `assets` is
   * `assets + comments` (a `comments` entity was added, but `comments` was never added to
   * `VERIFY_ENTITIES`), so before this fix `liveFound` only counted `sourceCounts.assets` —
   * mismatching whenever the source has any comments.
   */
  test('folds comments (the assets phase second entity) into liveFound — Critical #2', () => {
    const results = compareAgainstDryRunReports(
      { users: 0, groups: 0, pages: 0, pageHistory: 0, tags: 0, assets: 1, navigation: 0 },
      { userGroups: 0, comments: 2 },
      [report('assets', 3)] // -> assets(1) + comments(2) = 3, matching a real PhaseReport.found
    )
    const assets = results.find((r) => r.phase === 'assets')!
    assert.equal(assets.liveFound, 3)
    assert.equal(assets.status, 'match')
  })

  test('reports live_not_implemented for the users phase when userGroups alone is a stub', () => {
    const results = compareAgainstDryRunReports(
      { users: 3, groups: 2, pages: 0, pageHistory: 0, tags: 0, assets: 0, navigation: 0 },
      { userGroups: 'not_implemented', comments: 0 },
      [report('users', 5)]
    )
    const users = results.find((r) => r.phase === 'users')!
    assert.equal(users.status, 'live_not_implemented')
    assert.equal(users.liveFound, null)
  })

  test('reports live_not_implemented for the assets phase when comments alone is a stub', () => {
    const results = compareAgainstDryRunReports(
      { users: 0, groups: 0, pages: 0, pageHistory: 0, tags: 0, assets: 1, navigation: 0 },
      { userGroups: 0, comments: 'not_implemented' },
      [report('assets', 1)]
    )
    const assets = results.find((r) => r.phase === 'assets')!
    assert.equal(assets.status, 'live_not_implemented')
    assert.equal(assets.liveFound, null)
  })
})

/**
 * The class of bug that let Critical #2 through in the first place: the tests above hand-feed
 * synthetic `found`/count numbers that already assume the correct arithmetic, which passes whether or
 * not `verify.ts` actually matches what the real phases report. This suite instead runs the REAL
 * `usersPhase`/`assetsPhase` (`dryRun: true`, so no live `WIKI`/db needed — `createDryRunWriter()`/each
 * phase's own placeholder-id branch handles it) against a fixture connector, and asserts
 * `compareAgainstDryRunReports` reports `'match'` against the resulting REAL `PhaseReport`s — so a
 * future entity added to either phase without a matching `verify.ts` update fails this suite instead of
 * silently passing the way the stale two-entity-shape tests did.
 */
describe('compareAgainstDryRunReports derived from the real phases (regression coverage for Critical #2)', () => {
  test('users phase: groups + users + userGroups matches liveFound derived from the same source', async () => {
    async function* groups(): AsyncGenerator<SourceRecord> {
      yield { id: 1, name: 'Editors', isSystem: false, permissions: [], pageRules: [] }
    }
    async function* users(): AsyncGenerator<SourceRecord> {
      yield {
        id: 10,
        email: 'alice@example.com',
        name: 'Alice',
        providerKey: 'local',
        password: '$2a$12$fakehash',
        isActive: true,
        isVerified: true,
        groups: [{ id: 1, name: 'Editors' }]
      }
      yield {
        id: 11,
        email: 'bob@example.com',
        name: 'Bob',
        providerKey: 'local',
        password: '$2a$12$fakehash',
        isActive: true,
        isVerified: true,
        groups: [{ id: 1, name: 'Editors' }]
      }
    }
    const connector = stubSourceConnector({ groups, users })

    const phaseResult = await usersPhase.run({
      db: {} as any,
      source: connector,
      siteId: 'test-site',
      dryRun: true,
      localStrategyId: 'test-local-strategy-uuid',
      systemGroupIds: { admin: 'test-admin-group-uuid', guest: 'test-guest-group-uuid' },
      operatorActorId: 'test-operator-uuid'
    })
    assert.equal(phaseResult.status, 'ok')
    assert.ok(phaseResult.report)

    const sourceCounts = await countSourceEntities(connector)
    const phaseOnlyCounts = await countPhaseOnlySourceCounts(connector)
    const comparisons = compareAgainstDryRunReports(sourceCounts, phaseOnlyCounts, [
      phaseResult.report!
    ])
    const users_ = comparisons.find((c) => c.phase === 'users')!
    assert.equal(
      users_.liveFound,
      phaseResult.report!.found,
      'liveFound derived from the source matches the real PhaseReport.found the phase actually produced'
    )
    assert.equal(users_.status, 'match')
  })

  test('assets phase: assets + comments matches liveFound derived from the same source', async () => {
    async function* assets(): AsyncGenerator<SourceAssetFile> {
      yield {
        relativePath: 'diagram.png',
        filename: 'diagram.png',
        stream: Readable.from([Buffer.from('fake-image-bytes')]),
        authorId: undefined,
        mimeType: 'image/png'
      }
    }
    async function* comments(): AsyncGenerator<SourceRecord> {
      yield { id: 1, pageId: 100, authorId: null, content: 'Nice page!' }
      yield { id: 2, pageId: 100, authorId: null, content: 'Agreed!' }
    }
    const connector = stubSourceConnector({ comments, assets })

    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'fixture-page-uuid')

    const phaseResult = await assetsPhase.run({
      db: {} as any,
      source: connector,
      siteId: 'test-site',
      dryRun: true,
      localStrategyId: 'test-local-strategy-uuid',
      systemGroupIds: { admin: 'test-admin-group-uuid', guest: 'test-guest-group-uuid' },
      operatorActorId: 'test-operator-uuid',
      pageIdMap
    })
    assert.equal(phaseResult.status, 'ok')
    assert.ok(phaseResult.report)

    const sourceCounts = await countSourceEntities(connector)
    const phaseOnlyCounts = await countPhaseOnlySourceCounts(connector)
    const comparisons = compareAgainstDryRunReports(sourceCounts, phaseOnlyCounts, [
      phaseResult.report!
    ])
    const assets_ = comparisons.find((c) => c.phase === 'assets')!
    assert.equal(
      assets_.liveFound,
      phaseResult.report!.found,
      'liveFound derived from the source matches the real PhaseReport.found the phase actually produced'
    )
    assert.equal(assets_.status, 'match')
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
    const results = await runContentSpotCheck(stubSourceConnector(), fakeLookup({}), {
      siteId: 'site-1',
      sampleSize: 5
    })
    assert.deepEqual(results, [{ path: '(all pages)', status: 'source_not_implemented' }])
  })

  test('matches when source and destination content hash the same', async () => {
    async function* pages(): AsyncGenerator<SourceRecord> {
      yield { id: 1, path: 'en/home', localeCode: 'en', content: '# hello' }
    }
    const connector = { ...stubSourceConnector(), pages }
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
    const connector = { ...stubSourceConnector(), pages }
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
    const connector = { ...stubSourceConnector(), pages }
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
    const connector = { ...stubSourceConnector(), pages }
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
    const connector = { ...stubSourceConnector(), pages }
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
    const connector: SourceConnector = { ...stubSourceConnector(), pages }
    assert.throws(() => connector.assets() as AsyncIterable<SourceAssetFile>)
    const results = await runContentSpotCheck(connector, fakeLookup({ 'en/home': 'x' }), {
      siteId: 'site-1',
      paths: ['en/home']
    })
    assert.equal(results[0].status, 'match')
  })

  test('normalizes an uppercase/underscored 2.x source path before the destination lookup', async () => {
    // The source path is exactly what a real 2.x row would carry -- uppercase segments and an
    // underscore -- while the destination is keyed the way `page-import.ts`/`normalizeMigratedPath`
    // actually wrote it on import: lowercased, underscores folded to hyphens. An unnormalized lookup
    // would miss this row entirely and report `destination_missing`.
    async function* pages(): AsyncGenerator<SourceRecord> {
      yield { id: 1, path: 'Guide/Getting_Started', localeCode: 'en', content: '# intro' }
    }
    const connector = { ...stubSourceConnector(), pages }
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
    const connector = { ...stubSourceConnector(), pages }
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
