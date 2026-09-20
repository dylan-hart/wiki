import { setTimeout as delay } from 'node:timers/promises'
import { Pool, type Notification, type PoolClient, type PoolConfig } from 'pg'

export interface Notifier {
  /** Queue a notification behind whatever is already going out. Never throws. */
  send(channel: string, payload: string): void
  /** Resolves once everything queued so far has gone out, for an orderly shutdown. */
  drained(): Promise<void>
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
  let tail: Promise<void> = Promise.resolve()
  return {
    send(channel: string, payload: string): void {
      tail = tail.then(async () => {
        try {
          await client()?.query('SELECT pg_notify($1, $2)', [channel, payload])
        } catch (err: any) {
          CARDINAL.logger.warn('db', 'publishing a notification failed', {
            channel: label,
            error: err
          })
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
      // FIXME: a second `release()` of the same client -- pg-pool throws "Release called on client
      // which has already been released to the pool", so `reconnect()` never runs. Delete this call.
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
