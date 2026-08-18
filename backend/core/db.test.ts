import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import Emittery from 'emittery'

import dbManager from './db.ts'
import configSvc from './config.ts'
import maintenance from './maintenance.ts'

/**
 * Task 708 (feature 411): confirms what `core/db.ts`'s `subscribeToNotifications()` /
 * `notifyViaDB()` actually guarantee for a cross-instance event relayed over the `wiki` NOTIFY
 * channel, and whether either current subscriber (`core/config.ts`'s `reloadConfig`,
 * `core/maintenance.ts`'s `disconnectWebsockets`/`flushCaches`) depends on more than that.
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
 * **Finding**, expanded on in `dev/multi-instance-verify/README.md`: neither subscriber is
 * exposed to a *permanently* missed event, because `index.ts`'s `preBoot()` calls
 * `configSvc.loadFromDb()` and `postBoot()` calls `groups`/`sites`/`locales`/`approvals`
 * `.reloadCache()` unconditionally on every boot — not gated on any notification ever having
 * arrived. An instance that missed a `reloadConfig` or `flushCaches` notify while it was down (or
 * mid-restart) is fully resynced the moment it comes back, regardless of what it missed. The
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

before(() => {
  previousWiki = (globalThis as any).WIKI
})

beforeEach(() => {
  loadFromDbMock = mock.fn(async () => true)
  flushCachesMock = mock.fn(async () => {})
  disconnectWebsocketsMock = mock.fn(() => 0)
  configSvc.loadFromDb = loadFromDbMock
  maintenance.flushCaches = flushCachesMock
  maintenance.disconnectWebsockets = disconnectWebsocketsMock

  ;(globalThis as any).WIKI = {
    INSTANCE_ID: 'instance-a',
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    events: { inbound: new Emittery(), outbound: new Emittery() },
    configSvc,
    dbManager
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

  test('wires both current subscribers, each purely reactive to the notify with no independent re-check', async () => {
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

    // -> Emittery's inbound handlers run as microtasks; give them a tick.
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(loadFromDbMock.mock.calls.length, 1)
    assert.equal(flushCachesMock.mock.calls.length, 1)
    assert.equal(disconnectWebsocketsMock.mock.calls.length, 1)
  })
})
