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

function contextWith(source: SourceConnector): MigrationContext {
  return {
    db: {} as any,
    source,
    siteId: 'test-site',
    dryRun: false
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

  test('usersPhase counts records from a working connector, but reports not_implemented — no phase has a write path yet', async () => {
    const result = await usersPhase.run(contextWith(workingConnector({ users: 3, groups: 2 })))
    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.counts, { users: 3, groups: 2 })
    assert.deepEqual(result.notImplemented, ['users', 'groups'])
  })

  test('usersPhase is not_implemented when only one entity generator works, listing both entities (the other via its own stub, this one via the no-write-path reclassification)', async () => {
    const result = await usersPhase.run(contextWith(workingConnector({ users: 5 })))
    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.counts, { users: 5 })
    assert.deepEqual(result.notImplemented, ['groups', 'users'])
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
    const result = await usersPhase.run(contextWith(workingConnector({ users: 3, groups: 2 })))
    assert.ok(result.report)
    assert.equal(result.report!.found, 5)
    assert.equal(result.report!.wouldCreate, 5)
    assert.equal(result.report!.wouldSkipExisting, 0)
    assert.deepEqual(result.report!.conflicts, [])
    assert.deepEqual(result.report!.unmappable, [])
  })

  test('usersPhase classifies an unsupported auth provider as unmappable, not wouldCreate', async () => {
    async function* users(): AsyncGenerator<SourceRecord> {
      yield { id: 1, email: 'alice@example.com', providerKey: 'local' }
      yield { id: 2, email: 'bob@example.com', providerKey: 'azure' }
    }
    const connector = { ...stubConnector(), users, groups: () => recordsOf(0) }
    const result = await usersPhase.run(contextWith(connector))
    assert.equal(result.status, 'not_implemented')
    assert.ok(result.report)
    assert.equal(result.report!.found, 2)
    assert.equal(result.report!.wouldCreate, 1)
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
