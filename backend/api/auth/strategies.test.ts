import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import authenticationRoutes from './index.ts'
import { authentication as authenticationTable } from '../../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { installTestWiki } from '../../test/mocks.ts'

let wikiHandle: { restore(): void }

/** The UI translates by error code, so assert the coded `ERR_*` shape rather than any wording. */
describe('POST /authentication/strategies (unknown module)', () => {
  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      models: {
        authentication: {
          getModule: () => null
        }
      }
    })

    app = await buildTestApp({ routes: authenticationRoutes })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  test('POST /authentication/strategies rejects an unknown module with a coded error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/authentication/strategies',
      payload: { module: 'not-a-real-module' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().message, 'ERR_UNKNOWN_AUTH_MODULE')
  })
})

describe(
  'PUT /authentication/strategies/:strategyId — records auth.strategyUpdated (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let app: FastifyInstance
    let fixtures: TestFixtures
    let strategyId: string

    before(async () => {
      fixtures = await setupTestDb()
      // -> Deliberately not the fixture strategy's own id, so it saves as an ordinary strategy
      //    rather than the un-disableable built-in one
      ;(globalThis as any).CARDINAL.data.systemIds = { localAuthId: 'not-this-strategy' }

      const [strategy] = await fixtures.db
        .insert(authenticationTable)
        .values({
          module: 'test-module',
          displayName: 'Test Strategy',
          isEnabled: true,
          config: {}
        })
        .returning({ id: authenticationTable.id })
      strategyId = strategy!.id

      app = await buildTestApp({
        routes: authenticationRoutes,
        ajv: true,
        // -> What `actorFromRequest()` reads to name the actor
        session: () => ({ user: { id: fixtures.userId, name: 'Fixture User' } })
      })
    })

    after(async () => {
      await app.close()
      await teardownTestDb()
    })

    test('a strategy save writes one auth.strategyUpdated row naming the actor and strategy module, never a secret value', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/authentication/strategies/${strategyId}`,
        payload: {
          displayName: 'Renamed Strategy',
          config: { clientSecret: 'super-secret-value' }
        }
      })

      assert.equal(res.statusCode, 200)
      assert.equal(res.json().ok, true)

      const { entries } = await CARDINAL.models.auditLog.list({ event: 'auth.strategyUpdated' })
      assert.equal(entries.length, 1)
      const entry = entries[0]!
      assert.equal(entry.actor.id, fixtures.userId)
      assert.equal(entry.actor.name, 'Fixture User')
      assert.equal(entry.targetType, 'authStrategy')
      assert.equal(entry.targetId, strategyId)
      assert.equal(entry.detail.module, 'test-module')
      assert.deepEqual([...entry.detail.changedFields].sort(), ['config', 'displayName'])
      assert.doesNotMatch(JSON.stringify(entry.detail), /super-secret-value/)
    })
  }
)

describe('GET /authentication/synced-groups', () => {
  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      models: {
        authentication: {
          getGroupSyncWarnings: async () => [
            {
              groupId: 'group-editors',
              strategies: [{ id: 'strategy-1', displayName: 'Corp OIDC' }]
            }
          ]
        }
      }
    })

    app = await buildTestApp({
      routes: authenticationRoutes,
      permissions: true,
      session: { authenticated: true, permissions: ['manage:users'], groups: [] }
    })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  test('a manage:users holder (no manage:system) can read the warnings', async () => {
    const res = await app.inject({ method: 'GET', url: '/authentication/synced-groups' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [
      { groupId: 'group-editors', strategies: [{ id: 'strategy-1', displayName: 'Corp OIDC' }] }
    ])
  })
})

describe('GET /authentication/synced-groups (none of the four allowed permissions)', () => {
  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      models: {
        authentication: {
          getGroupSyncWarnings: async () => {
            throw new Error('should not be called')
          }
        }
      }
    })

    app = await buildTestApp({
      routes: authenticationRoutes,
      permissions: true,
      session: { authenticated: true, permissions: ['read:pages'], groups: [] }
    })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  test('is refused 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/authentication/synced-groups' })
    assert.equal(res.statusCode, 403)
  })
})

describe('GET /authentication/strategies/visible-site-counts', () => {
  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      models: {
        authentication: {
          getVisibleSiteCounts: async () => ({ 'strategy-1': 2, 'strategy-2': 0 })
        }
      }
    })

    app = await buildTestApp({
      routes: authenticationRoutes,
      permissions: true,
      session: { authenticated: true, permissions: ['manage:system'], groups: [] }
    })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  test("turns the model's id -> count map into an array of {id, visibleSiteCount}", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/authentication/strategies/visible-site-counts'
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [
      { id: 'strategy-1', visibleSiteCount: 2 },
      { id: 'strategy-2', visibleSiteCount: 0 }
    ])
  })
})

describe('GET /authentication/strategies/visible-site-counts (no manage:system)', () => {
  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      models: {
        authentication: {
          getVisibleSiteCounts: async () => {
            throw new Error('should not be called')
          }
        }
      }
    })

    app = await buildTestApp({
      routes: authenticationRoutes,
      permissions: true,
      session: { authenticated: true, permissions: ['read:pages'], groups: [] }
    })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  test('is refused 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/authentication/strategies/visible-site-counts'
    })
    assert.equal(res.statusCode, 403)
  })
})

describe(
  'authentication strategies routes: allowedEmailDomains',
  { skip: !hasTestDatabase() },
  () => {
    let app: FastifyInstance
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
      ;(globalThis as any).CARDINAL.data.systemIds = { localAuthId: 'not-this-strategy' }
      // -> `getModule()` reads `CARDINAL.data.authentication`, filled here from the real on-disk
      //    `definition.yml` files
      await CARDINAL.models.authentication.refreshStrategiesFromDisk()

      app = await buildTestApp({ routes: authenticationRoutes, ajv: true })
    })

    after(async () => {
      await app.close()
      await teardownTestDb()
    })

    test('POST rejects a strategy whose allowedEmailDomains entry is not a valid domain', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/authentication/strategies',
        payload: { module: 'local', allowedEmailDomains: ['not a domain'] }
      })
      assert.equal(res.statusCode, 400)
      assert.match(res.json().message, /not a valid domain/)
    })

    test('PUT stores allowedEmailDomains trimmed, lower-cased and deduped', async () => {
      const [strategy] = await fixtures.db
        .insert(authenticationTable)
        .values({ module: 'local', displayName: 'Domain Test', isEnabled: true, config: {} })
        .returning({ id: authenticationTable.id })
      const strategyId = strategy!.id

      const res = await app.inject({
        method: 'PUT',
        url: `/authentication/strategies/${strategyId}`,
        payload: { allowedEmailDomains: [' Example.com ', 'EXAMPLE.COM', 'other.org'] }
      })
      assert.equal(res.statusCode, 200)

      const saved = await CARDINAL.models.authentication.getStrategyById(strategyId)
      assert.deepEqual([...saved!.allowedEmailDomains].sort(), ['example.com', 'other.org'])
    })
  }
)
