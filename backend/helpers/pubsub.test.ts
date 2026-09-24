import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { after, beforeEach, describe, test } from 'node:test'
import {
  connectListener,
  createListenerPool,
  createNotifier,
  notifierStats,
  NOTIFY_DURATION_BUCKETS
} from './pubsub.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * A fake `Pool`/`PoolClient` pair stands in for postgres throughout — this is pure client-lifecycle
 * logic with no SQL orchestration worth a real database for.
 */

class FakeClient extends EventEmitter {
  released = false
  releasedWithErr: any
  queries: string[] = []
  async query(text: string): Promise<any> {
    this.queries.push(text)
    return { rows: [] }
  }
  release(err?: any): void {
    if (this.released) {
      throw new Error('Release called on client which has already been released to the pool.')
    }
    this.released = true
    this.releasedWithErr = err
  }
}

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
    // -> Released with destroy (its connection is presumed dead), not just dropped: otherwise it
    //    stays checked out forever and counts against the pool's `max` on every reconnect.
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

    const connectCallsBeforeLateError = pool.connectCalls
    client.emit('error', new Error('late error after shutdown'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(pool.connectCalls, connectCallsBeforeLateError)
  })

  test('checks out from whichever pool it is handed, and never from a separate pool also in scope (task 1887)', async () => {
    const listenerPool = new FakePool()
    const client = new FakeClient()
    listenerPool.queueClient(client)

    // -> Stands in for the main query pool: in scope but never handed over, so it must see no
    //    checkout.
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
 * Constructing a `pg.Pool` opens no socket -- only `.connect()` does, which none of these tests
 * call -- so a real `Pool` is safe here, and `.options` is where node-postgres stores back what the
 * constructor was handed.
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
  // -> A caller's getter may legitimately return `null`: a worker thread's minimal `CARDINAL` has no
  //    pubsub client.
  test('send() against a getter returning null resolves as a no-op and logs nothing', async () => {
    const notifier = createNotifier(() => null, 'test channel')

    notifier.send('wiki', '{"a":1}')
    await notifier.drained()

    assert.deepEqual(warnings, [])
  })
})

describe('createNotifier instrumentation', () => {
  function statsFor(label: string) {
    const stats = notifierStats().find((s) => s.channel === label)
    assert.ok(stats, `no stats registered for ${label}`)
    return stats
  }

  class GatedClient {
    queries: unknown[][] = []
    private gates: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
    query(text: string, params: unknown[]): Promise<void> {
      this.queries.push([text, params])
      return new Promise((resolve, reject) => {
        this.gates.push({ resolve: () => resolve(), reject })
      })
    }
    async settleNext(err?: Error): Promise<void> {
      while (this.gates.length === 0) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      const gate = this.gates.shift()!
      if (err) {
        gate.reject(err)
      } else {
        gate.resolve()
      }
    }
  }

  test('registers under its label with zeroed stats before anything is sent', () => {
    createNotifier(() => null, 'instrumentation: fresh')

    assert.deepEqual(statsFor('instrumentation: fresh'), {
      channel: 'instrumentation: fresh',
      sent: 0,
      droppedError: 0,
      droppedNoClient: 0,
      droppedNoPeer: 0,
      queueDepth: 0,
      durationBuckets: NOTIFY_DURATION_BUCKETS.map(() => 0),
      durationSum: 0,
      durationCount: 0
    })
  })

  test('the sent counter rises with every NOTIFY a collaboration relay notifier sends', async () => {
    const client = new FakeClient()
    const notifier = createNotifier(() => client as any, 'collaboration relay')
    const before = statsFor('collaboration relay').sent

    for (let i = 0; i < 5; i++) {
      notifier.send('wiki_collab', `{"t":"update","i":${i}}`)
    }
    await notifier.drained()

    const stats = statsFor('collaboration relay')
    assert.equal(stats.sent, before + 5)
    assert.equal(client.queries.length, 5)
    assert.equal(stats.durationCount, 5)
    assert.ok(stats.durationSum >= 0)
    assert.equal(stats.queueDepth, 0)
  })

  test('queue depth counts every queued NOTIFY, including the one in flight, and falls as each settles', async () => {
    const client = new GatedClient()
    const notifier = createNotifier(() => client as any, 'instrumentation: depth')

    notifier.send('wiki', '1')
    notifier.send('wiki', '2')
    notifier.send('wiki', '3')
    assert.equal(statsFor('instrumentation: depth').queueDepth, 3)

    await client.settleNext()
    await client.settleNext()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(statsFor('instrumentation: depth').queueDepth, 1)
    assert.equal(statsFor('instrumentation: depth').sent, 2)

    await client.settleNext()
    await notifier.drained()
    assert.equal(statsFor('instrumentation: depth').queueDepth, 0)
    assert.equal(statsFor('instrumentation: depth').sent, 3)
  })

  test('a failed pg_notify counts as dropped with reason error and does not stop the next send', async () => {
    const client = new GatedClient()
    const notifier = createNotifier(() => client as any, 'instrumentation: errors')

    notifier.send('wiki', 'fails')
    notifier.send('wiki', 'succeeds')
    await client.settleNext(new Error('connection reset'))
    await client.settleNext()
    await notifier.drained()

    const stats = statsFor('instrumentation: errors')
    assert.equal(stats.droppedError, 1)
    assert.equal(stats.sent, 1)
    assert.equal(stats.durationCount, 1)
    assert.equal(stats.queueDepth, 0)
    assert.ok(warnings.some((w) => w.message === 'publishing a notification failed'))
  })

  test('a send with no live client counts as dropped with reason no_client, not as sent', async () => {
    const notifier = createNotifier(() => null, 'instrumentation: no client')

    notifier.send('wiki', '{}')
    notifier.send('wiki', '{}')
    await notifier.drained()

    const stats = statsFor('instrumentation: no client')
    assert.equal(stats.droppedNoClient, 2)
    assert.equal(stats.sent, 0)
    assert.equal(stats.durationCount, 0)
    assert.equal(stats.queueDepth, 0)
  })

  test('discard() counts what a caller withheld under its reason, never as sent or queued', async () => {
    const notifier = createNotifier(() => null, 'instrumentation: discard')

    notifier.discard('no_client')
    notifier.discard('no_client', 3)
    notifier.discard('no_peer', 2)
    await notifier.drained()

    const stats = statsFor('instrumentation: discard')
    assert.equal(stats.droppedNoClient, 4)
    assert.equal(stats.droppedNoPeer, 2)
    assert.equal(stats.sent, 0)
    assert.equal(stats.queueDepth, 0)
  })

  test('a getter that throws counts as dropped with reason error', async () => {
    const notifier = createNotifier(() => {
      throw new Error('no scheduler yet')
    }, 'instrumentation: throwing getter')

    notifier.send('scheduler', '{}')
    await notifier.drained()

    const stats = statsFor('instrumentation: throwing getter')
    assert.equal(stats.droppedError, 1)
    assert.equal(stats.queueDepth, 0)
  })

  test('round-trip time lands in cumulative buckets, skipping every bucket below it', async () => {
    const slowClient = {
      query: () => new Promise((resolve) => setTimeout(resolve, 80))
    }
    const notifier = createNotifier(() => slowClient as any, 'instrumentation: buckets')

    notifier.send('wiki', '1')
    await notifier.drained()

    const stats = statsFor('instrumentation: buckets')
    assert.equal(stats.durationCount, 1)
    assert.ok(stats.durationSum >= 0.05, `durationSum = ${stats.durationSum}`)
    NOTIFY_DURATION_BUCKETS.forEach((le, i) => {
      if (le <= 0.05) {
        assert.equal(stats.durationBuckets[i], 0, `le=${le}`)
      }
      if (i > 0) {
        assert.ok(
          stats.durationBuckets[i] >= stats.durationBuckets[i - 1],
          `le=${le} is cumulative`
        )
      }
    })
  })

  test('two notifiers sharing a label add into one series; distinct labels stay apart', async () => {
    const a = createNotifier(() => new FakeClient() as any, 'instrumentation: shared')
    const b = createNotifier(() => new FakeClient() as any, 'instrumentation: shared')
    const c = createNotifier(() => new FakeClient() as any, 'instrumentation: separate')

    a.send('wiki', '1')
    b.send('wiki', '2')
    c.send('wiki', '3')
    await Promise.all([a.drained(), b.drained(), c.drained()])

    assert.equal(statsFor('instrumentation: shared').sent, 2)
    assert.equal(statsFor('instrumentation: separate').sent, 1)
  })

  test('notifierStats() returns copies sorted by label, so a caller cannot corrupt the registry', () => {
    createNotifier(() => null, 'instrumentation: zz')
    createNotifier(() => null, 'instrumentation: aa')

    const snapshot = notifierStats()
    const labels = snapshot.map((s) => s.channel)
    assert.deepEqual(labels, [...labels].sort())

    const copy = snapshot.find((s) => s.channel === 'instrumentation: aa')!
    copy.sent = 999
    copy.durationBuckets[0] = 999
    assert.equal(statsFor('instrumentation: aa').sent, 0)
    assert.equal(statsFor('instrumentation: aa').durationBuckets[0], 0)
  })
})
