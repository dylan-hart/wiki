import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import { load } from 'js-yaml'
import { settings as settingsTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { parseCspDirectives } from '../helpers/security.ts'
import { securityCspSeed } from './settings.ts'
import type { SystemIds } from './types.ts'

await ensureTemporal()

/**
 * Search config is read per-site (`CARDINAL.sites[siteId].config.search.config`, never
 * `CARDINAL.config.search`) and the only live `CARDINAL.config.icons` read is `models/icons.ts`'s
 * `apiUrl`, which `base.yml` satisfies — so a seeded row for either is dead weight nothing reads.
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

describe('securityCspSeed', () => {
  test('reads both fields straight through when config sets them', () => {
    assert.deepEqual(
      securityCspSeed(
        { security: { cspDirectives: "default-src 'self'", enforceCsp: true } },
        undefined
      ),
      { cspDirectives: "default-src 'self'", enforceCsp: true }
    )
  })

  test('enforceCsp defaults to false when config leaves it unset', () => {
    assert.equal(
      securityCspSeed({ security: { cspDirectives: "default-src 'self'" } }, undefined).enforceCsp,
      false
    )
  })

  test("falls back to data's parsed base.yml default when config sets neither", () => {
    const result = securityCspSeed(undefined, {
      defaults: { config: { security: { cspDirectives: "object-src 'none'" } } }
    })
    assert.deepEqual(result, { cspDirectives: "object-src 'none'", enforceCsp: false })
  })

  test('falls back to an empty string when nothing anywhere sets cspDirectives', () => {
    assert.equal(securityCspSeed(undefined, undefined).cspDirectives, '')
  })

  test('config.security.cspDirectives wins over the data fallback when both are set', () => {
    const result = securityCspSeed(
      { security: { cspDirectives: "default-src 'self'" } },
      { defaults: { config: { security: { cspDirectives: "object-src 'none'" } } } }
    )
    assert.equal(result.cspDirectives, "default-src 'self'")
  })

  test('in real boot order (config.init() before initDbValues()), the shipped backend/base.yml default flows through untouched', () => {
    const config: any = load(readFileSync(path.join(import.meta.dirname, '../base.yml'), 'utf8'))
    // -> `configSvc.init()` merges `config.yml` onto `appdata.defaults.config`, so with no override
    //    both arguments really are the same `base.yml` object at boot.
    const result = securityCspSeed(
      { security: config.defaults.config.security },
      { defaults: { config: { security: config.defaults.config.security } } }
    )
    assert.equal(result.cspDirectives, config.defaults.config.security.cspDirectives)
    assert.equal(result.enforceCsp, false)
    assert.doesNotThrow(() => parseCspDirectives(result.cspDirectives))
  })
})
