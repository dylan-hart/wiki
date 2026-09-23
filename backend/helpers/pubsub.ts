import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool, type Notification, type PoolClient, type PoolConfig } from 'pg'

export interface Notifier {
  /** Queue a notification behind whatever is already going out. Never throws. */
  send(channel: string, payload: string): void
  /** Resolves once everything queued so far has gone out, for an orderly shutdown. */
  drained(): Promise<void>
}

export const NOTIFY_DURATION_BUCKETS: readonly number[] = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5
]

export interface NotifierStats {
  channel: string
  sent: number
  droppedError: number
  droppedNoClient: number
  queueDepth: number
  durationBuckets: number[]
  durationSum: number
  durationCount: number
}

const notifierRegistry = new Map<string, NotifierStats>()

function registerNotifier(label: string): NotifierStats {
  let stats = notifierRegistry.get(label)
  if (!stats) {
    stats = {
      channel: label,
      sent: 0,
      droppedError: 0,
      droppedNoClient: 0,
      queueDepth: 0,
      durationBuckets: NOTIFY_DURATION_BUCKETS.map(() => 0),
      durationSum: 0,
      durationCount: 0
    }
    notifierRegistry.set(label, stats)
  }
  return stats
}

function observeDuration(stats: NotifierStats, seconds: number): void {
  NOTIFY_DURATION_BUCKETS.forEach((le, i) => {
    if (seconds <= le) {
      stats.durationBuckets[i]++
    }
  })
  stats.durationSum += seconds
  stats.durationCount++
}

export function notifierStats(): NotifierStats[] {
  return [...notifierRegistry.values()]
    .map((stats) => ({ ...stats, durationBuckets: [...stats.durationBuckets] }))
    .sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0))
}

/**
 * Serializes the notifications sent on a dedicated LISTEN/NOTIFY client. Callers publish from
 * places that cannot await a round trip to postgres, and handing an unawaited query to a client
 * already running one is deprecated in `pg` 8.x and removed in 9.0.
 *
 * Each notification carries its own `catch`, so a failed publish does not stop the ones behind it.
 *
 * **At-most-once.** `client` is read on each send, since it is opened after this is built and
 * dropped at shutdown; a notification sent while it returns `null` is discarded, not buffered.
 */
export function createNotifier(client: () => PoolClient | null, label: string): Notifier {
  const stats = registerNotifier(label)
  let tail: Promise<void> = Promise.resolve()
  return {
    send(channel: string, payload: string): void {
      stats.queueDepth++
      tail = tail.then(async () => {
        try {
          const live = client()
          if (!live) {
            stats.droppedNoClient++
            return
          }
          const started = performance.now()
          await live.query('SELECT pg_notify($1, $2)', [channel, payload])
          stats.sent++
          observeDuration(stats, (performance.now() - started) / 1000)
        } catch (err: any) {
          stats.droppedError++
          CARDINAL.logger.warn('db', 'publishing a notification failed', {
            channel: label,
            error: err
          })
        } finally {
          stats.queueDepth--
        }
      })
    },
    drained(): Promise<void> {
      return tail
    }
  }
}

/**
 * The permanently-held LISTEN/NOTIFY clients: the event bus (`core/db.ts`), the scheduler and
 * collaborative editing.
 */
const LISTENER_COUNT = 3

/**
 * A pool of their own for the LISTEN/NOTIFY clients: each holds its client for the process lifetime
 * and never runs an application query, so checked out of the query pool they would silently lower
 * its effective `max`.
 *
 * `max` is exact, not padded -- a listener reconnects in place, so there is never an extra
 * concurrent checkout. `min: 0` because an idle slot costs a live server connection for nothing.
 * The timeout makes a saturated pool fail fast rather than hang. `config` is the query pool's own
 * connection config, so how the database is reached is resolved once, in `core/db.ts`'s `init()`.
 */
export function createListenerPool(config: PoolConfig): Pool {
  return new Pool({
    ...config,
    min: 0,
    max: LISTENER_COUNT,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000
  })
}

export interface ListenerHandle {
  /** Stops further reconnect attempts and releases the live client, if there is one. */
  close(): Promise<void>
}

export interface ListenerOptions {
  /** The shared `CARDINAL.dbManager.listenerPool`, never the main query pool. */
  pool: Pool
  /** Set as `application_name` on every (re)connection, so `pg_stat_activity` can name it. */
  applicationName: string
  channels: string[]
  onNotification: (msg: Notification) => void
  /** Names this client in its log lines. */
  label: string
  /** `null` while a reconnect is in flight. */
  getClient: () => PoolClient | null
  /** Called with `null` as soon as the client drops, then with its replacement. */
  setClient: (client: PoolClient | null) => void
  retryDelayMs?: number
}

/**
 * Opens a dedicated LISTEN/NOTIFY client that survives a dropped connection. node-postgres does not
 * supervise a client checked out via `pool.connect()` and held: an `'error'` on it with nobody
 * listening throws on the client's own `EventEmitter`, crashing the process on a connection reset,
 * a Postgres restart or a proxy reaping the idle connection.
 *
 * Retries forever: no boot sequence waits on this failing fast, and a listener that stops trying is
 * silently dead.
 */
export async function connectListener(opts: ListenerOptions): Promise<ListenerHandle> {
  const { pool, applicationName, channels, onNotification, label, getClient, setClient } = opts
  const retryDelayMs = opts.retryDelayMs ?? 3000
  let closed = false

  function attach(client: PoolClient): void {
    client.on('notification', onNotification)
    client.on('error', (err: any) => {
      if (closed) {
        return
      }
      CARDINAL.logger.warn('db', 'lost the listener connection, reconnecting', {
        channel: label,
        error: err
      })
      client.release(true)
      setClient(null)
      void reconnect()
    })
  }

  async function connectOnce(): Promise<PoolClient> {
    const client = await pool.connect()
    try {
      await client.query(`SET application_name = '${applicationName}'`)
      for (const channel of channels) {
        await client.query(`LISTEN ${channel}`)
      }
    } catch (err) {
      client.release(true)
      throw err
    }
    return client
  }

  async function reconnect(): Promise<void> {
    while (!closed) {
      try {
        const client = await connectOnce()
        attach(client)
        setClient(client)
        return
      } catch (err: any) {
        CARDINAL.logger.warn('db', 'reconnecting the listener failed, retrying', {
          channel: label,
          retryIn: retryDelayMs,
          error: err
        })
        await delay(retryDelayMs)
      }
    }
  }

  await reconnect()

  return {
    async close(): Promise<void> {
      closed = true
      const client = getClient()
      if (client) {
        setClient(null)
        client.release(true)
      }
    }
  }
}
