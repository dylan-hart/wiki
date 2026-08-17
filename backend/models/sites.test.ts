import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../test/db.ts'

/**
 * `models/sites.ts`'s `createSite()` and `init()` per-site default config, task #563: search
 * configuration moved from the instance-wide `WIKI.config.search` to a `search: { engine, config }`
 * block seeded alongside the other per-site defaults (`authStrategies`, `uploads`, `defaults`, ...)
 * this suite otherwise leaves untested — the seeded shape is what `models/search.ts`'s `getConfig()`
 * and `engineFor()` read back, so a wrong default here is a silent fallback everywhere else.
 */
describe('sites default config (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let sitesModel: typeof import('./sites.ts').sites

  before(async () => {
    await setupTestDb()
    ;({ sites: sitesModel } = await import('./sites.ts'))
    // -> `createSite()` reads this directly for the default `authStrategies` entry, same as the real
    //    boot sequence does through `core/config.ts`'s `initDbValues()`
    ;(globalThis as any).WIKI.data.systemIds = { localAuthId: randomUUID() }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('createSite() seeds a default db search engine with term highlighting off and no overrides', async () => {
    const created = await sitesModel.createSite('sites-test-create.localhost')

    const site = await sitesModel.getSiteById({ id: created.id })

    assert.deepEqual(site!.config.search, {
      engine: 'db',
      config: { termHighlighting: false, dictOverrides: {} }
    })
  })

  test('createSite() config argument can override the seeded search default', async () => {
    const created = await sitesModel.createSite('sites-test-create-override.localhost', {
      search: { engine: 'db', config: { termHighlighting: true, dictOverrides: {} } }
    })

    const site = await sitesModel.getSiteById({ id: created.id })

    assert.deepEqual(site!.config.search, {
      engine: 'db',
      config: { termHighlighting: true, dictOverrides: {} }
    })
  })

  test('init() seeds the same default search block for the first-run site', async () => {
    const siteId = randomUUID()
    await sitesModel.init({
      groupAdminId: randomUUID(),
      groupUserId: randomUUID(),
      groupGuestId: randomUUID(),
      siteId,
      authModuleId: randomUUID(),
      userAdminId: randomUUID(),
      userGuestId: randomUUID()
    })

    const site = await sitesModel.getSiteById({ id: siteId, forceReload: true })

    assert.deepEqual(site!.config.search, {
      engine: 'db',
      config: { termHighlighting: false, dictOverrides: {} }
    })
  })
})
