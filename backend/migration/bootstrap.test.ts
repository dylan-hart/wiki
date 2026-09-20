import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../test/db.ts'
import {
  buildWikiShell,
  createCacheStub,
  createEventsStub,
  createSchedulerStub,
  loadModels,
  resolveUsersImportContext
} from './bootstrap.ts'
import { installTestWiki } from '../test/mocks.ts'
import type { TestFixtures } from '../test/db.ts'

function fakeWiki(overrides: { data?: any; config?: any } = {}): any {
  return {
    data: { systemIds: { localAuthId: 'local-auth-uuid', guestsGroupId: 'guest-group-uuid' } },
    config: { auth: { rootAdminGroupId: 'admin-group-uuid', rootAdminUserId: 'admin-user-uuid' } },
    ...overrides
  }
}

/**
 * Every model a migration importer reaches through `CARDINAL.models`, directly or transitively. An
 * explicit list, not a snapshot of `loadModels()`'s return, so dropping one from it fails here.
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
  'pageClassification',
  'extensions',
  'blocks',
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
  test('loadModels() resolves every model a built importer calls through CARDINAL.models', async () => {
    const models = await loadModels()
    for (const name of EXPECTED_MODEL_NAMES) {
      assert.ok(
        (models as Record<string, unknown>)[name],
        `expected CARDINAL.models.${name} to be loaded`
      )
    }
  })

  /**
   * `models/authentication.ts#activateStrategies()` assigns `CARDINAL.auth.strategies` unguarded, so
   * a shell without `auth` throws on every strategy write.
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

  test('createSchedulerStub() warns and never touches CARDINAL.db for an unsupported task', async () => {
    const warnings: { scope: string; message: string; fields?: Record<string, unknown> }[] = []
    const wikiHandle = installTestWiki({
      logger: {
        warn: (scope: string, message: string, fields?: Record<string, unknown>) =>
          warnings.push({ scope, message, fields })
      },
      db: {
        insert: () => {
          throw new Error('should not be called for an unsupported task')
        }
      }
    })
    try {
      const scheduler = createSchedulerStub()
      const result = await scheduler.addJob({ task: 'dispatchWebhook' } as any)
      assert.equal(result, undefined)
      assert.equal(warnings.length, 1)
      assert.equal(warnings[0]!.scope, 'migrate')
      assert.match(warnings[0]!.message, /cannot queue this task/)
      assert.equal(warnings[0]!.fields?.task, 'dispatchWebhook')
    } finally {
      wikiHandle.restore()
    }
  })

  test('createSchedulerStub() logs one embedPage notice total, not one per page, and inserts no job row', async () => {
    const infos: { scope: string; message: string; fields?: Record<string, unknown> }[] = []
    const warnings: unknown[] = []
    const wikiHandle = installTestWiki({
      logger: {
        info: (scope: string, message: string, fields?: Record<string, unknown>) =>
          infos.push({ scope, message, fields }),
        warn: (...args: unknown[]) => warnings.push(args)
      },
      db: {
        insert: () => {
          throw new Error('should not be called for embedPage')
        }
      }
    })
    try {
      const scheduler = createSchedulerStub()
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          scheduler.addJob({ task: 'embedPage', payload: { pageId: `page-${i}` } } as any)
        )
      )
      assert.deepEqual(
        results,
        Array.from({ length: 50 }, () => undefined)
      )
      assert.equal(warnings.length, 0)
      assert.equal(infos.length, 1)
      assert.equal(infos[0]!.scope, 'migrate')
      assert.match(infos[0]!.message, /rebuild embeddings index/i)
    } finally {
      wikiHandle.restore()
    }
  })

  test('createSchedulerStub() keeps embedPage and the generic unsupported-task branch independent', async () => {
    const infos: unknown[] = []
    const warnings: { fields?: Record<string, unknown> }[] = []
    const wikiHandle = installTestWiki({
      logger: {
        info: (...args: unknown[]) => infos.push(args),
        warn: (_scope: string, _message: string, fields?: Record<string, unknown>) =>
          warnings.push({ fields })
      },
      db: {
        insert: () => {
          throw new Error('should not be called for either task')
        }
      }
    })
    try {
      const scheduler = createSchedulerStub()
      await scheduler.addJob({ task: 'embedPage' } as any)
      await scheduler.addJob({ task: 'dispatchWebhook' } as any)
      await scheduler.addJob({ task: 'embedPage' } as any)
      assert.equal(infos.length, 1)
      assert.equal(warnings.length, 1)
      assert.equal(warnings[0]!.fields?.task, 'dispatchWebhook')
    } finally {
      wikiHandle.restore()
    }
  })

  test('createSchedulerStub() drops autoTagPage silently: no warning, no info, no job row', async () => {
    const logged: unknown[] = []
    const wikiHandle = installTestWiki({
      logger: {
        info: (...args: unknown[]) => logged.push(args),
        warn: (...args: unknown[]) => logged.push(args)
      },
      db: {
        insert: () => {
          throw new Error('should not be called for autoTagPage')
        }
      }
    })
    try {
      const scheduler = createSchedulerStub()
      const result = await scheduler.addJob({
        task: 'autoTagPage',
        payload: { pageId: 'page-1' }
      } as any)
      assert.equal(result, undefined)
      assert.equal(logged.length, 0)
    } finally {
      wikiHandle.restore()
    }
  })
})

describe('resolveUsersImportContext (Task 14 review fix)', () => {
  test('resolves all three fields from a fully-populated CARDINAL', () => {
    const result = resolveUsersImportContext(fakeWiki())
    assert.deepEqual(result, {
      localStrategyId: 'local-auth-uuid',
      systemGroupIds: { admin: 'admin-group-uuid', guest: 'guest-group-uuid' },
      operatorActorId: 'admin-user-uuid'
    })
  })

  test('throws when CARDINAL.config.auth.rootAdminGroupId is missing (e.g. loadFromDb() was never called, or found an empty settings table)', () => {
    assert.throws(
      () => resolveUsersImportContext(fakeWiki({ config: { auth: {} } })),
      /rootAdminGroupId|adminGroupId/
    )
  })

  test('throws when CARDINAL.config.auth.rootAdminUserId is missing', () => {
    assert.throws(
      () =>
        resolveUsersImportContext(
          fakeWiki({ config: { auth: { rootAdminGroupId: 'admin-group-uuid' } } })
        ),
      /operatorActorId/
    )
  })

  test('throws when CARDINAL.data.systemIds is missing/malformed', () => {
    assert.throws(() => resolveUsersImportContext(fakeWiki({ data: { systemIds: {} } })))
  })
})

/**
 * `setupTestDb()`'s own `CARDINAL` always seeds `auth`, so a suite running against it cannot notice
 * `buildWikiShell()` dropping it; this one layers `setupTestDb()`'s `db` and `models` over a real
 * `buildWikiShell()` instead. `configSvc.init()`/`dbManager.init()` stay out: they `process.exit(1)`
 * without a `config.yml` at `process.cwd()`, and `npm test` runs from `backend/`, which has none.
 */
describe(
  'bootstrapMigrationRuntime CARDINAL shape: createStrategy() against a real bootstrap-shaped CARDINAL (Task 15 review fix, Critical #1)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
    })

    after(async () => {
      await teardownTestDb()
    })

    test('createStrategy() succeeds — and actually activates the new strategy — against a CARDINAL built from buildWikiShell()', async () => {
      // -> Captured before `installTestWiki()` replaces the global below.
      const models = CARDINAL.models
      const logger = CARDINAL.logger

      const wikiHandle = installTestWiki({
        ...buildWikiShell('bootstrap-shape-regression-test'),
        logger,
        dbManager: {},
        db: fixtures.db,
        models
      })

      try {
        await CARDINAL.models.authentication.refreshStrategiesFromDisk()

        let id: string | undefined
        await assert.doesNotReject(async () => {
          id = await CARDINAL.models.authentication.createStrategy({
            module: 'local',
            displayName: 'Bootstrap Shape Regression Test'
          })
        })
        assert.equal(typeof id, 'string')
        assert.ok(
          CARDINAL.auth.strategies[id!],
          'activateStrategies() actually ran and populated CARDINAL.auth.strategies for the new strategy, not merely avoided throwing'
        )
      } finally {
        // -> `teardownTestDb()` in `after()` needs `setupTestDb()`'s own CARDINAL back.
        wikiHandle.restore()
      }
    })
  }
)
