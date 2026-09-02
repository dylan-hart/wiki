import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import Emittery from 'emittery'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'

import dbManager, { queryLogger, type WikiDb } from './db.ts'
import configSvc from './config.ts'
import maintenance from './maintenance.ts'
import { groups } from '../models/groups.ts'
import { sites } from '../models/sites.ts'
import { approvalRules } from '../models/approvalRules.ts'
import { classificationLevels } from '../models/classificationLevels.ts'
import { glossary } from '../models/glossary.ts'
import { locales } from '../models/locales.ts'
import { relations } from '../db/relations.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../test/db.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * Task 708 (feature 411): confirms what `core/db.ts`'s `subscribeToNotifications()` /
 * `notifyViaDB()` actually guarantee for a cross-instance event relayed over the `wiki` NOTIFY
 * channel, and whether any current subscriber (`core/config.ts`'s `reloadConfig`,
 * `core/maintenance.ts`'s `disconnectWebsockets`/`flushCaches`, — added by OpenProject #966 —
 * `models/groups.ts`/`sites.ts`/`approvalRules.ts`'s `reloadGroups`/`reloadSites`/`reloadApprovals`,
 * — added by OpenProject #2042 — `models/locales.ts`'s `reloadLocales`, — added by OpenProject
 * #2038 — `models/glossary.ts`'s `invalidateGlossaryCache`, and — added by OpenProject #2030 —
 * `models/classificationLevels.ts`'s `reloadClassificationLevels`) depends on more than
 * that.
 *
 * Postgres NOTIFY has no persistence and no delivery guarantee: a message published while nobody
 * is LISTENing on that channel is dropped by the server, not queued for later delivery. `notifier`
 * (`helpers/pubsub.ts`'s `createNotifier`, wired here as the module-scoped `notifier` in `db.ts`)
 * mirrors that faithfully on the sending side — it reads the live client fresh on every send and
 * does nothing (no throw, no buffering) when there isn't one. Test 1 below exercises exactly that
 * condition: `WIKI.dbManager.pubsubClient` being `null`, which is the real state both while the
 * only other instance is down and during this instance's own listener reconnect window
 * (`helpers/pubsub.ts`'s `connectListener`, task 703) after a dropped connection and before the
 * next one lands.
 *
 * OpenProject #2030 added an eighth subscriber, `classificationLevels`'s
 * `reloadClassificationLevels` — same shape as `groups`/`sites`/`approvals`, stubbed and asserted
 * the same way below.
 *
 * A fake `Pool`/`PoolClient` pair stands in for postgres, matching `helpers/pubsub.test.ts`'s
 * fixtures — this is event-bus wiring and delivery-loss semantics, not SQL, so a mock is the right
 * tool per CLAUDE.md's testing guidance rather than a real two-`node backend` harness (also not
 * available in this environment; see `dev/multi-instance-verify/README.md` §8 for what that would
 * look like and why it is not needed to settle this question).
 *
 * **Finding**, expanded on in `dev/multi-instance-verify/README.md`: no subscriber is exposed to a
 * *permanently* missed event, because `index.ts`'s `preBoot()` calls `configSvc.loadFromDb()` and
 * `postBoot()` calls `groups`/`sites`/`locales`/`approvals`/`classificationLevels`
 * `.reloadCache()` unconditionally on every boot — not gated on any notification ever having
 * arrived. An instance that missed a
 * `reloadConfig`/`flushCaches`/`reloadGroups`/`reloadSites`/`reloadApprovals`/`reloadLocales`/`reloadClassificationLevels`
 * notify while it was down (or mid-restart) is fully resynced the moment it comes back, regardless
 * of what it missed. The
 * narrower residual gap is an instance that stays up throughout but loses one specific
 * notification during its own listener's brief reconnect window: nothing re-checks the DB for it
 * independently until the next matching event (another settings save, another manual "flush
 * caches" click) or its own next restart. That gap is judged low-severity and left undocumented in
 * code only via the comments here and in `helpers/pubsub.ts` and `core/db.ts`, rather than closed
 * with a new interval poller — see the README for the full reasoning.
 */

class FakeClient extends EventEmitter {
  released = false
  queries: Array<{ text: string; params?: unknown[] }> = []
  async query(text: string, params?: unknown[]): Promise<any> {
    this.queries.push({ text, params })
    return { rows: [] }
  }
  release(): void {
    this.released = true
  }
}

class FakePool {
  private queue: FakeClient[] = []
  connectCalls = 0
  endCalls = 0
  queueClient(client: FakeClient): void {
    this.queue.push(client)
  }
  async connect(): Promise<FakeClient> {
    this.connectCalls++
    const next = this.queue.shift()
    if (!next) {
      throw new Error('FakePool.connect() called with nothing queued')
    }
    return next
  }
  async end(): Promise<void> {
    this.endCalls++
  }
}

let wikiHandle: { restore(): void }
let loadFromDbMock: any
let flushCachesMock: any
let disconnectWebsocketsMock: any
let groupsReloadCacheMock: any
let sitesReloadCacheMock: any
let approvalsReloadCacheMock: any
let localesReloadCacheMock: any
let glossaryDropLocalCacheMock: any
let classificationLevelsReloadCacheMock: any

beforeEach(() => {
  loadFromDbMock = mock.fn(async () => true)
  flushCachesMock = mock.fn(async () => {})
  disconnectWebsocketsMock = mock.fn(() => 0)
  // -> OpenProject #966: `subscribeToNotifications()` also wires `groups`/`sites`/`approvals`
  //    `.subscribeToEvents()` now (see `core/db.ts`), which is real model code reachable off
  //    `WIKI.models` — stubbed here the same way `configSvc.loadFromDb`/`maintenance.flushCaches`
  //    already are, so this suite's minimal `WIKI` needs a `models` object at all.
  // -> OpenProject #2042: `locales` joins the same wiring.
  groupsReloadCacheMock = mock.fn(async () => {})
  sitesReloadCacheMock = mock.fn(async () => {})
  approvalsReloadCacheMock = mock.fn(async () => {})
  localesReloadCacheMock = mock.fn(async () => {})
  // -> OpenProject #2038: `subscribeToNotifications()` also wires `glossary.subscribeToEvents()` now
  //    (see `core/db.ts`) -- stubbed the same way, though its local effect is a cache delete rather
  //    than a DB re-fetch, so the stubbed method is `dropLocalCache`, not `reloadCache`.
  glossaryDropLocalCacheMock = mock.fn(() => {})
  // -> OpenProject #2030: `subscribeToNotifications()` also wires
  //    `classificationLevels.subscribeToEvents()` now (see `core/db.ts`), stubbed the same way as
  //    `groups`/`sites`/`approvals`/`locales`.
  classificationLevelsReloadCacheMock = mock.fn(async () => {})
  configSvc.loadFromDb = loadFromDbMock
  maintenance.flushCaches = flushCachesMock
  maintenance.disconnectWebsockets = disconnectWebsocketsMock
  groups.reloadCache = groupsReloadCacheMock
  sites.reloadCache = sitesReloadCacheMock
  approvalRules.reloadCache = approvalsReloadCacheMock
  locales.reloadCache = localesReloadCacheMock
  glossary.dropLocalCache = glossaryDropLocalCacheMock
  classificationLevels.reloadCache = classificationLevelsReloadCacheMock

  wikiHandle = installTestWiki({
    INSTANCE_ID: 'instance-a',
    events: { inbound: new Emittery(), outbound: new Emittery() },
    configSvc,
    dbManager,
    models: { groups, sites, approvalRules, locales, glossary, classificationLevels }
  })

  dbManager.pool = null
  dbManager.listenerPool = null
  dbManager.pubsubClient = null
  dbManager.listenerHandle = null
})

afterEach(async () => {
  await dbManager.unsubscribeFromNotifications()
})

after(() => {
  wikiHandle.restore()
})

describe('subscribeToNotifications() / notifyViaDB() — at-most-once delivery', () => {
  test('an event published while nobody is LISTENing (pubsubClient null) is silently dropped, never queued for replay', async () => {
    const pool = new FakePool()
    const initialClient = new FakeClient()
    pool.queueClient(initialClient)
    dbManager.listenerPool = pool as any

    await dbManager.subscribeToNotifications()
    assert.equal(dbManager.pubsubClient, initialClient)

    // -> Simulate the real "nobody is currently listening" state: the only other instance is down,
    //    or this instance's own listener is mid-reconnect (`connectListener`'s error handler does
    //    exactly this via `setClient(null)` before a fresh client lands).
    dbManager.pubsubClient = null

    // -> Fires synchronously off WIKI.events.outbound via onAny(notifyViaDB); must not throw even
    //    though there is nothing to send it on.
    await WIKI.events.outbound.emit('reloadConfig')

    // -> `createNotifier`'s send() is fire-and-forget internally (queued behind `tail`); wait for it.
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.deepEqual(
      initialClient.queries.map((q) => q.text),
      ["SET application_name = 'Wiki.js - instance-a:EVENTS'", 'LISTEN wiki'],
      'nothing beyond the initial connect/LISTEN was ever sent on the client that existed before the drop'
    )

    // -> Once a client is available again, the earlier dropped notification is not replayed: it
    //    was never buffered anywhere, so there is nothing to send.
    const secondClient = new FakeClient()
    dbManager.pubsubClient = secondClient as any
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(
      secondClient.queries,
      [],
      'no backlog is replayed onto a newly (re)connected client'
    )
  })

  test('an inbound notification echoing this same instance is ignored, one from another instance is not', async () => {
    const pool = new FakePool()
    const client = new FakeClient()
    pool.queueClient(client)
    dbManager.listenerPool = pool as any

    await dbManager.subscribeToNotifications()

    const received: Array<{ event: string; value: unknown }> = []
    // -> This build of `emittery` (2.x) hands every listener a `{ name, data }` wrapper, not the
    //    raw payload, even for a specific `.on(eventName, ...)` — the same shape `notifyViaDB`
    //    destructures off `onAny`. Matches how the codebase's own subscribers would read it, if
    //    they read the argument at all (today, neither does).
    WIKI.events.inbound.on('reloadConfig', (evt: any) => {
      received.push({ event: 'reloadConfig', value: evt.data })
    })

    // -> Self-echo: this instance published it, so hearing it back over NOTIFY must not re-trigger it.
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-a', event: 'reloadConfig', value: null })
    })
    // -> `WIKI.events.inbound.emit()` (called from `onNotification`) is async and unawaited there,
    //    matching production; give its listeners a tick before asserting either way.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(received, [])

    // -> A different instance's event is the real case this channel exists for.
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-b', event: 'reloadConfig', value: null })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(received, [{ event: 'reloadConfig', value: null }])
  })

  test('wires all eight current subscribers, each purely reactive to the notify with no independent re-check', async () => {
    const pool = new FakePool()
    const client = new FakeClient()
    pool.queueClient(client)
    dbManager.listenerPool = pool as any

    await dbManager.subscribeToNotifications()

    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-b', event: 'reloadConfig', value: null })
    })
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-b', event: 'flushCaches', value: null })
    })
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-b', event: 'disconnectWebsockets', value: null })
    })
    // -> OpenProject #966: group/site/approval cache reloads propagate the same way now
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-b', event: 'reloadGroups', value: null })
    })
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-b', event: 'reloadSites', value: null })
    })
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-b', event: 'reloadApprovals', value: null })
    })
    // -> OpenProject #2042: locale cache reloads propagate the same way now
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-b', event: 'reloadLocales', value: null })
    })
    // -> OpenProject #2038: glossary cache invalidation propagates the same way now
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({
        source: 'instance-b',
        event: 'invalidateGlossaryCache',
        value: { siteId: 'site-1' }
      })
    })
    // -> OpenProject #2030: classification-level cache reloads propagate the same way now
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({
        source: 'instance-b',
        event: 'reloadClassificationLevels',
        value: null
      })
    })

    // -> Emittery's inbound handlers run as microtasks; give them a tick.
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(loadFromDbMock.mock.calls.length, 1)
    assert.equal(flushCachesMock.mock.calls.length, 1)
    assert.equal(disconnectWebsocketsMock.mock.calls.length, 1)
    assert.equal(groupsReloadCacheMock.mock.calls.length, 1)
    assert.equal(sitesReloadCacheMock.mock.calls.length, 1)
    assert.equal(approvalsReloadCacheMock.mock.calls.length, 1)
    assert.equal(localesReloadCacheMock.mock.calls.length, 1)
    assert.equal(glossaryDropLocalCacheMock.mock.calls.length, 1)
    assert.deepEqual(glossaryDropLocalCacheMock.mock.calls[0].arguments, ['site-1'])
    assert.equal(classificationLevelsReloadCacheMock.mock.calls.length, 1)
  })
})

/**
 * OpenProject #2205: `queryLogger.logQuery` used to write `JSON.stringify(params)` of the whole
 * bound-parameter array at `info` level under either trigger, with no redaction — and a bound
 * parameter routinely carries a credential (`models/settings.ts#updateConfig` binds the whole
 * settings blob, including the API signing key/passphrase and the session secret, as one JSONB
 * parameter). These cases exercise the fix: the emitted line must carry a parameter's shape
 * (count, type, length) but never its value, under both `sqlLog` and `WIKI.config.dev.logQueries`
 * independently, since redaction has to sit inside `logQuery` itself rather than behind either
 * trigger's own `if`.
 */
describe('queryLogger.logQuery() — bound-parameter redaction', () => {
  let wikiHandle: { restore(): void }
  let infoCalls: string[]

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    infoCalls = []
    wikiHandle = installTestWiki({
      logger: {
        info: (msg: string) => {
          infoCalls.push(msg)
        },
        warn: () => {},
        debug: () => {},
        error: () => {}
      },
      config: { flags: { sqlLog: false }, dev: {} }
    })
  })

  // -> A PEM-shaped string (stands in for the API signing key) and a JSON blob carrying a `secret`
  //    key (stands in for `models/settings.ts`'s `auth` blob) — the two shapes OpenProject #2205
  //    calls out by name.
  const pemLikeParam =
    '-----BEGIN PRIVATE KEY-----\nMIIExampleNotARealKeyMaterialxxxxxxxxxxxxx\n-----END PRIVATE KEY-----'
  const secretBlobParam = {
    auth: { secret: 'super-secret-session-value', certs: { passphrase: 'hunter2-passphrase' } }
  }

  test('sqlLog flag on: query text is logged, neither the PEM value nor the secret-object value is', () => {
    WIKI.config.flags.sqlLog = true

    queryLogger.logQuery('select 1 from "settings" where "key" = $1 and "value" = $2', [
      pemLikeParam,
      secretBlobParam
    ])

    assert.equal(infoCalls.length, 1)
    const [line] = infoCalls
    assert.ok(line.includes('select 1 from "settings"'), 'query text is still logged')
    assert.ok(!line.includes(pemLikeParam), 'PEM value must not appear')
    assert.ok(!line.includes('BEGIN PRIVATE KEY'), 'PEM value must not appear, even in part')
    assert.ok(!line.includes('super-secret-session-value'), 'session secret value must not appear')
    assert.ok(!line.includes('hunter2-passphrase'), 'passphrase value must not appear')
    assert.ok(!line.includes(JSON.stringify(secretBlobParam)), 'no JSON.stringify of the params')
    // -> Shape is still useful for debugging: count, and a type/length per parameter.
    assert.match(line, /2 params/)
    assert.match(line, /string\(\d+\)/)
    assert.match(line, /object/)
  })

  test('WIKI.config.dev.logQueries on, sqlLog flag off: the same redaction applies independently', () => {
    WIKI.config.flags.sqlLog = false
    WIKI.config.dev.logQueries = true

    queryLogger.logQuery('update "settings" set "value" = $1', [secretBlobParam])

    assert.equal(infoCalls.length, 1)
    const [line] = infoCalls
    assert.ok(!line.includes('super-secret-session-value'), 'session secret value must not appear')
    assert.ok(!line.includes('hunter2-passphrase'), 'passphrase value must not appear')
    assert.ok(!line.includes(JSON.stringify(secretBlobParam)), 'no JSON.stringify of the params')
  })

  test('both triggers off: nothing is logged at all', () => {
    WIKI.config.flags.sqlLog = false
    WIKI.config.dev.logQueries = false

    queryLogger.logQuery('select 1', [pemLikeParam])

    assert.equal(infoCalls.length, 0)
  })

  test('no bound parameters: query text is logged with no trailing parameter section', () => {
    WIKI.config.flags.sqlLog = true

    queryLogger.logQuery('select 1', [])

    assert.deepEqual(infoCalls, ['[SQL] select 1'])
  })
})

/**
 * Task 2270: `dev.dropSchema` must not be honored outside a debug boot, even though the config value
 * itself carries no environment condition -- see `dropSchemaIfDev`'s own doc comment in `core/db.ts`
 * for the full reasoning. A fake `db` (just an `execute` mock.fn, matching this suite's other fakes)
 * stands in for the real Drizzle instance since this is pure guard logic, not SQL.
 */
describe('dropSchemaIfDev() — WIKI.IS_DEBUG guard (task 2270)', () => {
  let executeMock: any
  let warnMock: any
  let fakeDb: any

  beforeEach(() => {
    executeMock = mock.fn(async () => ({ rows: [] }))
    fakeDb = { execute: executeMock }
    warnMock = mock.fn(() => {})
    WIKI.logger.warn = warnMock
    WIKI.config = { db: { schema: 'wiki' }, dev: {} }
  })

  test('dropSchema set, IS_DEBUG false: the schema is NOT dropped, and a refusal is logged', async () => {
    WIKI.IS_DEBUG = false
    WIKI.config.dev.dropSchema = true

    await dbManager.dropSchemaIfDev(fakeDb)

    assert.equal(executeMock.mock.calls.length, 0)
    assert.equal(warnMock.mock.calls.length, 1)
    assert.match(warnMock.mock.calls[0].arguments[0], /refused/i)
    assert.match(warnMock.mock.calls[0].arguments[0], /NOT dropped/)
  })

  test('dropSchema set, IS_DEBUG true: the schema IS dropped', async () => {
    WIKI.IS_DEBUG = true
    WIKI.config.dev.dropSchema = true

    await dbManager.dropSchemaIfDev(fakeDb)

    assert.equal(executeMock.mock.calls.length, 1)
    assert.match(executeMock.mock.calls[0].arguments[0], /DROP SCHEMA IF EXISTS wiki CASCADE/)
  })

  test('dropSchema unset: nothing happens regardless of IS_DEBUG, and nothing is logged', async () => {
    WIKI.IS_DEBUG = true
    WIKI.config.dev.dropSchema = false

    await dbManager.dropSchemaIfDev(fakeDb)

    assert.equal(executeMock.mock.calls.length, 0)
    assert.equal(warnMock.mock.calls.length, 0)
  })
})

/**
 * Task 2249: `init()`'s `new Pool({...})` now carries an explicit `max`, `connectionTimeoutMillis`
 * and (via the `options` connection string, alongside `search_path`) `statement_timeout`, all sourced
 * from `WIKI.config.pool` (defaulted in `base.yml`, operator-tunable via `config.yml`). Unset, pg-pool
 * falls back to `max: 10` with no connect or statement bound at all, so a saturated pool or a runaway
 * query blocks its caller forever (`docs/audit-2026-08-24/security/12-infrastructure-ops.md` §2).
 *
 * These exercise real `pg` `Pool`/Postgres behavior against the config values `db.ts#init()` now
 * passes through — a mock of `pg-pool`'s internal checkout queue or Postgres's own timeout enforcement
 * would mostly just restate what's under test rather than verify it, so this is the DB-backed
 * exception CLAUDE.md's testing guidance carves out. Gated on `DATABASE_URL` like every other
 * DB-backed suite in this file — `npm run test` reports these as skipped without one.
 */
describe('main pool bounds (task 2249)', { skip: !hasTestDatabase() }, () => {
  let pool: Pool | undefined

  afterEach(async () => {
    await pool?.end()
    pool = undefined
  })

  test('a third concurrent checkout on a max:2 pool rejects within connectionTimeoutMillis rather than hanging forever', async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 300
    })

    // -> Check out both connections and never release them, saturating the pool exactly the way a
    //    stuck query or a leaked client would in production.
    const held = await Promise.all([pool.connect(), pool.connect()])

    const startedAt = Date.now()
    await assert.rejects(
      () => pool!.connect(),
      /timeout exceeded when trying to connect/,
      'a third checkout on a saturated max:2 pool must reject, not hang'
    )
    const elapsedMs = Date.now() - startedAt
    assert.ok(
      elapsedMs < 2000,
      `expected the rejection at ~connectionTimeoutMillis (300ms), took ${elapsedMs}ms`
    )

    for (const client of held) {
      client.release()
    }
  })

  test('a query exceeding statement_timeout is cancelled by Postgres rather than running unbounded', async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      // -> Mirrors how `db.ts#init()` appends `statement_timeout` to the `options` connection string
      //    alongside `search_path`, rather than a dedicated pg-pool config key (there isn't one).
      options: '-c statement_timeout=300'
    })

    await assert.rejects(
      () => pool!.query('SELECT pg_sleep(2)'),
      /statement timeout/,
      'a query past statement_timeout must be cancelled by Postgres, not left to run to completion'
    )
  })
})

/**
 * OpenProject #2049: `init()` builds `this.pool = new Pool({...})` and, until now, never attached an
 * `error` listener to it. node-postgres emits `error` on the pool whenever a checked-in, idle
 * client's connection fails (a Postgres restart, a failover, an idle timeout) -- `Pool extends
 * EventEmitter`, so an unhandled `error` is re-thrown as an uncaught exception and takes the whole
 * process down, exactly the failure mode `helpers/pubsub.ts`'s `connectListener` already guards
 * against for the dedicated LISTEN clients. This is the same regression-test shape
 * `helpers/pubsub.test.ts` uses for that listener path, aimed at the main pool instead.
 *
 * `Pool.prototype.query` is mocked at the `pg` level rather than reaching for a real Postgres
 * connection: `init()`'s own query traffic (`connect()`'s `SELECT 1 + 1;`, then `SHOW
 * server_version;`) both go through `drizzle-orm/node-postgres`'s session, which calls
 * `this.client.query(...)` directly on the pool handed to `createDb()` -- so intercepting
 * `Pool.prototype.query` is enough to run the real `init()` end to end with no `DATABASE_URL` and no
 * network I/O. `workerMode: true` additionally skips `syncSchemas()` (real migrations), which is the
 * only other DB-touching step `init()` takes.
 */
describe('init() attaches an error listener to the main pool (OpenProject #2049)', () => {
  let wikiHandle: { restore(): void }
  let previousDatabaseUrl: string | undefined
  let queryMock: ReturnType<typeof mock.method>
  let loggerErrorMock: any

  before(() => {
    previousDatabaseUrl = process.env.DATABASE_URL
    delete process.env.DATABASE_URL

    queryMock = mock.method(Pool.prototype, 'query', async function (queryConfig: any) {
      const text = typeof queryConfig === 'string' ? queryConfig : queryConfig?.text
      if (typeof text === 'string' && text.includes('SHOW server_version')) {
        return { rows: [{ server_version: '16.4' }] }
      }
      return { rows: [] }
    })
  })

  after(() => {
    queryMock.mock.restore()
    wikiHandle.restore()
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl
    }
  })

  beforeEach(() => {
    loggerErrorMock = mock.fn(() => {})
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'instance-a',
      logger: { warn: () => {}, info: () => {}, debug: () => {}, error: loggerErrorMock },
      config: {
        db: {
          host: '127.0.0.1',
          user: 'wiki',
          pass: 'wiki',
          db: 'wiki',
          port: 5432,
          schema: 'public',
          ssl: false
        },
        pool: {}
      }
    })
    dbManager.pool = null
    dbManager.pubsubClient = null
    dbManager.listenerHandle = null
    dbManager.connectAttempts = 0
  })

  afterEach(async () => {
    if (dbManager.pool) {
      await dbManager.pool.end()
      dbManager.pool = null
    }
  })

  test('the constructed pool has an error listener registered', async () => {
    await dbManager.init(true)

    assert.ok(dbManager.pool, 'init() should have set dbManager.pool')
    assert.ok(
      dbManager.pool!.listenerCount('error') >= 1,
      'the pool should have at least one error listener attached'
    )
  })

  test('emitting error on the pool logs through WIKI.logger.error rather than throwing', async () => {
    await dbManager.init(true)

    const err: any = new Error('Connection terminated unexpectedly')
    err.code = 'ECONNRESET'

    assert.doesNotThrow(() => {
      dbManager.pool!.emit('error', err)
    })

    assert.equal(loggerErrorMock.mock.calls.length, 1)
    const [message] = loggerErrorMock.mock.calls[0].arguments
    assert.match(message, /ECONNRESET/)
    assert.match(message, /Connection terminated unexpectedly/)
  })
})

/**
 * Task 1887 (epic 1878): `subscribeToNotifications()` used to check its client out of `dbManager.pool`
 * -- the same pool application queries run against -- so holding it for the process lifetime silently
 * cost the configured `max` one connection. It must check out of the dedicated `dbManager.listenerPool`
 * instead, and never touch the query pool at all.
 */
describe('subscribeToNotifications() checks out from the dedicated listener pool, not the query pool', () => {
  test('connects via dbManager.listenerPool and never calls dbManager.pool.connect()', async () => {
    const listenerPool = new FakePool()
    const client = new FakeClient()
    listenerPool.queueClient(client)
    dbManager.listenerPool = listenerPool as any

    // -> Stands in for the main query pool -- application queries would run against this, and
    //    `subscribeToNotifications()` must never check a client out of it.
    const queryPool = new FakePool()
    dbManager.pool = queryPool as any

    await dbManager.subscribeToNotifications()

    assert.equal(dbManager.pubsubClient, client)
    assert.equal(listenerPool.connectCalls, 1)
    assert.equal(queryPool.connectCalls, 0)
  })
})

describe('shutdown() — OpenProject #2023', () => {
  test('unsubscribes from notifications before ending the pool, and resolves once both have completed', async () => {
    const order: string[] = []
    const pool = new FakePool()
    const client = new FakeClient()
    // -> Instrument the two steps shutdown() composes, in the order it must run them: releasing the
    //    LISTEN client (part of unsubscribeFromNotifications()'s teardown) has to be observed before
    //    the pool is ended.
    const originalRelease = client.release.bind(client)
    client.release = () => {
      order.push('unsubscribed')
      originalRelease()
    }
    const originalEnd = pool.end.bind(pool)
    pool.end = async () => {
      order.push('pool-ended')
      await originalEnd()
    }
    pool.queueClient(client)
    dbManager.pool = pool as any
    // -> subscribeToNotifications() checks its client out of `listenerPool`, not `pool` (see
    //    "subscribeToNotifications() checks out from the dedicated listener pool" above) -- left
    //    unset here, `connectListener` would call `.connect()` on `null` and its `reconnect()` loop
    //    catches that TypeError like any other connection failure, retrying forever rather than
    //    surfacing it. Same fake pool/client stands in for both roles: shutdown() ends `dbManager.pool`
    //    and releases whatever client `dbManager.listenerPool` handed out, and this test only needs to
    //    observe both of those against the one instrumented pair.
    dbManager.listenerPool = pool as any

    await dbManager.subscribeToNotifications()
    assert.equal(dbManager.listenerHandle !== null, true, 'precondition: listener is subscribed')

    const result = await dbManager.shutdown()

    assert.equal(result, undefined, 'shutdown() resolves once both steps have completed')
    assert.deepEqual(
      order,
      ['unsubscribed', 'pool-ended'],
      'the pool is not ended until unsubscribeFromNotifications() has released its client'
    )
    assert.equal(dbManager.listenerHandle, null, 'unsubscribeFromNotifications() ran to completion')
    assert.equal(pool.endCalls, 1)
  })

  test('tolerates a pool that was never initialized (pool is null)', async () => {
    dbManager.pool = null
    dbManager.listenerHandle = null

    await assert.doesNotReject(dbManager.shutdown())
  })
})

/**
 * Task 2041 (epic 2037): `syncSchemas()` now holds a session-scoped advisory lock across its
 * `CREATE SCHEMA` / `CREATE EXTENSION` / `migrate()`, so two instances racing to migrate a fresh
 * database no longer both compute the same non-empty migration set and collide on `relation already
 * exists` — the loser blocks on the lock instead, then re-reads an already-migrated state.
 *
 * DB-backed (real Postgres, real migrations) rather than mocked: the thing under test is genuine
 * cross-connection serialization, which a fake `Pool` would only re-describe, not verify — same
 * reasoning as `helpers/advisoryLock.test.ts`. Gated on `hasTestDatabase()` per CLAUDE.md.
 *
 * This describe nests its own `beforeEach`/`afterEach` rather than relying on a one-time `before()`:
 * the file-level `beforeEach`/`afterEach` above (for the mock-`Pool` NOTIFY tests) unconditionally
 * reset `dbManager.pool` to `null` and stub `globalThis.WIKI` before/after *every* test in this file,
 * including these — nested hooks run after the outer `beforeEach` and before the outer `afterEach`,
 * so they are what re-establish real DB state for the duration of each test here.
 */
describe('syncSchemas() — advisory lock across DDL and migrate() (task 2041)', () => {
  const skip = hasTestDatabase() ? false : 'requires DATABASE_URL'
  let pool: Pool
  let schema: string
  let outerWiki: any

  before(async () => {
    if (!hasTestDatabase()) {
      return
    }
    // -> Guarantees `ltree`/`pg_trgm` already exist somewhere in this database before the race test
    //    below runs its own `CREATE EXTENSION IF NOT EXISTS` calls: that statement is not atomic
    //    against another session doing the same thing for the first time concurrently (see
    //    `test/db.ts`'s `createExtensionsSerialized`), and `node --test` runs other DB-backed suites'
    //    files in parallel against the same `DATABASE_URL`. `setupTestDb()` creates the extensions
    //    serialized against every other suite doing the same; its own throwaway schema is dropped
    //    again immediately.
    await setupTestDb()
    await teardownTestDb()
  })

  beforeEach(() => {
    const DATABASE_URL = process.env.DATABASE_URL
    if (!DATABASE_URL) {
      return
    }
    outerWiki = (globalThis as any).WIKI
    schema = `test_syncschemas_${randomBytes(6).toString('hex')}`
    // -> `public` stays on the search path behind the fresh schema, matching both production
    //    (`core/db.ts#init`'s own Pool `options`) and `test/db.ts`'s `setupTestDb()`: an unqualified
    //    `CREATE TYPE`/`CREATE TABLE` inside a migration file targets whichever schema is first on
    //    the connection's search_path, not `WIKI.config.db.schema` by name — without this, this
    //    suite's own migration lands in `public` instead of the fresh schema it thinks it owns, and
    //    can collide with a same-named type/table another suite (or a leftover prior run) already
    //    left there.
    pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema},public` })
    dbManager.pool = pool
    wikiHandle = installTestWiki({
      config: { db: { schema } },
      SERVERPATH: path.join(import.meta.dirname, '..')
    })
  })

  afterEach(async () => {
    if (!hasTestDatabase()) {
      return
    }
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await pool.end()
    dbManager.pool = null
    ;(globalThis as any).WIKI = outerWiki
  })

  test(
    'two concurrent syncSchemas() calls against a fresh schema both resolve, and the migration runs exactly once',
    { skip },
    async () => {
      const db = drizzle({ client: pool, relations }) as WikiDb

      const results = await Promise.allSettled([
        dbManager.syncSchemas(db).then((lock) => lock.release()),
        dbManager.syncSchemas(db).then((lock) => lock.release())
      ])

      for (const result of results) {
        if (result.status === 'rejected') {
          assert.fail(`syncSchemas() rejected: ${result.reason}`)
        }
      }

      // -> Confirms a migration genuinely ran (not just that neither call threw) and that the
      //    concurrent second call did not re-run it: drizzle's migrator inserts one `migrations` row
      //    per migration file, applied exactly once regardless of how many callers raced for the lock.
      const migrationsCount = await pool.query(
        `SELECT count(*)::int AS count FROM "${schema}".migrations`
      )
      assert.ok(
        migrationsCount.rows[0].count > 0,
        'expected at least one migration to have been applied'
      )
    }
  )
})
