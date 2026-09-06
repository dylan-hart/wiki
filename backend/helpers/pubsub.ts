import { setTimeout as delay } from 'node:timers/promises'
import { Pool, type Notification, type PoolClient, type PoolConfig } from 'pg'

/**
 * A `pg_notify` sender for one LISTEN/NOTIFY client.
 *
 * Sending is fire-and-forget by design — see `createNotifier` for why that has to be arranged rather
 * than simply left unawaited.
 */
export interface Notifier {
  /** Queue a notification behind whatever is already going out. Never throws. */
  send(channel: string, payload: string): void
  /** Resolves once everything queued so far has gone out, for an orderly shutdown. */
  drained(): Promise<void>
}

/**
 * Serialize the notifications sent on a dedicated LISTEN/NOTIFY client.
 *
 * Three modules hold such a client — the event bus (`core/db.ts`), the scheduler and collaborative
 * editing — and all three publish from places that cannot wait for a round trip to postgres: an
 * Emittery listener, a job being picked up, a Yjs handler reacting to a keystroke. So none of them
 * awaits the `pg_notify`.
 *
 * Handing an unawaited query to a client that is already running one is exactly what `pg` deprecated
 * in 8.x and removes in 9.0. It queues them internally today, which is why this went unnoticed: the
 * only symptom is a `DeprecationWarning`, and `util.deprecate` emits it once per process however often
 * it happens. Queueing them here instead costs nothing — the round trips were already serialized, only
 * silently and on the way out.
 *
 * Every notification carries its own `catch`, rather than one at the end of the chain: a failure to
 * publish belongs to the message that failed, and must not stop the ones behind it from going out.
 *
 * **This is genuinely at-most-once, on both ends (task 708, feature 411).** `client()` is read
 * fresh on every send rather than captured once, which is exactly what makes a send while
 * disconnected a silent no-op instead of a throw — but there is no buffer behind that check: a
 * notification sent while `client()` is `null` (nobody currently has a live LISTEN client — the
 * peer is down, or this side is mid-reconnect) is not queued for the next client that connects, and
 * `pg_notify` itself never persists a message for a channel with no active listener either way.
 * "Fire-and-forget" here means forgotten, not delayed, if the send happens to land in that gap. See
 * `core/db.ts`'s `subscribeToNotifications()` for which of this codebase's subscribers that matters
 * to, and why the ones that exist today tolerate it.
 *
 * @param client Read on each send, since the client is opened after this is built and dropped at
 *               shutdown. A notification sent while there is none is discarded.
 * @param label  What these notifications are, for the log line when one cannot be sent
 */
export function createNotifier(client: () => PoolClient | null, label: string): Notifier {
  let tail: Promise<void> = Promise.resolve()
  return {
    send(channel: string, payload: string): void {
      tail = tail.then(async () => {
        try {
          await client()?.query('SELECT pg_notify($1, $2)', [channel, payload])
        } catch (err: any) {
          WIKI.logger.warn('db', 'publishing a notification failed', {
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
 * The number of permanently-held LISTEN/NOTIFY clients this codebase opens: the event bus
 * (`core/db.ts`), the scheduler and collaborative editing, all named in `connectListener`'s own doc
 * comment above. `createListenerPool`'s `max` matches this exactly, not a padded guess -- see its
 * own doc comment for why.
 */
const LISTENER_COUNT = 3

/**
 * Build the dedicated connection pool the three permanently-held LISTEN/NOTIFY clients check out
 * from (task 1887, part of epic 1878).
 *
 * They used to `pool.connect()` straight out of the main query pool and hold that client for the
 * process lifetime, one each -- so the effective ceiling for application queries was
 * `WIKI.config.pool.max - 3`, not the configured `max` an operator reads it as. None of the three
 * ever runs an application query, so they do not belong in that pool at all: this gives them a pool
 * of their own, sized for exactly the load they put on it.
 *
 * `max: LISTENER_COUNT` (3) rather than some padded number -- every caller of `connectListener` in
 * this codebase holds its client for the process lifetime and reconnects in place on drop (see
 * `connectListener`'s own doc comment), so there is never a fourth concurrent checkout to make room
 * for. `min: 0` because idle listener slots between boot and the first `connectListener` call cost a
 * live server-side connection for nothing -- unlike the query pool, nothing here benefits from a
 * warm minimum. `connectionTimeoutMillis` defaults to 5s so a saturated pool fails fast rather than
 * hanging forever, the same reasoning `core/db.ts`'s own `max`/`connectionTimeoutMillis` work (task
 * 1883) applies to the query pool -- but always applied here, since this pool has no `config.yml`
 * knob of its own to be overridden by.
 *
 * Takes the same connection config the query pool is built from (host/user/password/database or
 * `connectionString`, plus SSL) rather than assembling its own: `core/db.ts`'s `init()` already
 * resolves that (env `DATABASE_URL` vs. `WIKI.config.db.*`, SSL cert loading) before constructing
 * its own pool, and duplicating that logic here would be two places that can drift apart on how a
 * database is reached.
 *
 * Called once, by `core/db.ts`'s `init()`, and the result stored as `WIKI.dbManager.listenerPool`
 * for the event bus, the scheduler and collaborative editing to all share -- one small pool for the
 * three of them, not three pools of one.
 */
export function createListenerPool(config: PoolConfig): Pool {
  return new Pool({
    ...config,
    min: 0,
    max: LISTENER_COUNT,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000
  })
}

/** A live, reconnecting LISTEN/NOTIFY client, as returned by {@link connectListener}. */
export interface ListenerHandle {
  /**
   * Stop this listener for good: no further reconnect attempts, and releases the live client, if
   * there is one, back to the pool.
   */
  close(): Promise<void>
}

export interface ListenerOptions {
  /**
   * Pool to (re)connect a dedicated client from -- the shared `WIKI.dbManager.listenerPool` built by
   * {@link createListenerPool}, never the main query pool. See `createListenerPool`'s doc comment
   * for why the two must not be the same pool.
   */
  pool: Pool
  /** `application_name` set on every (re)connection, so `pg_stat_activity` / AdminCluster can name it. */
  applicationName: string
  /** Channel(s) this client LISTENs on, (re-)issued on every (re)connection. */
  channels: string[]
  /** Attached to `'notification'` on every (re)connection. */
  onNotification: (msg: Notification) => void
  /** What this client is, for the log line when it drops or fails to reconnect. */
  label: string
  /** Read the currently live client, or `null` while a reconnect is in flight. */
  getClient: () => PoolClient | null
  /** Store the newly (re)connected client, or `null` right after it drops. */
  setClient: (client: PoolClient | null) => void
  /** Delay between reconnect attempts, in ms. Defaults to 3000. */
  retryDelayMs?: number
}

/**
 * Open a dedicated LISTEN/NOTIFY client that survives a dropped connection.
 *
 * node-postgres supervises a pool-routed query, but not a client checked out via `pool.connect()`
 * and held onto the way the three dedicated listener clients in this codebase are (the event bus in
 * `core/db.ts`, the scheduler, and collaborative editing): an `'error'` on such a client with nobody
 * listening throws on the client's own `EventEmitter`, which crashes the process on something as
 * ordinary as a connection reset, a Postgres restart, or idle-connection reaping by a proxy — turning
 * a transient network blip into a full instance death.
 *
 * The three callers are near-identical in shape — connect, set `application_name`, `LISTEN` one or
 * more channels, attach a `'notification'` handler — so this is shared between them rather than
 * written three times. On `'error'` the stale client is dropped (`setClient(null)`, mirroring each
 * caller's own shutdown path) and a fresh one is connected on a short backoff, re-issuing the same
 * `LISTEN`s and re-attaching the same notification handler, so the instance resumes on its own once
 * Postgres is reachable again instead of going silently dead — or crashing outright.
 *
 * Retries forever rather than giving up after some count: unlike the one-shot initial database
 * connection in `db.connect()`, there is no boot sequence waiting on this to fail fast, and a listener
 * that stops trying is exactly the "silently dead" outcome this exists to prevent.
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
      WIKI.logger.warn('db', 'lost the listener connection, reconnecting', {
        channel: label,
        error: err
      })
      client.release(true)
      setClient(null)
      client.release(true)
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
        WIKI.logger.warn('db', 'reconnecting the listener failed, retrying', {
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
