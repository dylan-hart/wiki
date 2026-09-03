import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import authenticationRoutes from './index.ts'
import { authentication as authenticationTable } from '../../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { installTestWiki } from '../../test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * #1616: `POST /authentication/strategies` used to answer an unknown `module` with a hardcoded
 * English sentence, which surfaced verbatim in the UI instead of translating like the rest of a
 * `t(key, fallback)` screen. Assert the coded `ERR_*` shape rather than any particular wording.
 */
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

/**
 * OpenProject #2234: a strategy save is one of the most permission-affecting operations in the
 * product (it decides which strategies exist, are enabled, and which groups they auto-enroll), and
 * left no audit record at all before this. DB-backed, against the real `models/authentication.ts`
 * and `models/auditLog.ts` -- the point under test is that a real update through the real route
 * writes a real row, not that a stub was called with the right arguments.
 */
describe(
  'PUT /authentication/strategies/:strategyId — records auth.strategyUpdated (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let app: FastifyInstance
    let fixtures: TestFixtures
    let strategyId: string

    before(async () => {
      fixtures = await setupTestDb()
      // -> `validateStrategy()` (`models/authentication.ts`) reads `WIKI.data.systemIds.localAuthId`
      //    unconditionally to decide whether the strategy being saved is the un-disableable built-in
      //    one -- `setupTestDb()` leaves `WIKI.data` empty, so this has to be set before any save can
      //    run at all. Deliberately not the fixture strategy's own id, so it is treated as an
      //    ordinary (not built-in) strategy, matching what this test is actually saving.
      ;(globalThis as any).WIKI.data.systemIds = { localAuthId: 'not-this-strategy' }

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
        // -> Stand-in for `@fastify/session` + the real login-established `req.session.user`: what
        //    `actorFromRequest()` (`models/auditLog.ts`) reads to name the actor.
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

      const { entries } = await WIKI.models.auditLog.list({ event: 'auth.strategyUpdated' })
      assert.equal(entries.length, 1)
      const entry = entries[0]!
      assert.equal(entry.actor.id, fixtures.userId)
      assert.equal(entry.actor.name, 'Fixture User')
      assert.equal(entry.targetType, 'authStrategy')
      assert.equal(entry.targetId, strategyId)
      assert.equal(entry.detail.module, 'test-module')
      assert.deepEqual([...entry.detail.changedFields].sort(), ['config', 'displayName'])
      // -> `detail` names which fields changed, never their values -- the secret submitted above
      //    must not surface anywhere in the recorded entry.
      assert.doesNotMatch(JSON.stringify(entry.detail), /super-secret-value/)
    })
  }
)

/**
 * OpenProject #2440: unlike the rest of this file, `GET /authentication/synced-groups` is reachable
 * without `manage:system` — it names no secrets, only group/strategy ids and display names, so the
 * admin group-assignment warning UI (gated on `manage:users`/`manage:groups`) can call it directly.
 */
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
      // -> Authenticated, but holding an unrelated permission -- distinct from holding none at all,
      //    which `permissionPreHandler` answers 401 for instead (an empty/absent permission list is
      //    treated as not authenticated, not merely as lacking this route's permission).
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

/**
 * OpenProject #2469: `allowedEmailDomains` is a per-strategy config field (a friendlier alternative
 * to `allowedEmailRegex`), wired through the same create/update routes as every other strategy
 * field. DB-backed against the real route + model, same pattern as the `auth.strategyUpdated`
 * describe above.
 */
describe(
  'authentication strategies routes: allowedEmailDomains',
  { skip: !hasTestDatabase() },
  () => {
    let app: FastifyInstance
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
      ;(globalThis as any).WIKI.data.systemIds = { localAuthId: 'not-this-strategy' }
      // -> `createStrategy()`/`validateStrategy()` resolve the module through `getModule()`, which
      //    reads `WIKI.data.authentication` -- populated from real on-disk `definition.yml` files
      //    the same way `models/authentication.test.ts`'s own suites do.
      await WIKI.models.authentication.refreshStrategiesFromDisk()

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

      const saved = await WIKI.models.authentication.getStrategyById(strategyId)
      assert.deepEqual([...saved!.allowedEmailDomains].sort(), ['example.com', 'other.org'])
    })
  }
)
