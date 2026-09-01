import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createCacheStub,
  createEventsStub,
  loadModels,
  resolveUsersImportContext
} from './bootstrap.ts'

/** A minimal `WikiGlobal`-shaped fake for `resolveUsersImportContext()` — a pure function of
 * `WIKI.data`/`WIKI.config`, so no real bootstrap/db/models are needed to exercise it. */
function fakeWiki(overrides: { data?: any; config?: any } = {}): any {
  return {
    data: { systemIds: { localAuthId: 'local-auth-uuid', guestsGroupId: 'guest-group-uuid' } },
    config: { auth: { rootAdminGroupId: 'admin-group-uuid', rootAdminUserId: 'admin-user-uuid' } },
    ...overrides
  }
}

/**
 * Every model name a built migration importer reaches, directly or transitively, through
 * `WIKI.models`. Kept as an explicit list rather than asserting against a snapshot of whatever
 * `loadModels()` currently returns, so a write path gaining a new model call (the way `createPage()`
 * already reaches `locales`/`rendering`/`search`/`hooks`/`flags`/`classificationLevels`) fails this
 * test loudly instead of silently passing because the snapshot moved with it. See `loadModels()`'s
 * own doc comment in `bootstrap.ts` for which importer calls each of these.
 */
const EXPECTED_MODEL_NAMES = [
  'sites',
  'settings',
  'users',
  'groups',
  'authentication',
  'storage',
  'tags',
  'tree',
  'pages',
  'pageHistory',
  'assets',
  'locales',
  'rendering',
  'search',
  'hooks',
  'flags',
  'classificationLevels',
  'navigation'
]

describe('migration bootstrap', () => {
  test('loadModels() resolves every model a built importer calls through WIKI.models', async () => {
    const models = await loadModels()
    for (const name of EXPECTED_MODEL_NAMES) {
      assert.ok(
        (models as Record<string, unknown>)[name],
        `expected WIKI.models.${name} to be loaded`
      )
    }
  })

  test('createEventsStub() exposes both buses write paths emit through', () => {
    const events = createEventsStub()
    assert.equal(typeof events.inbound.emit, 'function')
    assert.equal(typeof events.outbound.emit, 'function')
    // -> models/groups.ts#broadcastReload's WIKI.events.outbound.emit('reloadGroups') must not throw
    assert.doesNotThrow(() => events.outbound.emit('reloadGroups'))
  })

  test('createCacheStub() exposes the full LRUCache-shaped surface write paths call', () => {
    const cache = createCacheStub()
    assert.equal(typeof cache.get, 'function')
    assert.equal(typeof cache.set, 'function')
    assert.equal(typeof cache.has, 'function')
    assert.equal(typeof cache.delete, 'function')
    assert.equal(typeof cache.getRemainingTTL, 'function')
    assert.equal(typeof cache.clear, 'function')

    cache.set('key', 'value')
    assert.equal(cache.has('key'), true)
    assert.equal(cache.get('key'), 'value')
    cache.delete('key')
    assert.equal(cache.has('key'), false)
  })
})

/**
 * Coverage for the Task 14 review fix: `resolveUsersImportContext()` must not silently resolve
 * `undefined` for any of `localStrategyId`/`systemGroupIds.admin`/`systemGroupIds.guest`/
 * `operatorActorId` — a missing/malformed `settings.auth` row (e.g. `configSvc.loadFromDb()` was
 * never called, or found an empty `settings` table) previously produced `undefined` values typed as
 * `string`, which `createUserGroupImporter()` then treats as "not created" and silently skips every
 * source-Administrators/-Guests membership, with no error anywhere.
 */
describe('resolveUsersImportContext (Task 14 review fix)', () => {
  test('resolves all three fields from a fully-populated WIKI', () => {
    const result = resolveUsersImportContext(fakeWiki())
    assert.deepEqual(result, {
      localStrategyId: 'local-auth-uuid',
      systemGroupIds: { admin: 'admin-group-uuid', guest: 'guest-group-uuid' },
      operatorActorId: 'admin-user-uuid'
    })
  })

  test('throws when WIKI.config.auth.rootAdminGroupId is missing (e.g. loadFromDb() was never called, or found an empty settings table)', () => {
    assert.throws(
      () => resolveUsersImportContext(fakeWiki({ config: { auth: {} } })),
      /rootAdminGroupId|adminGroupId/
    )
  })

  test('throws when WIKI.config.auth.rootAdminUserId is missing', () => {
    assert.throws(
      () =>
        resolveUsersImportContext(
          fakeWiki({ config: { auth: { rootAdminGroupId: 'admin-group-uuid' } } })
        ),
      /operatorActorId/
    )
  })

  test('throws when WIKI.data.systemIds is missing/malformed', () => {
    assert.throws(() => resolveUsersImportContext(fakeWiki({ data: { systemIds: {} } })))
  })
})
