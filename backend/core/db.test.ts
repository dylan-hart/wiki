import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import Emittery from 'emittery'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'

import dbManager, { instrumentSlowQueries, queryLogger, type WikiDb } from './db.ts'
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
 * Postgres NOTIFY is at-most-once: a message published while nobody is LISTENing is dropped, not
 * queued, and `helpers/pubsub.ts#createNotifier` mirrors that by doing nothing when there is no
 * live client. That is an accepted contract, not a gap to close: every boot reloads config and
 * caches unconditionally — see `dev/multi-instance-verify/README.md`.
 *
 * A fake `Pool`/`PoolClient` stands in for postgres: this is event-bus wiring, not SQL.
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
  // -> `subscribeToNotifications()` calls each model's real `subscribeToEvents()` off
  //    `CARDINAL.models`, so the real singletons are installed with only their local effect stubbed.
  groupsReloadCacheMock = mock.fn(async () => {})
  sitesReloadCacheMock = mock.fn(async () => {})
  approvalsReloadCacheMock = mock.fn(async () => {})
  localesReloadCacheMock = mock.fn(async () => {})
  glossaryDropLocalCacheMock = mock.fn(() => {})
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

    // -> The real mid-reconnect state: `connectListener`'s error handler nulls the client before a
    //    fresh one lands.
    dbManager.pubsubClient = null

    // -> Must not throw with nothing to send on.
    await CARDINAL.events.outbound.emit('reloadConfig')

    // -> `createNotifier`'s send() is fire-and-forget internally; wait for it.
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.deepEqual(
      initialClient.queries.map((q) => q.text),
      ["SET application_name = 'Cardinal.js - instance-a:EVENTS'", 'LISTEN wiki'],
      'nothing beyond the initial connect/LISTEN was ever sent on the client that existed before the drop'
    )

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
    // -> emittery hands every listener a `{ name, data }` wrapper, not the raw payload, even for a
    //    specific `.on(eventName, ...)`.
    CARDINAL.events.inbound.on('reloadConfig', (evt: any) => {
      received.push({ event: 'reloadConfig', value: evt.data })
    })

    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-a', event: 'reloadConfig', value: null })
    })
    // -> `onNotification` does not await `inbound.emit()`; give its listeners a tick.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(received, [])

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
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({ source: 'instance-b', event: 'reloadLocales', value: null })
    })
    client.emit('notification', {
      channel: 'wiki',
      payload: JSON.stringify({
        source: 'instance-b',
        event: 'invalidateGlossaryCache',
        value: { siteId: 'site-1' }
      })
    })
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
 * A bound parameter routinely carries a credential (`models/settings.ts#updateConfig` binds the
 * whole settings blob, signing key and session secret included, as one JSONB parameter), so the
 * line may carry a parameter's shape (count, type, length) but never its value. `logQuery` emits
 * unconditionally and leaves suppression to the logger's per-scope threshold, so the redaction
 * cannot sit behind a gate.
 */
describe('queryLogger.logQuery() — bound-parameter redaction', () => {
  let wikiHandle: { restore(): void }
  // -> Message and `params` field joined, so one string covers both places a value could leak.
  let sqlCalls: string[]

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    sqlCalls = []
    wikiHandle = installTestWiki({
      logger: {
        info: () => {},
        warn: () => {},
        debug: (scope: string, msg: string, fields?: Record<string, unknown>) => {
          assert.equal(scope, 'sql')
          sqlCalls.push(fields ? `${msg}  params=${fields.params}` : msg)
        },
        error: () => {}
      },
      config: { flags: { sqlLog: false } }
    })
  })

  // -> Stand-ins for the API signing key and for `models/settings.ts`'s `auth` blob.
  const pemLikeParam =
    '-----BEGIN PRIVATE KEY-----\nMIIExampleNotARealKeyMaterialxxxxxxxxxxxxx\n-----END PRIVATE KEY-----'
  const secretBlobParam = {
    auth: { secret: 'super-secret-session-value', certs: { passphrase: 'hunter2-passphrase' } }
  }

  test('query text is logged, neither the PEM value nor the secret-object value is', () => {
    queryLogger.logQuery('select 1 from "settings" where "key" = $1 and "value" = $2', [
      pemLikeParam,
      secretBlobParam
    ])

    assert.equal(sqlCalls.length, 1)
    const [line] = sqlCalls
    assert.ok(line.includes('select 1 from "settings"'), 'query text is still logged')
    assert.ok(!line.includes(pemLikeParam), 'PEM value must not appear')
    assert.ok(!line.includes('BEGIN PRIVATE KEY'), 'PEM value must not appear, even in part')
    assert.ok(!line.includes('super-secret-session-value'), 'session secret value must not appear')
    assert.ok(!line.includes('hunter2-passphrase'), 'passphrase value must not appear')
    assert.ok(!line.includes(JSON.stringify(secretBlobParam)), 'no JSON.stringify of the params')
    assert.match(line, /2 params/)
    assert.match(line, /string\(\d+\)/)
    assert.match(line, /object/)
  })

  test('redaction does not depend on the sqlLog flag, which no longer gates the call', () => {
    CARDINAL.config.flags.sqlLog = true

    queryLogger.logQuery('update "settings" set "value" = $1', [secretBlobParam])

    assert.equal(sqlCalls.length, 1)
    const [line] = sqlCalls
    assert.ok(!line.includes('super-secret-session-value'), 'session secret value must not appear')
    assert.ok(!line.includes('hunter2-passphrase'), 'passphrase value must not appear')
    assert.ok(!line.includes(JSON.stringify(secretBlobParam)), 'no JSON.stringify of the params')
  })

  test('the flag being off does not silence the call — the threshold does that (#2663)', () => {
    CARDINAL.config.flags.sqlLog = false

    queryLogger.logQuery('select 1', [pemLikeParam])

    assert.equal(sqlCalls.length, 1)
    assert.ok(!sqlCalls[0]!.includes(pemLikeParam), 'PEM value must not appear')
  })

  test('no bound parameters: query text is logged with no trailing parameter section', () => {
    queryLogger.logQuery('select 1', [])

    assert.deepEqual(sqlCalls, ['select 1'])
  })
})

/**
 * A fake `pg` client rather than live Postgres: the behaviour under test is all in
 * `instrumentSlowQueries`'s wrapper, and a real database would make "80ms is slow, 0ms is not" a
 * property of the machine running the suite.
 *
 * Redaction is re-asserted here because the slow line is a second route out of the process for the
 * same bound parameters — a `warn` one, visible at the default `logLevel`.
 */
describe('instrumentSlowQueries() — slowQueryMs (#2676)', () => {
  let wikiHandle: { restore(): void }
  let warnCalls: any[][]
  let debugCalls: any[][]

  /** Honours both of `pg`'s call conventions: promise, and trailing callback. */
  function makeFakeClient(behaviour: { delayMs?: number; result?: any; reject?: Error } = {}): any {
    const calls: any[][] = []
    return {
      calls,
      query(...args: any[]) {
        calls.push(args)
        const settle = async () => {
          if (behaviour.delayMs) {
            await sleep(behaviour.delayMs)
          }
          if (behaviour.reject) {
            throw behaviour.reject
          }
          return behaviour.result ?? { rows: [], rowCount: 0 }
        }
        const last = args[args.length - 1]
        if (typeof last === 'function') {
          settle().then(
            (result) => last(null, result),
            (err) => last(err, undefined)
          )
          return undefined
        }
        return settle()
      }
    }
  }

  const slowLine = () => {
    assert.equal(warnCalls.length, 1, 'exactly one slow-query line')
    const [scope, message, fields] = warnCalls[0]!
    assert.equal(scope, 'sql')
    assert.equal(message, 'slow query')
    return fields as Record<string, unknown>
  }

  // -> Same fixtures as the firehose suite above, deliberately.
  const pemLikeParam =
    '-----BEGIN PRIVATE KEY-----\nMIIExampleNotARealKeyMaterialxxxxxxxxxxxxx\n-----END PRIVATE KEY-----'
  const secretBlobParam = {
    auth: { secret: 'super-secret-session-value', certs: { passphrase: 'hunter2-passphrase' } }
  }

  beforeEach(() => {
    warnCalls = []
    debugCalls = []
    wikiHandle = installTestWiki({
      logger: {
        info: () => {},
        warn: (...args: any[]) => warnCalls.push(args),
        debug: (...args: any[]) => debugCalls.push(args),
        error: () => {}
      },
      config: { slowQueryMs: 50 }
    })
  })

  afterEach(() => {
    wikiHandle.restore()
  })

  test('a query at or past the threshold logs one warn line carrying ms, rows and the query', async () => {
    const client = makeFakeClient({ delayMs: 80, result: { rows: [{ id: 1 }], rowCount: 1 } })
    instrumentSlowQueries(client)

    await client.query('select "id" from "pages" where "hash" = $1', ['abc'])

    const fields = slowLine()
    assert.equal(typeof fields.ms, 'number')
    assert.ok((fields.ms as number) >= 50, `expected ms >= 50, got ${fields.ms}`)
    assert.equal(fields.rows, 1)
    assert.equal(fields.query, 'select "id" from "pages" where "hash" = $1')
    assert.equal(fields.params, '(1 param: string(3))')
  })

  test('a query under the threshold logs nothing', async () => {
    const client = makeFakeClient({ result: { rows: [], rowCount: 0 } })
    instrumentSlowQueries(client)

    await client.query('select 1', [])

    assert.equal(warnCalls.length, 0)
  })

  test('slowQueryMs 0 (the shipped default) times nothing, however slow the query is', async () => {
    CARDINAL.config.slowQueryMs = 0
    const client = makeFakeClient({ delayMs: 80, result: { rows: [], rowCount: 0 } })
    instrumentSlowQueries(client)

    const result = await client.query('select pg_sleep(1)')

    assert.equal(warnCalls.length, 0)
    assert.deepEqual(result, { rows: [], rowCount: 0 }, 'the query still runs and still answers')
  })

  test('a non-numeric or negative slowQueryMs reads as off rather than as a threshold of 0', async () => {
    for (const configured of [-1, 'soon', null, undefined, Number.NaN]) {
      CARDINAL.config.slowQueryMs = configured
      const client = makeFakeClient({ delayMs: 60 })
      instrumentSlowQueries(client)

      await client.query('select 1')

      assert.equal(warnCalls.length, 0, `slowQueryMs ${String(configured)} should be off`)
    }
  })

  test('bound parameter values never reach the slow line — only the type/length descriptor', async () => {
    const client = makeFakeClient({ delayMs: 80, result: { rows: [], rowCount: 0 } })
    instrumentSlowQueries(client)

    await client.query('update "settings" set "value" = $1 where "key" = $2', [
      secretBlobParam,
      pemLikeParam
    ])

    const fields = slowLine()
    const rendered = JSON.stringify(fields)
    assert.ok(!rendered.includes('super-secret-session-value'), 'session secret must not appear')
    assert.ok(!rendered.includes('hunter2-passphrase'), 'passphrase must not appear')
    assert.ok(!rendered.includes('BEGIN PRIVATE KEY'), 'PEM value must not appear, even in part')
    assert.equal(fields.params, `(2 params: object, string(${pemLikeParam.length}))`)
  })

  test('a query with no bound parameters carries no params field at all', async () => {
    const client = makeFakeClient({ delayMs: 80, result: { rows: [], rowCount: 0 } })
    instrumentSlowQueries(client)

    await client.query('vacuum analyze')

    const fields = slowLine()
    assert.ok(!('params' in fields), 'no params field when there are no bound parameters')
  })

  test('a long query is truncated to its first 200 characters', async () => {
    const longQuery = `select ${'"col", '.repeat(200)}1 from "pages"`
    const client = makeFakeClient({ delayMs: 80, result: { rows: [], rowCount: 0 } })
    instrumentSlowQueries(client)

    await client.query(longQuery)

    const fields = slowLine()
    assert.equal((fields.query as string).length, 201, '200 characters plus the ellipsis')
    assert.ok((fields.query as string).endsWith('…'))
    assert.ok(longQuery.startsWith((fields.query as string).slice(0, 200)))
  })

  test("the { text, values } config shape Drizzle's driver sends is timed too", async () => {
    const client = makeFakeClient({ delayMs: 80, result: { rows: [], rowCount: 2 } })
    instrumentSlowQueries(client)

    await client.query({ name: 'q1', text: 'select $1::text', values: [pemLikeParam] })

    const fields = slowLine()
    assert.equal(fields.query, 'select $1::text')
    assert.equal(fields.params, `(1 param: string(${pemLikeParam.length}))`)
    assert.equal(fields.rows, 2)
  })

  test('the trailing-callback call shape is timed too, and still calls back', async () => {
    const client = makeFakeClient({ delayMs: 80, result: { rows: [], rowCount: 3 } })
    instrumentSlowQueries(client)

    const seen = await new Promise<any>((resolve) => {
      client.query('select 1', [], (_err: any, result: any) => resolve(result))
    })

    assert.equal(seen.rowCount, 3)
    assert.equal(slowLine().rows, 3)
  })

  test('a slow query that FAILS is still reported, with no rows, and still rejects', async () => {
    const timeout = new Error('canceling statement due to statement timeout')
    const client = makeFakeClient({ delayMs: 80, reject: timeout })
    instrumentSlowQueries(client)

    await assert.rejects(() => client.query('select pg_sleep(120)'), /statement timeout/)

    const fields = slowLine()
    assert.ok(!('rows' in fields), 'a failed query has no row count to report')
    assert.equal(typeof fields.ms, 'number')
  })

  test('a submittable (Cursor / QueryStream) is passed straight through, untimed', async () => {
    const cursor = { text: 'select 1', submit() {} }
    const client = makeFakeClient()
    // -> Echoes its argument, so identity shows the wrapper returned the original call's value.
    client.query = (...args: any[]) => args[0]
    instrumentSlowQueries(client)

    assert.equal(client.query(cursor), cursor)
    assert.equal(warnCalls.length, 0)
  })

  test('instrumenting the same client twice does not double-report', async () => {
    const client = makeFakeClient({ delayMs: 80, result: { rows: [], rowCount: 0 } })
    instrumentSlowQueries(client)
    instrumentSlowQueries(client)

    await client.query('select 1')

    assert.equal(warnCalls.length, 1)
  })

  test('with the sql scope at debug as well, the slow path still emits exactly one line', async () => {
    CARDINAL.config.logScopes = { sql: 'debug' }
    const client = makeFakeClient({ delayMs: 80, result: { rows: [], rowCount: 1 } })
    instrumentSlowQueries(client)

    // -> As Drizzle drives it: `Logger.logQuery` runs synchronously BEFORE the query is sent, which
    //    is why the firehose line and the slow line cannot be merged into one.
    queryLogger.logQuery('select "id" from "pages" where "hash" = $1', ['abc'])
    await client.query('select "id" from "pages" where "hash" = $1', ['abc'])

    assert.equal(debugCalls.length, 1, 'one firehose line, from queryLogger and nowhere else')
    assert.equal(debugCalls[0]![0], 'sql')
    assert.equal(warnCalls.length, 1, 'one slow-query line, at warn')
    assert.equal(warnCalls[0]![1], 'slow query')
  })
})

describe('dropSchemaIfDev() — CARDINAL.IS_DEBUG guard (task 2270)', () => {
  let executeMock: any
  let warnMock: any
  let fakeDb: any

  beforeEach(() => {
    executeMock = mock.fn(async () => ({ rows: [] }))
    fakeDb = { execute: executeMock }
    warnMock = mock.fn(() => {})
    CARDINAL.logger.warn = warnMock
    CARDINAL.config = { db: { schema: 'wiki' }, dev: {} }
  })

  test('dropSchema set, IS_DEBUG false: the schema is NOT dropped, and a refusal is logged', async () => {
    CARDINAL.IS_DEBUG = false
    CARDINAL.config.dev.dropSchema = true

    await dbManager.dropSchemaIfDev(fakeDb)

    assert.equal(executeMock.mock.calls.length, 0)
    assert.equal(warnMock.mock.calls.length, 1)
    const [scope, message, fields] = warnMock.mock.calls[0].arguments
    assert.equal(scope, 'db')
    assert.match(message, /refused/i)
    assert.equal(fields.schema, 'wiki')
  })

  test('dropSchema set, IS_DEBUG true: the schema IS dropped', async () => {
    CARDINAL.IS_DEBUG = true
    CARDINAL.config.dev.dropSchema = true

    await dbManager.dropSchemaIfDev(fakeDb)

    assert.equal(executeMock.mock.calls.length, 1)
    assert.match(executeMock.mock.calls[0].arguments[0], /DROP SCHEMA IF EXISTS wiki CASCADE/)
  })

  test('dropSchema unset: nothing happens regardless of IS_DEBUG, and nothing is logged', async () => {
    CARDINAL.IS_DEBUG = true
    CARDINAL.config.dev.dropSchema = false

    await dbManager.dropSchemaIfDev(fakeDb)

    assert.equal(executeMock.mock.calls.length, 0)
    assert.equal(warnMock.mock.calls.length, 0)
  })
})

/**
 * Unset, pg-pool falls back to `max: 10` with no connect or statement bound, so a saturated pool or
 * a runaway query blocks its caller forever. DB-backed on purpose: a mock of pg-pool's checkout
 * queue or of Postgres's own timeout enforcement would only restate what is under test.
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
      // -> Set the way `db.ts#init()` sets it: through `options`, alongside `search_path`.
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
 * node-postgres emits `error` on the pool whenever an idle client's connection fails (a Postgres
 * restart, a failover), and with no listener that is rethrown as an uncaught exception that takes
 * the process down.
 *
 * All of `init()`'s own query traffic reaches the pool through `Pool.prototype.query`, so mocking
 * that runs the real `init()` end to end with no `DATABASE_URL` and no network I/O. `init(true)`
 * (worker mode) skips the migration step, which would need a real database.
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

  test('emitting error on the pool logs through CARDINAL.logger.error rather than throwing', async () => {
    await dbManager.init(true)

    const err: any = new Error('Connection terminated unexpectedly')
    err.code = 'ECONNRESET'

    assert.doesNotThrow(() => {
      dbManager.pool!.emit('error', err)
    })

    assert.equal(loggerErrorMock.mock.calls.length, 1)
    const [scope, message, fields] = loggerErrorMock.mock.calls[0].arguments
    assert.equal(scope, 'db')
    assert.equal(message, 'pool error')
    assert.equal(fields.code, 'ECONNRESET')
    assert.equal((fields.error as Error).message, 'Connection terminated unexpectedly')
  })

  // -> `connect` is where `instrumentSlowQueries` is attached to each new physical connection; its
  //    absence would leave slow-query timing silently inert with nothing failing.
  test('the constructed pool has a connect listener registered, for slow-query timing', async () => {
    await dbManager.init(true)

    assert.ok(dbManager.pool, 'init() should have set dbManager.pool')
    assert.ok(
      dbManager.pool!.listenerCount('connect') >= 1,
      'the pool should have at least one connect listener attached'
    )
  })
})

/**
 * A LISTEN client is held for the process lifetime, so checking it out of the query pool would
 * silently cost the configured `max` one connection.
 */
describe('subscribeToNotifications() checks out from the dedicated listener pool, not the query pool', () => {
  test('connects via dbManager.listenerPool and never calls dbManager.pool.connect()', async () => {
    const listenerPool = new FakePool()
    const client = new FakeClient()
    listenerPool.queueClient(client)
    dbManager.listenerPool = listenerPool as any

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
    // -> One fake pool plays both roles. Left unset, `connectListener`'s `reconnect()` loop would
    //    catch the `null.connect()` TypeError like any connection failure and retry forever.
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
 * Unlocked, two instances racing to migrate a fresh database both compute the same migration set
 * and collide on `relation already exists`; under the lock the loser blocks, then re-reads an
 * already-migrated state. DB-backed because the thing under test is cross-connection
 * serialization, which a fake `Pool` would only re-describe.
 *
 * Nested `beforeEach`/`afterEach` rather than a one-time `before()`: the file-level hooks reset
 * `dbManager.pool` and the `CARDINAL` global around every test in this file, these included, and
 * nested hooks run inside them.
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
    // -> `CREATE EXTENSION IF NOT EXISTS` is not atomic against another session creating the same
    //    extension for the first time, and other DB-backed files run in parallel against this
    //    database. `setupTestDb()` creates them serialized (`createExtensionsSerialized`) before
    //    the race test issues its own; the throwaway schema it made is dropped again at once.
    await setupTestDb()
    await teardownTestDb()
  })

  beforeEach(() => {
    const DATABASE_URL = process.env.DATABASE_URL
    if (!DATABASE_URL) {
      return
    }
    outerWiki = (globalThis as any).CARDINAL
    schema = `test_syncschemas_${randomBytes(6).toString('hex')}`
    // -> Fresh schema first: an unqualified `CREATE TYPE`/`CREATE TABLE` in a migration targets
    //    whichever schema leads the connection's search_path, not `CARDINAL.config.db.schema` by
    //    name. `public` stays behind it because the shared extensions live there.
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
    ;(globalThis as any).CARDINAL = outerWiki
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
