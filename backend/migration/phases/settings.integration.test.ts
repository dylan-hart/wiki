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
 * A minimal `SourceConnector`: a real `settings()` generator yielding tagged rows
 * (`settings`/`authentication`/`storage`), matching `PostgresSourceConnector.settings()`'s real
 * tagged-record shape (Task 9) — everything else this phase never reads stays a
 * `NotYetImplementedError` stub.
 *
 * Three `settings`-tagged rows (`title`/`mail`/`security`) deliberately outnumber the one
 * `site-config` sentinel they collapse into — see `report.ts`'s own doc comment on why `found` (5:
 * three settings rows + one authentication row + one storage row) legitimately differs from
 * `wouldCreate` (3: one sentinel + one authentication row + one storage row) for this phase.
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
      // -> `setupTestDb()`'s own minimal WIKI (`test/db.ts#installTestWiki()`) does not set
      //    `WIKI.configSvc` — no other DB-backed suite needs the real `saveToDb()`/`loadFromDb()`
      //    round trip the way this phase's `mail` merge does. `models/sessions.test.ts` establishes
      //    the precedent for adding it back in per-suite rather than widening the shared fixture.
      WIKI.configSvc = configSvc
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
      // -> Preexisting instance settings this run's `mail`/`security` patches must NOT clobber (Task
      //    15's review-round Critical #2 fix): `defaultBaseURL` has no 2.x source field at all
      //    (`mappers/site-settings.ts`'s `MAIL_FIELDS` doesn't list it), and `corsMode` isn't touched
      //    by this run's `security` source row either. A wholesale-replace write would silently
      //    delete both.
      WIKI.config.mail = {
        defaultBaseURL: 'https://preexisting.example.com',
        senderName: 'Old Name'
      }
      WIKI.config.security = { corsMode: 'custom', enforceCsp: false }
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
      // -> Five raw tagged rows read off the source (three settings + one authentication + one
      //    storage) — `readEntity()`'s own count, independent of how many recorder events they
      //    produced.
      assert.deepEqual(result.counts, { settings: 5 })
      assert.ok(result.report)
      assert.equal(result.report!.found, 5)
      // -> Three settings-tagged rows collapse into ONE `site-config` sentinel + the one
      //    authentication row + the one storage row = 3, proving `found` (5) legitimately differs
      //    from `wouldCreate` for this phase — see `report.ts`'s own doc comment (Task 15 review-round
      //    Important #4 fix).
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

      // -> Critical #2 fix: the mail patch merges onto the existing row rather than replacing it —
      //    `defaultBaseURL` (no 2.x source field at all) survives, and the new fields land alongside
      //    it, both in the in-memory `WIKI.config.mail` AND the persisted `settings` DB row.
      assert.equal(WIKI.config.mail.defaultBaseURL, 'https://preexisting.example.com')
      assert.equal(WIKI.config.mail.senderName, 'Migrated Mailer')
      assert.equal(WIKI.config.mail.senderEmail, 'mailer@example.com')
      assert.equal(WIKI.config.mail.host, 'smtp.example.com')
      const persistedConfig = await WIKI.models.settings.getConfig()
      assert.ok(persistedConfig)
      assert.equal(
        (persistedConfig as Record<string, any>).mail.defaultBaseURL,
        'https://preexisting.example.com'
      )
      assert.equal((persistedConfig as Record<string, any>).mail.senderName, 'Migrated Mailer')

      // -> Same merge proof for security: `corsMode` (untouched by this run's source row) survives,
      //    and the mapped fields (`enforceCsp`/`hstsDuration`, from `securityCSP`/
      //    `securityHSTSDuration`) land alongside it.
      assert.equal(WIKI.config.security.corsMode, 'custom')
      assert.equal(WIKI.config.security.enforceCsp, true)
      assert.equal(WIKI.config.security.hstsDuration, 15768000)
      assert.equal((persistedConfig as Record<string, any>).security.corsMode, 'custom')
      assert.equal((persistedConfig as Record<string, any>).security.enforceCsp, true)

      const authRows = await fixtures.db
        .select()
        .from(authenticationTable)
        .where(eq(authenticationTable.module, 'local'))
      const created = authRows.find((row) => row.displayName === 'Local (Migrated)')
      assert.ok(created, 'an authentication row for the local module was created')
      assert.equal(created!.isEnabled, true)
      // -> Critical #1 fix's other half: `createStrategy()`'s own `activateStrategies()` call
      //    completed without throwing (proven merely by `settingsPhase.run()` above having returned
      //    `status: 'ok'` rather than `'error'`), and actually populated `WIKI.auth.strategies` for
      //    the strategy it just created.
      assert.ok(WIKI.auth.strategies[created!.id], 'activateStrategies() loaded the new strategy')

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
