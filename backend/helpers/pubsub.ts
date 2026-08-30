import { setTimeout as delay } from 'node:timers/promises'
import type { Notification, Pool, PoolClient } from 'pg'

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
          WIKI.logger.warn(`Failed to publish a ${label} notification: ${err.message}`)
        }
      })
    },
    drained(): Promise<void> {
      return tail
    }
  }
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
  /** Pool to (re)connect a dedicated client from. */
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
      WIKI.logger.warn(`Lost the ${label} listener connection, reconnecting: ${err.message}`)
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
        WIKI.logger.warn(
          `Failed to (re)connect the ${label} listener, retrying in ${retryDelayMs}ms: ${err.message}`
        )
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
