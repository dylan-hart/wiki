import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import {
  authentication as authenticationTable,
  sites as sitesTable,
  storage as storageTable
} from '../../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../../test/db.ts'
import { NotYetImplementedError } from '../connector.ts'
import { settingsPhase } from './settings.ts'
import type { TestFixtures } from '../../test/db.ts'
import type { SourceConnector, SourceRecord } from '../connector.ts'
import type { MigrationContext } from '../context.ts'

const LOCAL_STRATEGY_ID = 'integration-local-strategy-uuid'
const FAKE_ADMIN_GROUP_ID = 'integration-admin-group-uuid'
const FAKE_GUEST_GROUP_ID = 'integration-guest-group-uuid'
const OPERATOR_ACTOR_ID = 'integration-operator-uuid'

async function* iter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item
  }
}

/**
 * A minimal `SourceConnector`: a real `settings()` generator yielding one tagged row per entity
 * (`settings`/`authentication`/`storage`), matching `PostgresSourceConnector.settings()`'s real
 * tagged-record shape (Task 9) — everything else this phase never reads stays a
 * `NotYetImplementedError` stub.
 */
function fakeSourceConnector(): SourceConnector {
  const notImplemented = (method: string) => () => {
    throw new NotYetImplementedError(method, 'not needed by this test')
  }
  return {
    kind: 'postgres',
    connect: async () => {},
    disconnect: async () => {},
    describe: async () => ({ kind: 'postgres', location: 'fake', notes: [] }),
    users: notImplemented('users'),
    groups: notImplemented('groups'),
    pages: notImplemented('pages'),
    pageHistory: notImplemented('pageHistory'),
    tags: notImplemented('tags'),
    navigation: notImplemented('navigation'),
    settings: () =>
      iter<SourceRecord>([
        { entity: 'settings', key: 'title', value: 'Migrated Wiki' },
        {
          entity: 'authentication',
          key: 'local-2x',
          isEnabled: true,
          config: {},
          selfRegistration: false,
          domainWhitelist: [],
          autoEnrollGroups: [],
          strategyKey: 'local',
          displayName: 'Local (Migrated)'
        },
        {
          entity: 'storage',
          key: 'disk',
          isEnabled: true,
          mode: 'push',
          config: { path: '/data/migrated', createDailyBackups: true },
          syncInterval: null,
          state: {}
        }
      ]),
    comments: notImplemented('comments'),
    assets: notImplemented('assets')
  }
}

describe(
  'settingsPhase against a real destination database (Task 15)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
      // -> Mirrors `bootstrap.ts#bootstrapMigrationRuntime()`'s own two disk-loading calls (Task 15):
      //    `WIKI.models.authentication`/`WIKI.models.storage`'s resolvers need these populated before
      //    `getModule()`/`getDefinition()` can recognize any real module. `setupTestDb()`'s own
      //    minimal WIKI does not call either, since no other DB-backed suite in this repo needs both
      //    at once the way this phase does.
      await WIKI.models.authentication.refreshStrategiesFromDisk()
      await WIKI.models.storage.refreshFromDisk()
      // -> `setupTestDb()` inserts the fixture site directly (not through `Sites.createSite()`), so
      //    it never ran `Storage.syncSite()` — seed the one-row-per-module baseline a real site would
      //    already have, which is what proves the storage mapper's output is applied as an UPDATE
      //    against an existing row, never an INSERT.
      await WIKI.models.storage.syncSite(fixtures.siteId)
    })

    after(async () => {
      await teardownTestDb()
    })

    test('applies the site-config patch, creates an authentication strategy, and updates (not inserts) the existing storage row', async () => {
      const [diskRowBefore] = await fixtures.db
        .select()
        .from(storageTable)
        .where(and(eq(storageTable.siteId, fixtures.siteId), eq(storageTable.module, 'disk')))
      assert.ok(diskRowBefore, 'Storage.syncSite() seeded a disk row before the phase ran')
      assert.equal(
        diskRowBefore!.isEnabled,
        false,
        'disk starts disabled, like every non-db module'
      )

      const ctx: MigrationContext = {
        db: fixtures.db,
        source: fakeSourceConnector(),
        siteId: fixtures.siteId,
        dryRun: false,
        localStrategyId: LOCAL_STRATEGY_ID,
        systemGroupIds: { admin: FAKE_ADMIN_GROUP_ID, guest: FAKE_GUEST_GROUP_ID },
        operatorActorId: OPERATOR_ACTOR_ID,
        primaryLocale: 'en'
      }

      const result = await settingsPhase.run(ctx)

      assert.equal(result.status, 'ok')
      assert.deepEqual(result.counts, { settings: 3 })
      assert.ok(result.report)
      // -> site-config sentinel + the one authentication row + the one storage row.
      assert.equal(result.report!.wouldCreate, 3)
      assert.deepEqual(result.report!.conflicts, [])
      assert.deepEqual(result.report!.unmappable, [])

      const [site] = await fixtures.db
        .select({ config: sitesTable.config })
        .from(sitesTable)
        .where(eq(sitesTable.id, fixtures.siteId))
      const siteConfig = site!.config as Record<string, any>
      assert.equal(siteConfig.title, 'Migrated Wiki')

      const authRows = await fixtures.db
        .select()
        .from(authenticationTable)
        .where(eq(authenticationTable.module, 'local'))
      const created = authRows.find((row) => row.displayName === 'Local (Migrated)')
      assert.ok(created, 'an authentication row for the local module was created')
      assert.equal(created!.isEnabled, true)

      const diskRowsAfter = await fixtures.db
        .select()
        .from(storageTable)
        .where(and(eq(storageTable.siteId, fixtures.siteId), eq(storageTable.module, 'disk')))
      assert.equal(diskRowsAfter.length, 1, 'still exactly one disk row — updated, never inserted')
      assert.equal(diskRowsAfter[0]!.id, diskRowBefore!.id, 'the same row, not a new one')
      assert.equal(diskRowsAfter[0]!.isEnabled, true)
      assert.deepEqual((diskRowsAfter[0]!.config as Record<string, any>).path, '/data/migrated')
      assert.deepEqual((diskRowsAfter[0]!.config as Record<string, any>).createDailyBackups, true)
    })
  }
)
