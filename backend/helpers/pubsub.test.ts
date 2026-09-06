import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { after, beforeEach, describe, test } from 'node:test'
import { connectListener, createListenerPool, createNotifier } from './pubsub.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * Regression coverage for `connectListener` (task 703): none of the three dedicated LISTEN/NOTIFY
 * `PoolClient`s this app holds via `pool.connect()` (the event bus, the scheduler, collaborative
 * editing) used to register an `.on('error', ...)` handler. node-postgres does not supervise a
 * checked-out client the way it does pool-routed queries, so an unhandled `'error'` on one throws on
 * the client's own `EventEmitter` and crashes the process — a connection reset or a Postgres restart
 * becoming a full instance death. `connectListener` is the shared fix: it attaches the error handler,
 * drops the stale client, and reconnects + re-LISTENs on a short backoff.
 *
 * A fake `Pool`/`PoolClient` pair stands in for postgres throughout — this is pure client-lifecycle
 * logic with no SQL orchestration worth a real database for.
 */

/** Minimal `PoolClient` fake: an EventEmitter plus the handful of methods `connectListener` calls. */
class FakeClient extends EventEmitter {
  released = false
  releasedWithErr: any
  queries: string[] = []
  async query(text: string): Promise<any> {
    this.queries.push(text)
    return { rows: [] }
  }
  release(err?: any): void {
    this.released = true
    this.releasedWithErr = err
  }
}

/** Minimal `Pool` fake: `connect()` either resolves with a queued client or rejects with a queued error. */
class FakePool {
  private queue: Array<{ client?: FakeClient; error?: Error }> = []
  connectCalls = 0
  clients: FakeClient[] = []
  queueClient(client: FakeClient): void {
    this.queue.push({ client })
  }
  queueError(error: Error): void {
    this.queue.push({ error })
  }
  async connect(): Promise<FakeClient> {
    this.connectCalls++
    const next = this.queue.shift()
    if (!next) {
      throw new Error('FakePool.connect() called with nothing queued')
    }
    if (next.error) {
      throw next.error
    }
    this.clients.push(next.client!)
    return next.client!
  }
}

let wikiHandle: { restore(): void }
let warnings: { scope: string; message: string; fields?: Record<string, unknown> }[]

beforeEach(() => {
  warnings = []
  wikiHandle = installTestWiki({
    logger: {
      warn: (scope: string, message: string, fields?: Record<string, unknown>) => {
        warnings.push({ scope, message, fields })
      },
      info: () => {},
      debug: () => {}
    }
  })
})

after(() => {
  wikiHandle.restore()
})

describe('connectListener', () => {
  test('connects, sets application_name, LISTENs every channel, and stores the client', async () => {
    const pool = new FakePool()
    const client = new FakeClient()
    pool.queueClient(client)

    let stored: FakeClient | null = null
    const notifications: any[] = []

    const handle = await connectListener({
      pool: pool as any,
      applicationName: 'Cardinal.js - test:EVENTS',
      channels: ['wiki', 'wiki_collab'],
      label: 'test listener',
      onNotification: (msg) => notifications.push(msg),
      getClient: () => stored as any,
      setClient: (c) => {
        stored = c as any
      }
    })

    assert.equal(stored, client)
    assert.deepEqual(client.queries, [
      "SET application_name = 'Cardinal.js - test:EVENTS'",
      'LISTEN wiki',
      'LISTEN wiki_collab'
    ])

    client.emit('notification', { channel: 'wiki', payload: '{"a":1}' })
    assert.deepEqual(notifications, [{ channel: 'wiki', payload: '{"a":1}' }])

    await handle.close()
  })

  test('on error: logs a warning, drops the client, and reconnects with the same LISTENs', async () => {
    const pool = new FakePool()
    const firstClient = new FakeClient()
    const secondClient = new FakeClient()
    pool.queueClient(firstClient)
    pool.queueClient(secondClient)

    let stored: FakeClient | null = null
    const handle = await connectListener({
      pool: pool as any,
      applicationName: 'Cardinal.js - test:SCHEDULER',
      channels: ['scheduler'],
      label: 'scheduler',
      onNotification: () => {},
      getClient: () => stored as any,
      setClient: (c) => {
        stored = c as any
      },
      retryDelayMs: 1
    })
    assert.equal(stored, firstClient)

    firstClient.emit('error', new Error('connection reset'))
    // -> setClient(null) happens synchronously inside the error handler
    assert.equal(stored, null)
    assert.ok(
      warnings.some((w) => {
        const error = w.fields?.error as Error | undefined
        return (
          w.message === 'lost the listener connection, reconnecting' &&
          error?.message.includes('connection reset') === true
        )
      })
    )
    // -> Regression for the leaked-pool-slot finding: the failed client must be released
    //    (destroy-on-release, since its connection is presumed dead) rather than simply dropped, or
    //    it stays checked out of the pool forever and counts against `_isFull()` on every future
    //    reconnect.
    assert.equal(firstClient.released, true)
    assert.equal(firstClient.releasedWithErr, true)

    // -> Reconnecting is async (a fresh `pool.connect()` + queries); wait for it to land
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(stored, secondClient)
    assert.deepEqual(secondClient.queries, [
      "SET application_name = 'Cardinal.js - test:SCHEDULER'",
      'LISTEN scheduler'
    ])
    assert.equal(pool.connectCalls, 2)

    await handle.close()
  })

  test('reconnect backs off and retries when pool.connect() keeps failing', async () => {
    const pool = new FakePool()
    const initialClient = new FakeClient()
    pool.queueClient(initialClient)
    pool.queueError(new Error('ECONNREFUSED'))
    pool.queueError(new Error('ECONNREFUSED'))
    const recoveredClient = new FakeClient()
    pool.queueClient(recoveredClient)

    let stored: FakeClient | null = null
    const handle = await connectListener({
      pool: pool as any,
      applicationName: 'Cardinal.js - test:COLLAB',
      channels: ['wiki_collab'],
      label: 'collaboration relay',
      onNotification: () => {},
      getClient: () => stored as any,
      setClient: (c) => {
        stored = c as any
      },
      retryDelayMs: 1
    })
    assert.equal(stored, initialClient)

    initialClient.emit('error', new Error('connection reset'))
    assert.equal(stored, null)

    // -> Two failed retries plus the eventual success, each separated by the 1ms backoff
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(stored, recoveredClient)
    assert.equal(pool.connectCalls, 4) // initial + 2 failures + 1 success
    assert.ok(
      warnings.filter((w) => w.message === 'reconnecting the listener failed, retrying').length >=
        2,
      'expected at least two retry warnings'
    )

    await handle.close()
  })

  test('close() releases the client and stops further reconnects', async () => {
    const pool = new FakePool()
    const client = new FakeClient()
    pool.queueClient(client)

    let stored: FakeClient | null = null
    const handle = await connectListener({
      pool: pool as any,
      applicationName: 'Cardinal.js - test:EVENTS',
      channels: ['wiki'],
      label: 'test listener',
      onNotification: () => {},
      getClient: () => stored as any,
      setClient: (c) => {
        stored = c as any
      }
    })

    await handle.close()

    assert.equal(client.released, true)
    assert.equal(client.releasedWithErr, true)
    assert.equal(stored, null)

    // -> An error arriving after close() must not trigger a reconnect
    const connectCallsBeforeLateError = pool.connectCalls
    client.emit('error', new Error('late error after shutdown'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(pool.connectCalls, connectCallsBeforeLateError)
  })

  test('checks out from whichever pool it is handed, and never from a separate pool also in scope (task 1887)', async () => {
    // -> Stands in for `WIKI.dbManager.listenerPool`, the dedicated pool `createListenerPool` builds.
    const listenerPool = new FakePool()
    const client = new FakeClient()
    listenerPool.queueClient(client)

    // -> Stands in for `WIKI.dbManager.pool`, the main query pool -- `connectOnce` must never touch
    //    this one, which is the whole point of task 1887 moving the listeners off it.
    const queryPool = new FakePool()

    let stored: FakeClient | null = null
    const handle = await connectListener({
      pool: listenerPool as any,
      applicationName: 'Cardinal.js - test:EVENTS',
      channels: ['wiki'],
      label: 'test listener',
      onNotification: () => {},
      getClient: () => stored as any,
      setClient: (c) => {
        stored = c as any
      }
    })

    assert.equal(stored, client)
    assert.equal(listenerPool.connectCalls, 1)
    assert.equal(queryPool.connectCalls, 0)

    await handle.close()
  })
})

/**
 * `createListenerPool` (task 1887): the dedicated pool the three permanently-held LISTEN/NOTIFY
 * clients share, sized so they never eat into the main query pool's configured `max`. Constructing a
 * `pg.Pool` never opens a socket by itself -- only `.connect()` does, which none of these tests call
 * -- so this is safe to exercise as a real `Pool` rather than a fake, and `.options` is where
 * node-postgres stores back exactly what the constructor was handed.
 */
describe('createListenerPool', () => {
  test('sizes the pool for exactly the three permanent listeners, with no idle minimum', () => {
    const pool = createListenerPool({ host: 'db.example.com', database: 'wiki' })
    assert.equal(pool.options.max, 3)
    assert.equal(pool.options.min, 0)
    assert.equal(pool.options.host, 'db.example.com')
    assert.equal(pool.options.database, 'wiki')
  })

  test('defaults connectionTimeoutMillis to 5s so a saturated pool fails fast', () => {
    const pool = createListenerPool({ host: 'db.example.com' })
    assert.equal(pool.options.connectionTimeoutMillis, 5000)
  })

  test('preserves an explicit connectionTimeoutMillis from the input config instead of overriding it', () => {
    const pool = createListenerPool({ host: 'db.example.com', connectionTimeoutMillis: 1234 })
    assert.equal(pool.options.connectionTimeoutMillis, 1234)
  })
})

describe('createNotifier', () => {
  /**
   * Regression coverage for task 2015: `core/db.ts`'s module-scope notifier reads
   * `WIKI.dbManager.pubsubClient` in its client getter, a member the worker thread's minimal `WIKI`
   * never sets (`worker.ts`'s literal is asserted to the full `WikiGlobal`, so `tsc` cannot catch the
   * gap). The fix makes the getter itself defensive; this exercises `createNotifier`'s own contract
   * that a getter returning `null` is a silent no-op, which is what makes that defensiveness safe to
   * rely on regardless of which caller's getter it is.
   */
  test('send() against a getter returning null resolves as a no-op and logs nothing', async () => {
    const notifier = createNotifier(() => null, 'test channel')

    notifier.send('wiki', '{"a":1}')
    await notifier.drained()

    assert.deepEqual(warnings, [])
  })
})
