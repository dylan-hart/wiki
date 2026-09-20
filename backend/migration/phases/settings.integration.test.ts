import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import {
  authentication as authenticationTable,
  sites as sitesTable,
  storage as storageTable
} from '../../db/schema.ts'
import configSvc from '../../core/config.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../../test/db.ts'
import { settingsPhase } from './settings.ts'
import type { TestFixtures } from '../../test/db.ts'
import type { SourceConnector, SourceRecord } from '../connector.ts'
import type { MigrationContext } from '../context.ts'
import { iterate as iter, stubSourceConnector } from '../../test/migrationFixtures.ts'

const LOCAL_STRATEGY_ID = 'integration-local-strategy-uuid'
const FAKE_ADMIN_GROUP_ID = 'integration-admin-group-uuid'
const FAKE_GUEST_GROUP_ID = 'integration-guest-group-uuid'
const OPERATOR_ACTOR_ID = 'integration-operator-uuid'

/**
 * Only `settings()` is real, in `PostgresSourceConnector`'s tagged-record shape. The three
 * `settings`-tagged rows deliberately outnumber the one `site-config` sentinel they collapse into,
 * which is what makes `found` legitimately differ from `wouldCreate` for this phase.
 */
function fakeSourceConnector(): SourceConnector {
  return stubSourceConnector({
    settings: () =>
      iter<SourceRecord>([
        { entity: 'settings', key: 'title', value: 'Migrated Wiki' },
        {
          entity: 'settings',
          key: 'mail',
          value: {
            senderName: 'Migrated Mailer',
            senderEmail: 'mailer@example.com',
            host: 'smtp.example.com',
            port: 587
          }
        },
        {
          entity: 'settings',
          key: 'security',
          value: { securityCSP: true, securityHSTSDuration: 15768000 }
        },
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
      ])
  })
}

describe(
  'settingsPhase against a real destination database (Task 15)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
      // -> `setupTestDb()`'s minimal CARDINAL has no `configSvc`; this phase's `mail` merge needs the
      //    real `saveToDb()`/`loadFromDb()` round trip, so add it per-suite rather than widening the
      //    shared fixture.
      CARDINAL.configSvc = configSvc
      // -> The resolvers recognize no module until these disk loads have run, mirroring
      //    `bootstrap.ts#bootstrapMigrationRuntime()`.
      await CARDINAL.models.authentication.refreshStrategiesFromDisk()
      await CARDINAL.models.storage.refreshFromDisk()
      // -> `setupTestDb()` inserts the fixture site directly, so `Storage.syncSite()` never ran —
      //    seed the one-row-per-module baseline a real site would have, which is what makes the
      //    UPDATE-not-INSERT assertion below meaningful.
      await CARDINAL.models.storage.syncSite(fixtures.siteId)
      // -> Preexisting settings this run must NOT clobber: `defaultBaseURL` has no 2.x source field
      //    at all, and `corsMode` is untouched by this run's `security` row. A wholesale-replace
      //    write would silently delete both.
      CARDINAL.config.mail = {
        defaultBaseURL: 'https://preexisting.example.com',
        senderName: 'Old Name'
      }
      CARDINAL.config.security = { corsMode: 'custom', enforceCsp: false }
    })

    after(async () => {
      await teardownTestDb()
    })

    test('applies the site-config patch, merges instance settings, creates an authentication strategy, and updates (not inserts) the existing storage row', async () => {
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
        operatorActorId: OPERATOR_ACTOR_ID
      }

      const result = await settingsPhase.run(ctx)

      assert.equal(result.status, 'ok')
      // -> The raw rows read off the source, independent of the recorder events they produced.
      assert.deepEqual(result.counts, { settings: 5 })
      assert.ok(result.report)
      assert.equal(result.report!.found, 5)
      // -> The three settings rows collapse into one `site-config` sentinel, plus the authentication
      //    and storage rows: 3, against 5 found.
      assert.equal(result.report!.wouldCreate, 3)
      assert.notEqual(
        result.report!.found,
        result.report!.wouldCreate +
          result.report!.wouldSkipExisting +
          result.report!.conflicts.length +
          result.report!.unmappable.length,
        'the settings phase is the one documented exception to the found === wouldCreate + ... invariant'
      )
      assert.deepEqual(result.report!.conflicts, [])
      assert.deepEqual(result.report!.unmappable, [])

      const [site] = await fixtures.db
        .select({ config: sitesTable.config })
        .from(sitesTable)
        .where(eq(sitesTable.id, fixtures.siteId))
      const siteConfig = site!.config as Record<string, any>
      assert.equal(siteConfig.title, 'Migrated Wiki')

      // -> The patch merges rather than replaces: `defaultBaseURL` survives and the new fields land
      //    alongside it, in the in-memory config AND the persisted `settings` row.
      assert.equal(CARDINAL.config.mail.defaultBaseURL, 'https://preexisting.example.com')
      assert.equal(CARDINAL.config.mail.senderName, 'Migrated Mailer')
      assert.equal(CARDINAL.config.mail.senderEmail, 'mailer@example.com')
      assert.equal(CARDINAL.config.mail.host, 'smtp.example.com')
      const persistedConfig = await CARDINAL.models.settings.getConfig()
      assert.ok(persistedConfig)
      assert.equal(
        (persistedConfig as Record<string, any>).mail.defaultBaseURL,
        'https://preexisting.example.com'
      )
      assert.equal((persistedConfig as Record<string, any>).mail.senderName, 'Migrated Mailer')

      // -> Same merge proof for security: `corsMode` survives, the mapped fields land alongside it.
      assert.equal(CARDINAL.config.security.corsMode, 'custom')
      assert.equal(CARDINAL.config.security.enforceCsp, true)
      assert.equal(CARDINAL.config.security.hstsDuration, 15768000)
      assert.equal((persistedConfig as Record<string, any>).security.corsMode, 'custom')
      assert.equal((persistedConfig as Record<string, any>).security.enforceCsp, true)

      const authRows = await fixtures.db
        .select()
        .from(authenticationTable)
        .where(eq(authenticationTable.module, 'local'))
      const created = authRows.find((row) => row.displayName === 'Local (Migrated)')
      assert.ok(created, 'an authentication row for the local module was created')
      assert.equal(created!.isEnabled, true)
      // -> `createStrategy()`'s own `activateStrategies()` call did more than not throw: it actually
      //    populated `CARDINAL.auth.strategies` for the strategy it just created.
      assert.ok(
        CARDINAL.auth.strategies[created!.id],
        'activateStrategies() loaded the new strategy'
      )

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
