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

/**
 * Unit tests for WP #2158/#2166 (part of #2154): `securityCspSeed` is what a fresh instance's
 * `security` settings row actually seeds `cspDirectives`/`enforceCsp` from -- unlike every other
 * field `Settings#init` seeds, which is a hardcoded literal, these two are read from
 * `WIKI.config.security` (`base.yml` merged with any `config.yml` override) specifically so
 * `e2e/config.e2e.yml` can turn `enforceCsp` on for `e2e/tests/csp.spec.js` without touching what a
 * real fresh install ships with. Pure function, no `WIKI` global and no database, per this
 * workspace's testing convention.
 */
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
    // -> `configSvc.init()` merges `config.yml` onto `appdata.defaults.config` -- with no override,
    //    `WIKI.config.security` ends up identical to `base.yml`'s own `defaults.config.security`.
    const result = securityCspSeed(
      { security: config.defaults.config.security },
      { defaults: { config: { security: config.defaults.config.security } } }
    )
    assert.equal(result.cspDirectives, config.defaults.config.security.cspDirectives)
    assert.equal(result.enforceCsp, false)
    assert.doesNotThrow(() => parseCspDirectives(result.cspDirectives))
  })
})
