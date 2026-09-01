import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { NotYetImplementedError } from '../connector.ts'
import { assetsPhase } from './assets.ts'
import { contentPhase } from './content.ts'
import { settingsPhase } from './settings.ts'
import { usersPhase } from './users.ts'
import { MIGRATION_PHASES, MIGRATION_PHASE_IDS } from './index.ts'
import type { MigrationContext } from '../context.ts'
import type { SourceConnector, SourceRecord } from '../connector.ts'

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

  test('usersPhase: bare records with no name/providerKey never reach a real create, so a run producing none stays not_implemented even once every entity generator works (Task 14 review fix)', async () => {
    // -> Before the review fix, `phases/users.ts` counted every record `recorder.create()` was
    //    handed as a create regardless of the importer's real per-record outcome, so this run's
    //    bare `{id: i}` fixtures (no `name`/`providerKey`, so every one is `skipped`/`flagged`, never
    //    `created`) looked exactly like a phase with real write capability. Corrected, zero records
    //    are genuinely created here, so `define-phase.ts`'s write-capability tracking (a per-run
    //    signal, not a structural one — see `phases/users.ts`'s own doc on this) folds `users` and
    //    `userGroups` in alongside `groups`, which is `not_implemented` anyway (its connector
    //    generator is still a stub in this fixture).
    const result = await usersPhase.run(contextWith(workingConnector({ users: 5 })))
    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.counts, { users: 5, userGroups: 0 })
    assert.deepEqual(result.notImplemented, ['groups', 'users', 'userGroups'])
  })

  test('contentPhase counts pages, pageHistory and tags, but reports not_implemented — no phase has a write path yet', async () => {
    const result = await contentPhase.run(
      contextWith(workingConnector({ pages: 4, pageHistory: 7, tags: 1 }))
    )
    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.counts, { pages: 4, pageHistory: 7, tags: 1 })
    assert.deepEqual(result.notImplemented, ['pages', 'pageHistory', 'tags'])
  })

  test('assetsPhase counts assets, but reports not_implemented — no phase has a write path yet', async () => {
    const result = await assetsPhase.run(contextWith(workingConnector({ assets: 9 })))
    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.counts, { assets: 9 })
    assert.deepEqual(result.notImplemented, ['assets'])
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
      // (`user-converters.ts`) flags rather than creates her. Before the review fix, `phases/users.ts`
      // counted her as `wouldCreate` regardless (every `recorder.create()` call it made counted
      // unconditionally, since the importer's real per-record outcome was discarded) -- this is the
      // exact case the fix corrects.
      yield { id: 1, email: 'alice@example.com', providerKey: 'local' }
      yield { id: 2, email: 'bob@example.com', providerKey: 'azure' }
    }
    const connector = { ...stubConnector(), users, groups: () => recordsOf(0) }
    const result = await usersPhase.run(contextWith(connector))
    // -> Neither Alice (flagged) nor Bob (unmappable) is ever created, so this particular run has no
    //    genuine write-capability signal to give `define-phase.ts` -- see the `bare records...` test
    //    above for the same, pre-existing, per-run (not structural) heuristic.
    assert.equal(result.status, 'not_implemented')
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

  test('assetsPhase always reports comments as unmappable (no connector read path)', async () => {
    const result = await assetsPhase.run(contextWith(stubConnector()))
    assert.ok(result.report)
    assert.deepEqual(result.report!.unmappable, [
      {
        identifier: 'comments',
        reason: 'no-destination-table',
        detail:
          'Wiki.js 3.0 has its own comments table, model, and API route, but this migration does not import 2.5.x comments because the SourceConnector interface has no comments() generator to read them through yet.'
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
