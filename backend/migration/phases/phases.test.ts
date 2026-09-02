import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import { NotYetImplementedError } from '../connector.ts'
import { assetsPhase } from './assets.ts'
import { contentPhase } from './content.ts'
import { settingsPhase } from './settings.ts'
import { usersPhase } from './users.ts'
import { MIGRATION_PHASES, MIGRATION_PHASE_IDS } from './index.ts'
import type { MigrationContext } from '../context.ts'
import type { SourceAssetFile, SourceConnector, SourceRecord } from '../connector.ts'

/** Yields `count` bare records — enough for a phase to count, nothing about their shape matters. */
async function* recordsOf(count: number): AsyncGenerator<SourceRecord> {
  for (let i = 0; i < count; i++) {
    yield { id: i }
  }
}

/** Every entity generator throws, matching both real connectors' current stub state. */
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
    comments: notImplemented('comments'),
    assets: notImplemented('assets')
  }
}

/** A connector with working generators, so a phase's `run()` can be exercised to `status: 'ok'`. */
function workingConnector(counts: Partial<Record<keyof SourceConnector, number>>): SourceConnector {
  const base = stubConnector()
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(counts).map(([entity, count]) => [entity, () => recordsOf(count!)])
    )
  } as SourceConnector
}

/** A `usersPhase` connector whose records genuinely convert and would be created — unlike
 * `workingConnector`'s bare `{id: i}` fixtures, which never carry a `name`/`providerKey` and so are
 * always `skipped`/`flagged` before reaching a writer call. Used (with `dryRun: true`, so
 * `createDryRunWriter()` is the writer in play — see `phases/users.ts`) to exercise real per-record
 * `'created'` outcomes, including write-capability signaling, with no real `WIKI`/db needed. */
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
    // Task 14: real values, but never actually exercised by these tests -- every record `usersPhase`
    // reads below either fails its own converter's requirements before a writer call (no `name`/no
    // `providerKey`) or is routed to `recorder.unmappable()`, so nothing here ever reaches
    // `createDrizzleWriter()`'s real `WIKI`/db-touching methods. See
    // `phases/users.integration.test.ts` for coverage of the real write path against a real DB.
    localStrategyId: 'test-local-strategy-uuid',
    systemGroupIds: { admin: 'test-admin-group-uuid', guest: 'test-guest-group-uuid' },
    operatorActorId: 'test-operator-uuid'
  }
}

/** A minimally-valid 2.x page row — enough for `content-staging.ts#stagePage()` to produce a
 * `StagedPage` whose `path` actually normalizes, unlike `recordsOf()`'s bare `{id: i}` fixtures (which
 * stage to an empty `path` and always fail `normalizeMigratedPath()` with `'empty-path'`). */
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

/** A `contentPhase` connector whose `pages()` row genuinely stages, normalizes and would be created —
 * unlike `workingConnector`'s bare `{id: i}` fixtures, which always fail `normalizeMigratedPath()`
 * with `'empty-path'` before ever reaching `createPage()`. `pageHistory()`/`navigation()` are working
 * but empty, so both entities read cleanly with nothing to merge/import. Used (with `dryRun: true`, so
 * every dependency's placeholder/no-op branch is in play — see `phases/content.ts`) to exercise real
 * per-record `'created'` outcomes, including write-capability signaling, with no real `WIKI`/db
 * needed. */
function creatableContentConnector(pages: SourceRecord[] = [fakeSourcePage()]): SourceConnector {
  async function* pagesGen(): AsyncGenerator<SourceRecord> {
    yield* pages
  }
  async function* pageHistoryGen(): AsyncGenerator<SourceRecord> {
    // -> Empty: no history rows to merge for this fixture.
  }
  async function* navigationGen(): AsyncGenerator<SourceRecord> {
    // -> Empty: nothing for importNavigation() to map.
  }
  return {
    ...stubConnector(),
    pages: pagesGen,
    pageHistory: pageHistoryGen,
    navigation: navigationGen
  }
}

/** An `assetsPhase` connector whose `assets()`/`comments()` rows genuinely import (Task 16): one
 * nested-folder asset with a mapped author, and two comments — one on an already-imported page, one
 * whose `pageId` names a page that was never imported. Used with `dryRun: true` (so `phases/assets.ts`'s
 * `assetsModel`/`treeModel`/`commentsModel` closures take their placeholder-id branch, never touching
 * the ambient `WIKI`) to exercise real per-record `'success'`/`'failure'` outcomes with no real `WIKI`/db
 * needed. */
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
    // -> These bare `{id: i}` fixtures have no `name`/`providerKey`, so every one is
    //    `skipped`/`flagged` by its converter and never `created` — read and counted all the same.
    //    Only `groups` is not_implemented, because its connector generator is still a stub in this
    //    fixture.
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
    // -> Before this fix, blindly wrapping pageImporter.importOne() as recorder.create()'s own write
    //    callback would have counted BOTH pages as wouldCreate, since importOne() never throws for a
    //    failed page (it returns a 'failed' outcome instead) and create() counts unconditionally.
    const pages = [
      fakeSourcePage({ id: 1, path: 'FooBar' }),
      fakeSourcePage({ id: 2, path: 'foobar' })
    ]
    const result = await contentPhase.run({
      ...contextWith(creatableContentConnector(pages)),
      dryRun: true
    })
    assert.equal(result.status, 'ok')
    assert.ok(result.report)
    // -> 2 pages + 1 navigation sentinel.
    assert.equal(result.report!.found, 3)
    // -> Page 1 (created) + navigation (created); page 2 is the sibling-collision conflict below.
    assert.equal(result.report!.wouldCreate, 2)
    assert.equal(result.report!.wouldSkipExisting, 0)
    assert.equal(result.report!.conflicts.length, 1)
    assert.equal(result.report!.conflicts[0]!.identifier, '2')
    assert.match(result.report!.conflicts[0]!.detail, /sibling-collision|same tree location/)
  })

  test('contentPhase: a navigation item with an invalid/unvalidated target is blanked with a warning, not a thrown error that aborts the phase (review fix)', async () => {
    // -> navigation-import.ts's mapNavigationItem() carries an 'external'/'externalblank' target
    //    through verbatim, unvalidated -- a schemeless target like this one would have made the real
    //    WIKI.models.navigation.setNavItems() throw CustomError('navigationInvalidTarget')
    //    (assertValidNavItems()), which define-phase.ts#readEntity() does not special-case the way it
    //    does NotYetImplementedError -- before the fix, this would have surfaced as the WHOLE phase
    //    reporting status: 'error' with an emptied report, discarding every already-imported page.
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
    // -> workingConnector's bare `{id: i}` fixtures have no `stream` for importAsset() to read, so
    //    every one fails 'read-error' before ever reaching a real upload() call -- routed to
    //    recorder.conflict(), never recorder.create(). `dryRun: true` (unlike `contextWith()`'s own
    //    `dryRun: false` default) for the same reason every other assetsPhase test in this file uses
    //    it: it is what keeps `entities()` construction fully WIKI-free (see `phases/assets.ts`'s own
    //    "Dry run" doc section, and `resolvePrimaryLocale()` in `context.ts`) — this test has no live
    //    `WIKI` global to read from, and doesn't need one either way, since no record here ever
    //    reaches a real write regardless of `dryRun`.
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
    // -> 1 asset + 2 comments.
    assert.equal(result.report!.found, 3)
    // -> the asset (mapped author, nested folder) + the comment on the already-imported page.
    assert.equal(result.report!.wouldCreate, 2)
    assert.equal(result.report!.wouldSkipExisting, 0)
    // -> the second comment's pageId (999) was never imported.
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
      // -> Empty: this test is only about the asset entity's fallback warning.
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
      // Alice: a local-provider user with no password hash to carry over -- `createLocalUserConverter`
      // (`users-groups.ts`) flags rather than creates her. Before the review fix, `phases/users.ts`
      // counted her as `wouldCreate` regardless (every `recorder.create()` call it made counted
      // unconditionally, since the importer's real per-record outcome was discarded) -- this is the
      // exact case the fix corrects.
      yield { id: 1, email: 'alice@example.com', providerKey: 'local' }
      yield { id: 2, email: 'bob@example.com', providerKey: 'azure' }
    }
    const connector = { ...stubConnector(), users, groups: () => recordsOf(0) }
    const result = await usersPhase.run(contextWith(connector))
    // -> Every entity generator here is real, so the phase reports ok even though neither Alice
    //    (flagged) nor Bob (unmappable) is ever created — the report, not the status, is what says so.
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
