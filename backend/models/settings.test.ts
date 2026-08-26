import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { settings as settingsTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { SystemIds } from './types.ts'

/**
 * `Settings.init()` (OpenProject #2005): the seeded `settings` rows a fresh install writes.
 * `search` (moved to per-site config in #563 — `models/search.ts`'s comment reads
 * `WIKI.sites[siteId].config.search.config`, never `WIKI.config.search`) and `icons` (the 2.x
 * icon-webfont shape; the only live `WIKI.config.icons` read is `models/icons.ts`'s `apiUrl`,
 * satisfied by `base.yml`) were dead rows nothing ever read back. This locks their removal so
 * neither reappears.
 */
describe('Settings.init() (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let settingsModel: typeof import('./settings.ts').settings

  before(async () => {
    fixtures = await setupTestDb()
    ;({ settings: settingsModel } = await import('./settings.ts'))

    const ids: SystemIds = {
      groupAdminId: randomUUID(),
      groupUserId: randomUUID(),
      groupGuestId: randomUUID(),
      siteId: fixtures.siteId,
      authModuleId: randomUUID(),
      userAdminId: fixtures.userId,
      userGuestId: randomUUID(),
      classificationPublicId: fixtures.classificationId,
      classificationInternalId: fixtures.classificationId,
      classificationRestrictedId: fixtures.classificationId
    }
    await settingsModel.init(ids)
  })

  after(async () => {
    await teardownTestDb()
  })

  test('does not seed a search or icons row', async () => {
    const rows = await fixtures.db
      .select({ key: settingsTable.key })
      .from(settingsTable)
      .where(inArray(settingsTable.key, ['search', 'icons']))

    assert.deepEqual(rows, [], 'expected no search or icons row to be seeded')
  })

  test('still seeds auditLog with a retentionDays default', async () => {
    const config = await settingsModel.getConfig()
    assert.notEqual(config, false)
    assert.equal(typeof (config as Record<string, any>).auditLog?.retentionDays, 'number')
  })
})
