import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import { assetsPhase } from './assets.ts'
import { contentPhase } from './content.ts'
import { settingsPhase } from './settings.ts'
import { usersPhase } from './users.ts'
import { MIGRATION_PHASES, MIGRATION_PHASE_IDS } from './index.ts'
import { MAX_NAME_ATTEMPTS } from '../../models/tree.ts'
import type { MigrationContext } from '../context.ts'
import type { SourceAssetFile, SourceConnector, SourceRecord } from '../connector.ts'
import { stubSourceConnector } from '../../test/migrationFixtures.ts'

/** Bare records — enough for a phase to count; nothing about their shape matters. */
async function* recordsOf(count: number): AsyncGenerator<SourceRecord> {
  for (let i = 0; i < count; i++) {
    yield { id: i }
  }
}

/** Every entity generator throws `NotYetImplementedError`. */
function stubConnector(): SourceConnector {
  return stubSourceConnector()
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

/** Records that genuinely convert and would be created — unlike `workingConnector`'s bare fixtures,
 * which carry no `name`/`providerKey` and are always `skipped`/`flagged` before a writer call. Use
 * with `dryRun: true`, so real `'created'` outcomes are exercised with no `CARDINAL`/db needed. */
function creatableUsersGroupsConnector(): SourceConnector {
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
      providerKey: 'github',
      isActive: true,
      isVerified: true,
      groups: []
    }
  }
  return { ...stubConnector(), groups, users }
}

function contextWith(source: SourceConnector): MigrationContext {
  return {
    db: {} as any,
    source,
    siteId: 'test-site',
    dryRun: false,
    // Real-shaped but never exercised: nothing these tests read reaches a `CARDINAL`/db-touching
    // writer method. `phases/users.integration.test.ts` covers the real write path.
    localStrategyId: 'test-local-strategy-uuid',
    systemGroupIds: { admin: 'test-admin-group-uuid', guest: 'test-guest-group-uuid' },
    operatorActorId: 'test-operator-uuid'
  }
}

/** Enough of a 2.x page row for `stagePage()` to produce a `StagedPage` whose `path` normalizes —
 * `recordsOf()`'s bare fixtures stage to an empty path and always fail with `'empty-path'`. */
function fakeSourcePage(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 1,
    path: 'welcome',
    localeCode: 'en',
    title: 'Welcome',
    hash: 'hash-1',
    description: null,
    content: '# Welcome',
    render: '<h1>Welcome</h1>',
    toc: null,
    contentType: 'markdown',
    isPrivate: false,
    privateNS: null,
    isPublished: true,
    publishStartDate: null,
    publishEndDate: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    extra: {},
    editorKey: 'markdown',
    tags: [],
    authorId: null,
    creatorId: null,
    ...overrides
  }
}

/** Pages that genuinely stage, normalize and would be created; `pageHistory()`/`navigation()` work
 * but yield nothing. Use with `dryRun: true`, so every dependency takes its placeholder/no-op branch
 * and real `'created'` outcomes are exercised with no `CARDINAL`/db needed. */
function creatableContentConnector(pages: SourceRecord[] = [fakeSourcePage()]): SourceConnector {
  async function* pagesGen(): AsyncGenerator<SourceRecord> {
    yield* pages
  }
  async function* pageHistoryGen(): AsyncGenerator<SourceRecord> {
    // -> Deliberately empty: nothing to merge.
  }
  async function* navigationGen(): AsyncGenerator<SourceRecord> {
    // -> Deliberately empty: nothing to import.
  }
  return {
    ...stubConnector(),
    pages: pagesGen,
    pageHistory: pageHistoryGen,
    navigation: navigationGen
  }
}

/** Rows that genuinely import: one nested-folder asset with a mapped author, and two comments — one
 * on an already-imported page, one whose `pageId` names a page that was never imported. Use with
 * `dryRun: true`, so the write closures take their placeholder-id branch and never touch `CARDINAL`. */
function creatableAssetsConnector(): SourceConnector {
  async function* assetsGen(): AsyncGenerator<SourceAssetFile> {
    yield {
      relativePath: 'docs/sub/diagram.png',
      filename: 'diagram.png',
      stream: Readable.from([Buffer.from('fake-image-bytes')]),
      authorId: 42,
      mimeType: 'image/png'
    }
  }
  async function* commentsGen(): AsyncGenerator<SourceRecord> {
    yield { id: 1, pageId: 100, authorId: 42, content: 'Great page!' }
    yield {
      id: 2,
      pageId: 999,
      authorId: null,
      content: 'Orphaned comment',
      name: 'Guest',
      email: 'guest@example.com'
    }
  }
  return { ...stubConnector(), assets: assetsGen, comments: commentsGen }
}

describe('migration phases', () => {
  test('phase order and declared dependencies match Feature 421 task 742', () => {
    assert.deepEqual(MIGRATION_PHASE_IDS, ['settings', 'users', 'content', 'assets'])
    assert.deepEqual(settingsPhase.dependsOn, [])
    assert.deepEqual(usersPhase.dependsOn, ['settings'])
    assert.deepEqual(contentPhase.dependsOn, ['users'])
    assert.deepEqual(assetsPhase.dependsOn, ['content'])
    assert.equal(MIGRATION_PHASES.length, 4)
  })

  test('settingsPhase reports not_implemented against the current connector stubs', async () => {
    const result = await settingsPhase.run(contextWith(stubConnector()))
    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.notImplemented, ['settings'])
    assert.equal(result.phase, 'settings')
  })

  test('usersPhase (Task 14): a working connector with genuinely creatable groups/users/userGroups reports ok', async () => {
    const result = await usersPhase.run({
      ...contextWith(creatableUsersGroupsConnector()),
      dryRun: true
    })
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.counts, { groups: 1, users: 2, userGroups: 1 })
    assert.equal(result.notImplemented, undefined)
  })

  test('usersPhase: bare records with no name/providerKey are counted but never created, and only a still-stubbed entity generator is reported not_implemented', async () => {
    const result = await usersPhase.run(contextWith(workingConnector({ users: 5 })))
    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.counts, { users: 5, userGroups: 0 })
    assert.deepEqual(result.notImplemented, ['groups'])
    assert.equal(result.report!.wouldCreate, 0)
    assert.equal(result.report!.wouldSkipExisting, 5)
  })

  test('contentPhase reports not_implemented against the current connector stubs (both entities)', async () => {
    const result = await contentPhase.run(contextWith(stubConnector()))
    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.notImplemented, ['pages', 'navigation'])
  })

  test('contentPhase (Task 13): a working connector with a genuinely creatable page reports ok, and the navigation entity runs once pages has drained', async () => {
    const result = await contentPhase.run({
      ...contextWith(creatableContentConnector()),
      dryRun: true
    })
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.counts, { pages: 1, navigation: 1 })
    assert.equal(result.notImplemented, undefined)
    assert.ok(result.report)
    assert.equal(result.report!.found, 2)
    assert.equal(result.report!.wouldCreate, 2)
    assert.equal(result.report!.wouldSkipExisting, 0)
    assert.deepEqual(result.report!.conflicts, [])
  })

  test("contentPhase: a page that fails to import (sibling-collision) is not misreported as wouldCreate (Task 13 proactive fix, mirroring Task 14's review fix for users)", async () => {
    // -> page-import.ts retries a sibling collision with a numeric suffix up to MAX_NAME_ATTEMPTS
    //    times, so exhausting every attempt takes MAX_NAME_ATTEMPTS + 2 colliding pages: the first
    //    claims the bare name, the next MAX_NAME_ATTEMPTS claim every suffixed variant, and the last
    //    finds nothing left and fails. importOne() returns that failure rather than throwing, which
    //    is what makes misreporting it as wouldCreate possible.
    const pages = Array.from({ length: MAX_NAME_ATTEMPTS + 2 }, (_unused, i) =>
      fakeSourcePage({ id: i + 1, path: 'FooBar' })
    )
    const result = await contentPhase.run({
      ...contextWith(creatableContentConnector(pages)),
      dryRun: true
    })
    assert.equal(result.status, 'ok')
    assert.ok(result.report)
    // -> Every colliding page + 1 navigation sentinel.
    assert.equal(result.report!.found, MAX_NAME_ATTEMPTS + 3)
    // -> The bare name, every suffixed retry and navigation are created; only the last page, which
    //    finds every suffix up to the cap claimed, conflicts.
    assert.equal(result.report!.wouldCreate, MAX_NAME_ATTEMPTS + 2)
    assert.equal(result.report!.wouldSkipExisting, 0)
    assert.equal(result.report!.conflicts.length, 1)
    assert.equal(result.report!.conflicts[0]!.identifier, String(MAX_NAME_ATTEMPTS + 2))
    assert.match(result.report!.conflicts[0]!.detail, /sibling-collision|same tree location/)
  })

  test('contentPhase: a navigation item with an invalid/unvalidated target is blanked with a warning, not a thrown error that aborts the phase (review fix)', async () => {
    // -> mapNavigationItem() carries an 'external' target through unvalidated, and a schemeless one
    //    makes the real setNavItems() throw. readEntity() special-cases only NotYetImplementedError,
    //    so an unsanitized throw here fails the WHOLE phase with an emptied report.
    async function* pages(): AsyncGenerator<SourceRecord> {}
    async function* pageHistory(): AsyncGenerator<SourceRecord> {}
    async function* navigation(): AsyncGenerator<SourceRecord> {
      yield {
        key: 'site',
        config: [
          {
            id: 'bad-external',
            kind: 'link',
            label: 'Bad External Link',
            targetType: 'external',
            target: 'example.com' // -> no scheme: fails isFollowableRedirectTarget()
          }
        ]
      }
    }
    const connector = { ...stubConnector(), pages, pageHistory, navigation }
    const logs: string[] = []
    const result = await contentPhase.run({
      ...contextWith(connector),
      dryRun: true,
      log: (message) => logs.push(message)
    })
    assert.equal(result.status, 'ok')
    assert.ok(
      logs.some((message) => message.includes('Bad External Link') && message.includes('blanked')),
      'a warning naming the blanked item was logged'
    )
  })

  test('assetsPhase (Task 16): bare records with no real stream all conflict, and only the still-stubbed comments generator is reported not_implemented', async () => {
    // -> The bare fixtures have no `stream` for importAsset() to read, so every one fails
    //    'read-error' and is routed to recorder.conflict(), never recorder.create(). `dryRun: true`
    //    is what keeps `entities()` construction CARDINAL-free; this test has no live global.
    const result = await assetsPhase.run({
      ...contextWith(workingConnector({ assets: 9 })),
      dryRun: true
    })
    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.counts, { assets: 9 })
    assert.deepEqual(result.notImplemented, ['comments'])
    assert.equal(result.report!.wouldCreate, 0)
    assert.equal(result.report!.conflicts.length, 9)
  })

  test('assetsPhase (Task 16): a working connector with a genuinely importable asset and comments reports ok, correctly distinguishing success from failure per record', async () => {
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'fixture-page-uuid')
    const result = await assetsPhase.run({
      ...contextWith(creatableAssetsConnector()),
      dryRun: true,
      userIdMap: new Map([[42, 'fixture-user-uuid']]),
      pageIdMap
    })
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.counts, { assets: 1, comments: 2 })
    assert.equal(result.notImplemented, undefined)
    assert.ok(result.report)
    assert.equal(result.report!.found, 3)
    // -> the asset + the comment on the already-imported page; the other comment conflicts.
    assert.equal(result.report!.wouldCreate, 2)
    assert.equal(result.report!.wouldSkipExisting, 0)
    assert.equal(result.report!.conflicts.length, 1)
    assert.equal(result.report!.conflicts[0]!.identifier, '2')
    assert.match(result.report!.conflicts[0]!.detail, /pageId 999 was never imported/)
    assert.deepEqual(result.report!.unmappable, [])
  })

  test('assetsPhase (Task 16): an asset whose authorId has no entry in the user id map falls back to the operator actor with a logged warning, rather than failing the import', async () => {
    async function* assetsGen(): AsyncGenerator<SourceAssetFile> {
      yield {
        relativePath: 'orphan.txt',
        filename: 'orphan.txt',
        stream: Readable.from([Buffer.from('hello')]),
        authorId: 777 // -> not in userIdMap
      }
    }
    async function* commentsGen(): AsyncGenerator<SourceRecord> {
      // -> Deliberately empty: this test is about the asset entity only.
    }
    const connector = { ...stubConnector(), assets: assetsGen, comments: commentsGen }
    const logs: string[] = []
    const result = await assetsPhase.run({
      ...contextWith(connector),
      dryRun: true,
      log: (message) => logs.push(message)
    })
    assert.equal(result.status, 'ok')
    assert.equal(result.report!.wouldCreate, 1)
    assert.equal(result.report!.conflicts.length, 0)
    assert.ok(
      logs.some(
        (message) =>
          message.includes('orphan.txt') && message.includes('falling back to the operator actor')
      ),
      'the operator-fallback warning was logged'
    )
  })

  test('a real (non-stub) error surfaces as status "error" rather than not_implemented', async () => {
    const connector = stubConnector()
    connector.settings = () => {
      throw new Error('connection reset')
    }
    const result = await settingsPhase.run(contextWith(connector))
    assert.equal(result.status, 'error')
    assert.deepEqual(result.errors, ['connection reset'])
  })

  test('every phase reports a non-negative durationMs', async () => {
    const result = await settingsPhase.run(contextWith(stubConnector()))
    assert.ok(result.durationMs >= 0)
  })

  test('report.found equals wouldCreate + unmappable.length when nothing is skipped/conflicting', async () => {
    const result = await usersPhase.run({
      ...contextWith(creatableUsersGroupsConnector()),
      dryRun: true
    })
    assert.ok(result.report)
    assert.equal(result.report!.found, 4)
    assert.equal(result.report!.wouldCreate, 4)
    assert.equal(result.report!.wouldSkipExisting, 0)
    assert.deepEqual(result.report!.conflicts, [])
    assert.deepEqual(result.report!.unmappable, [])
  })

  test('usersPhase classifies an unsupported auth provider as unmappable; a flagged record is not counted as wouldCreate either (Task 14 review fix)', async () => {
    async function* users(): AsyncGenerator<SourceRecord> {
      // Alice is a local-provider user with no password hash to carry over, so her converter flags
      // rather than creates her; Bob's provider has no 3.0 destination at all.
      yield { id: 1, email: 'alice@example.com', providerKey: 'local' }
      yield { id: 2, email: 'bob@example.com', providerKey: 'azure' }
    }
    const connector = { ...stubConnector(), users, groups: () => recordsOf(0) }
    const result = await usersPhase.run(contextWith(connector))
    // -> Every entity generator here is real, so the phase is ok even though nothing is created —
    //    the report, not the status, is what says so.
    assert.equal(result.status, 'ok')
    assert.ok(result.report)
    assert.equal(result.report!.found, 2)
    assert.equal(result.report!.wouldCreate, 0)
    assert.equal(result.report!.wouldSkipExisting, 1)
    assert.deepEqual(result.report!.unmappable, [
      {
        identifier: 'bob@example.com',
        reason: 'unsupported-auth-provider',
        detail:
          'providerKey "azure" has no matching 3.0 authentication module (confirmed no-destination — see docs/migration/2.5x-settings-auth-storage-field-mapping.md\'s Part 2 provider inventory).'
      }
    ])
  })

  test('usersPhase: a genuinely created record alongside an unmappable one both count correctly, and the phase reports ok', async () => {
    async function* users(): AsyncGenerator<SourceRecord> {
      yield {
        id: 1,
        email: 'alice@example.com',
        name: 'Alice',
        providerKey: 'local',
        password: '$2a$12$fakehash',
        isActive: true,
        isVerified: true,
        groups: []
      }
      yield { id: 2, email: 'bob@example.com', providerKey: 'azure' }
    }
    const connector = { ...stubConnector(), users, groups: () => recordsOf(0) }
    const result = await usersPhase.run({ ...contextWith(connector), dryRun: true })
    assert.equal(result.status, 'ok')
    assert.ok(result.report)
    assert.equal(result.report!.found, 2)
    assert.equal(result.report!.wouldCreate, 1) // -> Alice only; Bob is unmappable, never wouldCreate
    assert.deepEqual(result.report!.unmappable, [
      {
        identifier: 'bob@example.com',
        reason: 'unsupported-auth-provider',
        detail:
          'providerKey "azure" has no matching 3.0 authentication module (confirmed no-destination — see docs/migration/2.5x-settings-auth-storage-field-mapping.md\'s Part 2 provider inventory).'
      }
    ])
  })

  test('a phase that errors out reports an empty report rather than a stale/partial one', async () => {
    const connector = stubConnector()
    connector.settings = () => {
      throw new Error('connection reset')
    }
    const result = await settingsPhase.run(contextWith(connector))
    assert.deepEqual(result.report, {
      phase: 'settings',
      found: 0,
      wouldCreate: 0,
      wouldSkipExisting: 0,
      conflicts: [],
      unmappable: []
    })
  })

  test('dry run vs. live run produce the same report shape (no real writes exist yet either way)', async () => {
    const dryRunResult = await usersPhase.run({
      ...contextWith(workingConnector({ users: 2, groups: 1 })),
      dryRun: true
    })
    const liveResult = await usersPhase.run({
      ...contextWith(workingConnector({ users: 2, groups: 1 })),
      dryRun: false
    })
    assert.deepEqual(dryRunResult.report, liveResult.report)
  })
})
