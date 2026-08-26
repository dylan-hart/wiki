import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { NotYetImplementedError } from '../connector.ts'
import { assetsPhase } from './assets.ts'
import { contentPhase } from './content.ts'
import { settingsPhase } from './settings.ts'
import { usersPhase } from './users.ts'
import { MIGRATION_PHASES, MIGRATION_PHASE_IDS } from './index.ts'
import type { MigrationContext } from '../context.ts'
import type { SourceAssetFile, SourceConnector, SourceRecord } from '../connector.ts'
import type { MigrationRecord, ProvenanceStore } from '../provenance.ts'

/** A `ProvenanceStore` backed by plain arrays — same approach `../provenance.test.ts` uses, so these
 * phase tests never need a working `db`. `seed.records` pre-populates exact provenance mappings;
 * `seed.byEmail`/`byPath` pre-populate what a natural-key fallback would find, standing in for a row
 * that already exists at the destination from a prior (possibly interrupted) run. */
function fakeProvenanceStore(
  seed: {
    records?: MigrationRecord[]
    byEmail?: Record<string, string>
    byPath?: Record<string, string>
  } = {}
): ProvenanceStore & { records: MigrationRecord[] } {
  const records = [...(seed.records ?? [])]
  return {
    records,
    async find(key) {
      return records.find(
        (r) =>
          r.siteId === key.siteId &&
          r.sourceSystem === key.sourceSystem &&
          r.sourceTable === key.sourceTable &&
          r.sourceId === key.sourceId
      )
    },
    async record(entry) {
      records.push({ ...entry, importedAt: new Date() })
    },
    async findExistingUserByEmail(email) {
      return seed.byEmail?.[email]
    },
    async findExistingPageByPath(_siteId, _locale, path) {
      return seed.byPath?.[path]
    },
    async findExistingAssetByFolderAndFilename() {
      return undefined
    }
  }
}

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

function contextWith(source: SourceConnector, provenanceStore?: ProvenanceStore): MigrationContext {
  return {
    db: {} as any,
    source,
    siteId: 'test-site',
    dryRun: false,
    provenanceStore: provenanceStore ?? fakeProvenanceStore(),
    updateExisting: false
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

  test('usersPhase counts records from a working connector', async () => {
    const result = await usersPhase.run(contextWith(workingConnector({ users: 3, groups: 2 })))
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.counts, { users: 3, groups: 2 })
  })

  test('usersPhase is partially not_implemented when only one entity generator works', async () => {
    const result = await usersPhase.run(contextWith(workingConnector({ users: 5 })))
    assert.equal(result.status, 'not_implemented')
    assert.deepEqual(result.counts, { users: 5 })
    assert.deepEqual(result.notImplemented, ['groups'])
  })

  test('contentPhase counts pages, pageHistory and tags', async () => {
    const result = await contentPhase.run(
      contextWith(workingConnector({ pages: 4, pageHistory: 7, tags: 1 }))
    )
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.counts, { pages: 4, pageHistory: 7, tags: 1 })
  })

  test('assetsPhase counts assets', async () => {
    const result = await assetsPhase.run(contextWith(workingConnector({ assets: 9 })))
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.counts, { assets: 9 })
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
      yield { id: 2, email: 'bob@example.com', providerKey: 'ldap' }
    }
    const connector = { ...stubConnector(), users, groups: () => recordsOf(0) }
    const result = await usersPhase.run(contextWith(connector))
    assert.equal(result.status, 'ok')
    assert.ok(result.report)
    assert.equal(result.report!.found, 2)
    assert.equal(result.report!.wouldCreate, 1)
    assert.deepEqual(result.report!.unmappable, [
      {
        identifier: 'bob@example.com',
        reason: 'unsupported-auth-provider',
        detail:
          'providerKey "ldap" has no matching 3.0 authentication module (3.0 ships local/google/github/oidc only).'
      }
    ])
  })

  test('assetsPhase always reports comments as unmappable (no destination table)', async () => {
    const result = await assetsPhase.run(contextWith(stubConnector()))
    assert.ok(result.report)
    assert.deepEqual(result.report!.unmappable, [
      {
        identifier: 'comments',
        reason: 'no-destination-table',
        detail:
          'Wiki.js 3.0 has no comments table, model, or API route yet (blocked on Epic 335) — comments are not imported.'
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

  describe('provenance/idempotency (Feature 421 task 746)', () => {
    test('usersPhase skips a user already mapped by an exact provenance record', async () => {
      async function* users(): AsyncGenerator<SourceRecord> {
        yield { id: 1, email: 'alice@example.com', providerKey: 'local' }
      }
      const store = fakeProvenanceStore({
        records: [
          {
            siteId: 'test-site',
            sourceSystem: 'wikijs-2.5x',
            sourceTable: 'users',
            sourceId: '1',
            destTable: 'users',
            destId: 'dest-alice',
            importedAt: new Date()
          }
        ]
      })
      const connector = { ...stubConnector(), users, groups: () => recordsOf(0) }
      const result = await usersPhase.run(contextWith(connector, store))
      assert.equal(result.status, 'ok')
      assert.equal(result.report!.wouldCreate, 0)
      assert.equal(result.report!.wouldSkipExisting, 1)
    })

    test('usersPhase reconciles the interrupted-run edge case via the email natural-key fallback, without persisting a provenance record', async () => {
      async function* users(): AsyncGenerator<SourceRecord> {
        yield { id: 1, email: 'alice@example.com', providerKey: 'local' }
      }
      const store = fakeProvenanceStore({
        byEmail: { 'alice@example.com': 'dest-alice-prior-run' }
      })
      const connector = { ...stubConnector(), users, groups: () => recordsOf(0) }
      const result = await usersPhase.run(contextWith(connector, store))
      assert.equal(result.report!.wouldCreate, 0)
      assert.equal(result.report!.wouldSkipExisting, 1)
      // This read-only classification pass never persists a mapping — see classifyUser's doc comment:
      // fabricating an exact-key row onto a coincidental email match here would freeze it permanently.
      // Only the real write path (lookupOrInsert) is allowed to backfill this.
      assert.equal(store.records.length, 0)
    })

    test('usersPhase still reports a genuinely new user as wouldCreate', async () => {
      async function* users(): AsyncGenerator<SourceRecord> {
        yield { id: 2, email: 'brandnew@example.com', providerKey: 'local' }
      }
      const connector = { ...stubConnector(), users, groups: () => recordsOf(0) }
      const result = await usersPhase.run(contextWith(connector))
      assert.equal(result.report!.wouldCreate, 1)
      assert.equal(result.report!.wouldSkipExisting, 0)
    })

    test('a dry run still does not backfill the provenance record for a natural-key match (matches the live-run behavior above)', async () => {
      async function* users(): AsyncGenerator<SourceRecord> {
        yield { id: 1, email: 'alice@example.com', providerKey: 'local' }
      }
      const store = fakeProvenanceStore({
        byEmail: { 'alice@example.com': 'dest-alice-prior-run' }
      })
      const connector = { ...stubConnector(), users, groups: () => recordsOf(0) }
      const ctx = { ...contextWith(connector, store), dryRun: true }
      const result = await usersPhase.run(ctx)
      assert.equal(result.report!.wouldSkipExisting, 1)
      assert.equal(store.records.length, 0)
    })

    test('contentPhase skips a page already mapped by the exact (siteId, locale, path) natural key', async () => {
      async function* pages(): AsyncGenerator<SourceRecord> {
        yield { id: 10, path: 'en/getting-started', localeCode: 'en' }
      }
      const store = fakeProvenanceStore({ byPath: { 'en/getting-started': 'dest-page-1' } })
      const connector = {
        ...stubConnector(),
        pages,
        pageHistory: () => recordsOf(0),
        tags: () => recordsOf(0)
      }
      const result = await contentPhase.run(contextWith(connector, store))
      assert.equal(result.report!.wouldCreate, 0)
      assert.equal(result.report!.wouldSkipExisting, 1)
      // Same invariant as usersPhase above: a read-only classification pass never persists a mapping.
      assert.equal(store.records.length, 0)
    })

    test('contentPhase writes no migrationRecords row for a non-dry-run classification pass over a natural-key hit', async () => {
      async function* pages(): AsyncGenerator<SourceRecord> {
        yield { id: 11, path: 'en/another-page', localeCode: 'en' }
      }
      const store = fakeProvenanceStore({ byPath: { 'en/another-page': 'dest-page-2' } })
      const connector = {
        ...stubConnector(),
        pages,
        pageHistory: () => recordsOf(0),
        tags: () => recordsOf(0)
      }
      const ctx = { ...contextWith(connector, store), dryRun: false }
      const result = await contentPhase.run(ctx)
      assert.equal(result.report!.wouldSkipExisting, 1)
      assert.deepEqual(store.records, [])
    })

    test('assetsPhase skips an asset file already mapped by an exact provenance record', async () => {
      async function* assets(): AsyncGenerator<SourceAssetFile> {
        yield {
          relativePath: 'images/logo.png',
          filename: 'logo.png',
          stream: null as any
        }
      }
      const store = fakeProvenanceStore({
        records: [
          {
            siteId: 'test-site',
            sourceSystem: 'wikijs-2.5x',
            sourceTable: 'assets',
            sourceId: 'images/logo.png',
            destTable: 'assets',
            destId: 'dest-logo',
            importedAt: new Date()
          }
        ]
      })
      const connector = { ...stubConnector(), assets }
      const result = await assetsPhase.run(contextWith(connector, store))
      assert.equal(result.report!.wouldCreate, 0)
      assert.equal(result.report!.wouldSkipExisting, 1)
    })
  })
})
