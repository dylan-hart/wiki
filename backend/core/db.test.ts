import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import Emittery from 'emittery'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'

import dbManager, { type WikiDb } from './db.ts'
import configSvc from './config.ts'
import maintenance from './maintenance.ts'
import { groups } from '../models/groups.ts'
import { sites } from '../models/sites.ts'
import { approvals } from '../models/approvals.ts'
import { relations } from '../db/relations.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../test/db.ts'

/**
 * Task 708 (feature 411): confirms what `core/db.ts`'s `subscribeToNotifications()` /
 * `notifyViaDB()` actually guarantee for a cross-instance event relayed over the `wiki` NOTIFY
 * channel, and whether any current subscriber (`core/config.ts`'s `reloadConfig`,
 * `core/maintenance.ts`'s `disconnectWebsockets`/`flushCaches`, and — added by OpenProject #966 —
 * `models/groups.ts`/`sites.ts`/`approvals.ts`'s `reloadGroups`/`reloadSites`/`reloadApprovals`)
 * depends on more than that.
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
 * A fake `Pool`/`PoolClient` pair stands in for postgres, matching `helpers/pubsub.test.ts`'s
 * fixtures — this is event-bus wiring and delivery-loss semantics, not SQL, so a mock is the right
 * tool per CLAUDE.md's testing guidance rather than a real two-`node backend` harness (also not
 * available in this environment; see `dev/multi-instance-verify/README.md` §8 for what that would
 * look like and why it is not needed to settle this question).
 *
 * **Finding**, expanded on in `dev/multi-instance-verify/README.md`: no subscriber is exposed to a
 * *permanently* missed event, because `index.ts`'s `preBoot()` calls `configSvc.loadFromDb()` and
 * `postBoot()` calls `groups`/`sites`/`locales`/`approvals` `.reloadCache()` unconditionally on
 * every boot — not gated on any notification ever having arrived. An instance that missed a
 * `reloadConfig`/`flushCaches`/`reloadGroups`/`reloadSites`/`reloadApprovals` notify while it was
 * down (or mid-restart) is fully resynced the moment it comes back, regardless of what it missed. The
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
}

let previousWiki: any
let loadFromDbMock: any
let flushCachesMock: any
let disconnectWebsocketsMock: any
let groupsReloadCacheMock: any
let sitesReloadCacheMock: any
let approvalsReloadCacheMock: any

before(() => {
  previousWiki = (globalThis as any).WIKI
})

beforeEach(() => {
  loadFromDbMock = mock.fn(async () => true)
  flushCachesMock = mock.fn(async () => {})
  disconnectWebsocketsMock = mock.fn(() => 0)
  // -> OpenProject #966: `subscribeToNotifications()` also wires `groups`/`sites`/`approvals`
  //    `.subscribeToEvents()` now (see `core/db.ts`), which is real model code reachable off
  //    `WIKI.models` — stubbed here the same way `configSvc.loadFromDb`/`maintenance.flushCaches`
  //    already are, so this suite's minimal `WIKI` needs a `models` object at all.
  groupsReloadCacheMock = mock.fn(async () => {})
  sitesReloadCacheMock = mock.fn(async () => {})
  approvalsReloadCacheMock = mock.fn(async () => {})
  configSvc.loadFromDb = loadFromDbMock
  maintenance.flushCaches = flushCachesMock
  maintenance.disconnectWebsockets = disconnectWebsocketsMock
  groups.reloadCache = groupsReloadCacheMock
  sites.reloadCache = sitesReloadCacheMock
  approvals.reloadCache = approvalsReloadCacheMock

  ;(globalThis as any).WIKI = {
    INSTANCE_ID: 'instance-a',
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    events: { inbound: new Emittery(), outbound: new Emittery() },
    configSvc,
    dbManager,
    models: { groups, sites, approvals }
  }

  dbManager.pool = null
  dbManager.pubsubClient = null
  dbManager.listenerHandle = null
})

afterEach(async () => {
  await dbManager.unsubscribeFromNotifications()
})

after(() => {
  ;(globalThis as any).WIKI = previousWiki
})

describe('subscribeToNotifications() / notifyViaDB() — at-most-once delivery', () => {
  test('an event published while nobody is LISTENing (pubsubClient null) is silently dropped, never queued for replay', async () => {
    const pool = new FakePool()
    const initialClient = new FakeClient()
    pool.queueClient(initialClient)
    dbManager.pool = pool as any

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
    dbManager.pool = pool as any

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

  test('wires all five current subscribers, each purely reactive to the notify with no independent re-check', async () => {
    const pool = new FakePool()
    const client = new FakeClient()
    pool.queueClient(client)
    dbManager.pool = pool as any

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

    // -> Emittery's inbound handlers run as microtasks; give them a tick.
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(loadFromDbMock.mock.calls.length, 1)
    assert.equal(flushCachesMock.mock.calls.length, 1)
    assert.equal(disconnectWebsocketsMock.mock.calls.length, 1)
    assert.equal(groupsReloadCacheMock.mock.calls.length, 1)
    assert.equal(sitesReloadCacheMock.mock.calls.length, 1)
    assert.equal(approvalsReloadCacheMock.mock.calls.length, 1)
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
    ;(globalThis as any).WIKI = {
      config: { db: { schema } },
      SERVERPATH: path.join(import.meta.dirname, '..'),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
    }
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
