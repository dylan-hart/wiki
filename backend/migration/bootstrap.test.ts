import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../test/db.ts'
import {
  buildWikiShell,
  createCacheStub,
  createEventsStub,
  loadModels,
  resolveUsersImportContext
} from './bootstrap.ts'
import { installTestWiki } from '../test/mocks.ts'
import type { TestFixtures } from '../test/db.ts'

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
  'comments',
  'locales',
  'rendering',
  'search',
  'hooks',
  'flags',
  'classificationLevels',
  'navigation',
  'security'
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

  /**
   * Task 15 review-round Critical #1: `bootstrapMigrationRuntime()`'s `WIKI` literal used to omit
   * `auth` entirely, which `models/authentication.ts#activateStrategies()` (called unconditionally at
   * the end of every `createStrategy()`/`updateStrategy()`/`deleteStrategy()`) needs unconditionally
   * — `WIKI.auth.strategies = {}` throws `TypeError: Cannot set properties of undefined` against a
   * `WIKI` missing it. This is a fast, DB-free unit test of the exact shape that bug lived in;
   * `bootstrap.test.ts`'s own DB-backed `describe` below additionally proves `createStrategy()` itself
   * succeeds end-to-end against a `WIKI` built from this shape.
   */
  test('buildWikiShell() seeds auth: { groups: {}, strategies: {} }, matching index.ts/test/db.ts', () => {
    const shell = buildWikiShell('test-instance')
    assert.deepEqual(shell.auth, { groups: {}, strategies: {} })
    assert.equal(shell.INSTANCE_ID, 'test-instance')
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
 *
 * This function used to also resolve/validate a `primaryLocale` fifth field (Task 13), keyed off a
 * `siteId` parameter — removed by the whole-branch review's Critical #1 fix, which moved that
 * resolution into `context.ts#resolvePrimaryLocale()`, read fresh by the phases that need it instead of
 * captured once here before any phase had run. See that function's own doc comment.
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

/**
 * Task 15 review-round Critical #1, behavioral half: the settings phase's own integration test
 * (`phases/settings.integration.test.ts`) runs `createStrategy()` against `setupTestDb()`'s
 * `installTestWiki()`-built `WIKI` — which, unlike `bootstrapMigrationRuntime()`'s real result before
 * this fix, has always seeded `auth` (see `test/db.ts`'s own `installTestWiki()`). That is exactly why
 * that test could not have caught this bug on its own — it exercises `WIKI` shaped like `test/db.ts`,
 * not shaped like `bootstrap.ts`. This suite instead assembles `WIKI` directly from `buildWikiShell()`
 * (the function `bootstrapMigrationRuntime()` itself now delegates to for this exact shape), so a
 * regression here — `auth` dropped from `buildWikiShell()`, or `activateStrategies()` gaining a new
 * unconditional dependency `buildWikiShell()` doesn't provide — fails this suite instead of only
 * surfacing on a real, live migration run.
 *
 * `dbManager.init()`/`configSvc.init()` themselves are deliberately NOT exercised here: both need a
 * real `config.yml` on disk at `WIKI.ROOTPATH` (`process.cwd()`) and would `process.exit(1)` if one
 * isn't found there — `backend/`'s own test convention is to run `npm test` from `backend/` itself,
 * where no `config.yml` exists (the real one lives at the repo root). Reusing `setupTestDb()`'s
 * already-migrated, already-connected `db` (and its real `models`, captured before this suite
 * overwrites `global.WIKI`) sidesteps that without weakening what's actually under test: neither
 * `dbManager`/`configSvc.init()`'s own config-file plumbing nor `WIKI.auth`'s presence have anything to
 * do with each other.
 */
describe(
  'bootstrapMigrationRuntime WIKI shape: createStrategy() against a real bootstrap-shaped WIKI (Task 15 review fix, Critical #1)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
    })

    after(async () => {
      await teardownTestDb()
    })

    test('createStrategy() succeeds — and actually activates the new strategy — against a WIKI built from buildWikiShell()', async () => {
      // -> Captured before `global.WIKI` is replaced below: the same real model singletons
      //    `setupTestDb()` already loaded (`loadModels()` would just re-`import()` the identical
      //    cached module instances anyway, since ES modules are singletons).
      const models = WIKI.models
      const logger = WIKI.logger

      // -> `refreshStrategiesFromDisk()` only touches `SERVERPATH`/`logger`/`data`, and
      //    `createWikiStub` supplies the `data`/`cache`/`events` members `buildWikiShell()`
      //    deliberately does not — this asserts on the SHELL's own shape being enough for
      //    `createStrategy()`, so those three are the only things layered over it.
      const wikiHandle = installTestWiki({
        ...buildWikiShell('bootstrap-shape-regression-test'),
        logger,
        dbManager: {},
        db: fixtures.db,
        models
      })

      try {
        await WIKI.models.authentication.refreshStrategiesFromDisk()

        // -> Before Task 15's review fix, this throws `TypeError: Cannot set properties of undefined
        //    (setting 'strategies')` from inside `activateStrategies()`, after the row has already
        //    been inserted — `assert.doesNotReject` on the whole call is what proves both halves: the
        //    throw is gone, and the row insert that precedes it in `createStrategy()` still ran.
        let id: string | undefined
        await assert.doesNotReject(async () => {
          id = await WIKI.models.authentication.createStrategy({
            module: 'local',
            displayName: 'Bootstrap Shape Regression Test'
          })
        })
        assert.equal(typeof id, 'string')
        assert.ok(
          WIKI.auth.strategies[id!],
          'activateStrategies() actually ran and populated WIKI.auth.strategies for the new strategy, not merely avoided throwing'
        )
      } finally {
        // -> Puts `setupTestDb()`'s own WIKI back, so `teardownTestDb()` in `after()` tears down the
        //    global it actually installed.
        wikiHandle.restore()
      }
    })
  }
)
