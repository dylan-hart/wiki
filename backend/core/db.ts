import { isPlainObject } from 'es-toolkit/predicate'
import path from 'node:path'
import fs from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool, type PoolClient, type PoolConfig } from 'pg'
import { parse } from 'pg-connection-string'
import semver from 'semver'

import { relations } from '../db/relations.ts'
import { createDeferred } from '../helpers/common.ts'
import {
  connectListener,
  createListenerPool,
  createNotifier,
  type ListenerHandle
} from '../helpers/pubsub.ts'
import { acquireAdvisoryLock, type AdvisoryLockHandle } from '../helpers/advisoryLock.ts'
import maintenance from './maintenance.ts'

/**
 * Sends the event bus's cross-instance notifications, one at a time.
 *
 * Built here rather than on the object below because `notifyViaDB` is handed to Emittery as a bare
 * listener and so has no `this` to reach it through. The client is read per send for the same reason
 * it is elsewhere: it does not exist until `subscribeToNotifications`.
 *
 * The getter is defensive (`WIKI.dbManager?.pubsubClient`) rather than a bare dereference: this module
 * is also imported from `worker.ts` (transitively, as part of the task-loading import graph), whose own
 * minimal `WIKI` never sets `dbManager` at all — no worker task currently emits an outbound event, so
 * this getter has never actually been invoked from a worker thread, but a bare `WIKI.dbManager.pubsubClient`
 * would throw `TypeError: Cannot read properties of undefined` the moment one did, rather than degrading
 * to the silent no-op `createNotifier`'s own contract already documents for "nobody currently has a live
 * LISTEN client".
 */
const notifier = createNotifier(() => WIKI.dbManager?.pubsubClient ?? null, 'event bus')

/**
 * Postgres extensions the schema depends on, installed before the migrations run.
 *
 * `ltree` types the folder paths of the page tree and answers the ancestor queries the navigation is
 * built from; `pg_trgm` backs fuzzy text matching. `pgcrypto` was dropped from this list once for
 * `gen_random_uuid()` (core since Postgres 13, and 16 is the minimum this runs on) but is back for
 * `digest()`: a one-time backfill migration once used it to compute a sha1 hex digest of every
 * existing `userAvatars`/`siteAssets` row's blob (squashed away in the genesis migration reset, task
 * 2 — a fresh schema has no legacy rows left to backfill), and any future one-time backfill needing a
 * digest can reach for it the same way. Listed here rather than as a `CREATE EXTENSION` preamble
 * hand-written into a migration's own SQL for the reason explained below: a migration file cannot
 * express it durably.
 */
const REQUIRED_EXTENSIONS = ['ltree', 'pg_trgm', 'pgcrypto']

/**
 * Advisory lock key `syncSchemas()` serializes its DDL and `migrate()` under.
 *
 * Two instances starting cold at once both read the same not-yet-applied migration set and both try
 * to run it — drizzle computes `migrationsToRun` outside any lock of its own, so the loser's own
 * transaction fails on `relation already exists` (task 2041/epic 2037). Holding this for the whole
 * of `syncSchemas()` makes the loser block on `pg_advisory_lock` until the winner's migration has
 * fully committed, then re-read an already-migrated state and find nothing left to run.
 */
const MIGRATION_LOCK_KEY = 'wiki:migrate'

/**
 * Tables whose presence means the database belongs to a Wiki.js 2.x installation.
 *
 * `knex_migrations` is the 2.x migration ledger — 3.x tracks its own in `migrations`, via Drizzle —
 * and `searchEngines` is a 2.x-only table, kept as a second signal for a database whose migration
 * ledger somebody has dropped or renamed. Either one is enough: 3.x creates neither, so seeing one
 * cannot be a 3.x database. The names are the exact identifiers 2.x created, `searchEngines`
 * included, so they are compared case-sensitively against `information_schema`.
 */
const LEGACY_TABLES = ['knex_migrations', 'searchEngines']

/**
 * Query logger, consulted by Drizzle on every query.
 *
 * It emits unconditionally, at `debug` on the `sql` scope, and owns no gate of its own (OpenProject
 * #2663). Whether the line survives is the logger's decision, made per call against the `sql` scope's
 * effective threshold: the `sqlLog` admin flag raises it to `debug` from the next query onwards with
 * no restart, `logScopes: { sql: debug }` in config.yml does the same for a whole run, and at the
 * default `logLevel: info` it is dropped before a frame is even built.
 *
 * Bound parameter *values* are never logged, only redacted below. A bound parameter routinely carries
 * a secret — `models/settings.ts#updateConfig` binds a whole settings blob as one JSONB parameter, and
 * that blob can hold the API signing private key and its passphrase, the session secret, SMTP/LDAP/
 * OAuth credentials, storage-target keys, bcrypt hashes and TOTP secrets — and once the threshold does
 * let this line through it reaches both the container log pipeline and every connected admin terminal
 * client, via `controllers/terminal.ts`'s backlog replay. Redaction therefore lives inside `logQuery`
 * itself rather than behind any trigger, so every route out is covered identically. See OpenProject
 * #2205.
 */
export const queryLogger = {
  logQuery(query: string, params: unknown[]): void {
    WIKI.logger.debug(
      'sql',
      query,
      params.length > 0 ? { params: describeQueryParams(params) } : undefined
    )
  }
}

/**
 * Describes a bound-parameter array for logging without exposing any value it carries — see
 * `queryLogger` above.
 */
function describeQueryParams(params: unknown[]): string {
  const count = params.length
  return `(${count} param${count === 1 ? '' : 's'}: ${params.map(describeQueryParam).join(', ')})`
}

/** Type/length descriptor for one bound parameter. Never returns the value itself. */
function describeQueryParam(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null'
  }
  if (typeof value === 'string') {
    return `string(${value.length})`
  }
  if (Buffer.isBuffer(value)) {
    return `buffer(${value.length})`
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`
  }
  if (value instanceof Date) {
    return 'date'
  }
  if (typeof value === 'object') {
    return 'object'
  }
  return typeof value
}

/**
 * Build the Drizzle instance.
 *
 * `logger` is passed unconditionally rather than spread in from a conditional: a spread in the config
 * literal collapses the inferred relations to `EmptyRelations`, which would untype the whole
 * `db.query.*` relational API.
 */
function createDb(client: Pool) {
  return drizzle({ client, relations, logger: queryLogger })
}

/** The Drizzle instance, as returned by `init()` and exposed as `WIKI.db`. */
export type WikiDb = ReturnType<typeof createDb>

/**
 * The transaction handle `WIKI.db.transaction(async (tx) => ...)` hands its callback — the same
 * query-builder surface as `WikiDb` (`.select()`/`.insert()`/`.update()`/`.delete()`), but bound to one
 * checked-out connection for the life of the `BEGIN`/`COMMIT`. Derived from `WikiDb['transaction']`
 * itself rather than imported from `drizzle-orm/node-postgres` so it always matches whatever
 * `TRelations` `createDb` actually instantiates.
 */
export type WikiTx = Parameters<Parameters<WikiDb['transaction']>[0]>[0]

/**
 * Either the ambient `WIKI.db` or a transaction handle carved out of it. A model method that writes
 * more than one row and wants those writes to share a caller-controlled transaction takes this as an
 * optional `db` parameter, defaulting to the ambient `WIKI.db` — see `models/tree.ts`'s `addAsset`
 * call chain for the worked example.
 */
export type WikiDbOrTx = WikiDb | WikiTx

/**
 * Resolves the pool-size (`min`/`max`) options merged into the `new Pool()` call in `init()` below.
 *
 * A worker thread's pool is pinned to a single, non-persistent connection (`{ min: 0, max: 1 }`)
 * regardless of the instance-wide config — a CPU-bound job (see `worker.ts`) doesn't need, and
 * shouldn't hold open, a share of the main pool's budget. The main process instead takes whatever
 * `pool.min`/`pool.max` resolve to from `base.yml`/`config.yml` (see the comment on `pool.max` in
 * `base.yml` for what that value is sized against).
 *
 * Exported as its own pure function, rather than left as the inline ternary it used to be, so a
 * test can assert a configured `pool.max` reaches these options without needing a live Postgres
 * connection — the surrounding `new Pool()` call is otherwise only exercisable through `init()`'s
 * full connect-and-migrate sequence.
 */
export function resolvePoolSizeOptions(
  workerMode: boolean,
  configuredPool: PoolConfig
): Partial<PoolConfig> {
  return workerMode ? { min: 0, max: 1 } : configuredPool
}

/**
 * ORM DB module
 */
export default {
  pool: null as Pool | null,
  /**
   * Dedicated pool the three permanently-held LISTEN/NOTIFY clients (event bus, scheduler,
   * collaborative editing) check out from -- never the main query pool `pool` above, so holding
   * them for the process lifetime never eats into `WIKI.config.pool.max`. Built once in `init()`, by
   * `helpers/pubsub.ts`'s `createListenerPool` -- see its doc comment for the sizing rationale.
   */
  listenerPool: null as Pool | null,
  pubsubClient: null as PoolClient | null,
  listenerHandle: null as ListenerHandle | null,
  config: null as PoolConfig | null,
  dbName: null as string | null | undefined,
  VERSION: null as string | null,
  onReady: createDeferred(),
  connectAttempts: 0,
  /**
   * Initialize DB
   */
  async init(workerMode = false): Promise<WikiDb> {
    const startedAt = Date.now()

    // Fetch DB Config

    if (process.env.DATABASE_URL) {
      this.config = {
        connectionString: process.env.DATABASE_URL
      }
      this.dbName = parse(process.env.DATABASE_URL).database
    } else {
      this.config = {
        host: WIKI.config.db.host.toString(),
        user: WIKI.config.db.user.toString(),
        password: WIKI.config.db.pass.toString(),
        database: WIKI.config.db.db.toString(),
        port: WIKI.config.db.port
      }
      this.dbName = this.config.database
    }

    // Handle SSL Options

    let dbUseSSL =
      WIKI.config.db.ssl === true ||
      WIKI.config.db.ssl === 'true' ||
      WIKI.config.db.ssl === 1 ||
      WIKI.config.db.ssl === '1'
    let sslOptions: any = null
    if (dbUseSSL && isPlainObject(this.config) && WIKI.config.db?.sslOptions?.auto === false) {
      sslOptions = WIKI.config.db.sslOptions
      sslOptions.rejectUnauthorized = sslOptions.rejectUnauthorized !== false
      if (sslOptions.ca && sslOptions.ca.indexOf('-----') !== 0) {
        sslOptions.ca = await fs.readFile(path.resolve(WIKI.ROOTPATH, sslOptions.ca), 'utf-8')
      }
      if (sslOptions.cert) {
        sslOptions.cert = await fs.readFile(path.resolve(WIKI.ROOTPATH, sslOptions.cert), 'utf-8')
      }
      if (sslOptions.key) {
        sslOptions.key = await fs.readFile(path.resolve(WIKI.ROOTPATH, sslOptions.key), 'utf-8')
      }
      if (sslOptions.pfx) {
        // -> PKCS#12 is binary DER, unlike `ca`/`cert`/`key` (PEM, text) above -- reading it as
        //    'utf-8' corrupts the bundle and fails the TLS handshake with a confusing error
        //    (OpenProject #940). No encoding argument means `readFile` returns the raw `Buffer` node-
        //    postgres expects for `pfx`.
        sslOptions.pfx = await fs.readFile(path.resolve(WIKI.ROOTPATH, sslOptions.pfx))
      }
    } else {
      sslOptions = true
    }

    // Handle inline SSL CA Certificate mode
    if (process.env.DB_SSL_CA) {
      const chunks = []
      for (let i = 0, charsLength = process.env.DB_SSL_CA.length; i < charsLength; i += 64) {
        chunks.push(process.env.DB_SSL_CA.substring(i, i + 64))
      }

      dbUseSSL = true
      sslOptions = {
        rejectUnauthorized: true,
        ca: '-----BEGIN CERTIFICATE-----\n' + chunks.join('\n') + '\n-----END CERTIFICATE-----\n'
      }
    }

    if (dbUseSSL && isPlainObject(this.config)) {
      this.config.ssl = sslOptions === true ? { rejectUnauthorized: true } : sslOptions
    }

    // Initialize Postgres Pool

    // -> `WIKI.config.pool` carries operator-tunable `max`/`connectionTimeoutMillis`/
    //    `statementTimeoutMillis` (defaulted in base.yml, sized above `scheduler.workers` so the
    //    scheduler's own claim query is never the thing starved). `connectionTimeoutMillis` bounds
    //    how long `pool.connect()` waits for a checkout on a saturated pool -- unset, pg-pool waits
    //    forever, which is what let a saturated main pool wedge every DB-backed request handler,
    //    session load/save, and the scheduler's claim query indefinitely (task 2249). Worker-mode
    //    pools already stay tightly bounded in size (`max: 1`, one connection per worker thread) but
    //    still inherit the same connect timeout, since a worker's single connection can wedge the
    //    same way. `statement_timeout` has to travel via the `options` connection string -- pg-pool
    //    has no dedicated config key for it -- so Postgres itself cancels a runaway query rather than
    //    leaving it to run unbounded once a connection is checked out.
    const poolConfig = WIKI.config.pool ?? {}
    this.pool = new Pool({
      application_name: `Wiki.js - ${WIKI.INSTANCE_ID}:${workerMode ? 'WORKER' : 'MAIN'}`,
      ...this.config,
      connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
      ...resolvePoolSizeOptions(workerMode, WIKI.config.pool),
      options: `-c search_path=${WIKI.config.db.schema} -c statement_timeout=${poolConfig.statementTimeoutMillis}`
    })

    // -> node-postgres emits 'error' on the pool whenever a checked-in, idle client's connection
    //    fails (a Postgres restart, a failover, an idle timeout) -- `Pool extends EventEmitter`, so
    //    with no listener that 'error' is re-thrown as an uncaught exception and kills the process.
    //    node-postgres already discards the broken client itself, so logging is the whole fix: the
    //    next checkout opens a fresh connection. Same treatment as the dedicated LISTEN clients in
    //    `helpers/pubsub.ts`'s `connectListener`. Attached here in `init()` rather than after it
    //    returns so worker mode (`worker.ts`'s `ensureDb()`, which also calls `init(true)`) is
    //    covered too.
    this.pool.on('error', (err: any, client: any) => {
      WIKI.logger.error('db', 'pool error', {
        ...(err.code ? { code: err.code } : {}),
        ...(client?.processID ? { pid: client.processID } : {}),
        error: err
      })
    })

    // -> Worker mode never opens a LISTEN/NOTIFY client (see `subscribeToNotifications`'s only
    //    caller, `index.ts`'s `postBoot()`, which never runs in a worker thread), so a worker's
    //    `init()` has no use for this pool -- skip building it there.
    if (!workerMode) {
      this.listenerPool = createListenerPool({
        ...this.config,
        options: `-c search_path=${WIKI.config.db.schema}`
      })
    }

    const db = createDb(this.pool)

    // Connect
    await this.connect(db)

    // Check DB Version
    const resVersion = await db.execute('SHOW server_version;')
    const dbVersion = semver.coerce(resVersion.rows[0].server_version as string, { loose: true })!
    this.VERSION = dbVersion.version
    if (dbVersion.major < 16) {
      WIKI.logger.error('db', 'postgres version is unsupported', {
        postgres: dbVersion.version,
        minimum: '16'
      })
      process.exit(1)
    }

    // DEV - Drop schema
    await this.dropSchemaIfDev(db)

    // Run Migrations
    let migrationsApplied = 0
    if (!workerMode) {
      // -> `syncSchemas()` hands back the still-held advisory lock rather than releasing it itself
      //    (see its own doc comment) so a wider boot sequence could keep holding it past this point —
      //    not done yet (task 2044), so it is released immediately here.
      const before = await this.countAppliedMigrations(db)
      const migrationLock = await this.syncSchemas(db)
      await migrationLock.release()
      migrationsApplied = (await this.countAppliedMigrations(db)) - before
    }

    // -> One line for the whole of the above, rather than the seven progress announcements this
    //    replaced (OpenProject #2665): connecting, the server version, the schema, the extensions and
    //    the migrations are all just "did the database come up", and an operator wants the answer and
    //    what it cost, not the commentary.
    WIKI.logger.info('db', 'connected', {
      postgres: this.VERSION,
      schema: WIKI.config.db.schema,
      ...(workerMode ? {} : { migrations: migrationsApplied }),
      ms: Date.now() - startedAt
    })

    return db
  },
  /**
   * Rows in the migrations table, or 0 when there is no such table yet — which is exactly what a
   * first-run database looks like on the way in, and is why this answers rather than throws.
   *
   * Read either side of `syncSchemas()` so `db connected` can say how many migrations THIS boot
   * applied, rather than how many exist.
   */
  async countAppliedMigrations(db: WikiDb): Promise<number> {
    try {
      const res = await db.execute(
        `SELECT count(*)::int AS total FROM ${WIKI.config.db.schema}.migrations`
      )
      return (res.rows[0]?.total as number) ?? 0
    } catch {
      return 0
    }
  },
  /**
   * DEV - Drop schema, gated on `WIKI.IS_DEBUG` (OpenProject task 2270).
   *
   * `dev.dropSchema` is presented in `config.sample.yml` under a "Dev Mode" heading, but the config
   * value alone used to be trusted in every mode: `config.yml` is merged over `base.yml` with no
   * environment condition, and `helpers/config.ts#parseConfigValue` also lets the value arrive from
   * an environment variable, so an operator who reasonably reads that heading as "inert outside dev"
   * would be wrong. Left ungated, a config carried into production intact -- or an env var aimed at
   * the wrong layer -- drops the schema, total and irreversible, on the very next boot.
   *
   * `WIKI.IS_DEBUG` (`index.ts`) is derived solely from `NODE_ENV === 'development'`, not from any
   * wiki config or `dev.*` env var, so it cannot be flipped by the same misconfiguration this guards
   * against. When the key is set but the guard blocks it, an explicit refusal is logged instead of
   * silently doing nothing, so a developer running with the wrong `NODE_ENV` is not left wondering
   * why their schema was not dropped.
   *
   * `dropSchema` is the only member of `dev` this file reads. The `dev.logQueries` key it used to
   * read alongside it is gone: `logScopes: { sql: debug }` says the same thing in the vocabulary the
   * logger already validates, and a second, dev-only trigger for one scope's threshold was one
   * switch too many (OpenProject #2663).
   */
  async dropSchemaIfDev(db: WikiDb): Promise<void> {
    if (!WIKI.config.dev?.dropSchema) {
      return
    }
    if (!WIKI.IS_DEBUG) {
      WIKI.logger.warn('db', 'dev.dropSchema refused, not a debug boot', {
        schema: WIKI.config.db.schema
      })
      return
    }
    WIKI.logger.warn('db', 'dev mode, dropping schema', { schema: WIKI.config.db.schema })
    await db.execute(`DROP SCHEMA IF EXISTS ${WIKI.config.db.schema} CASCADE;`)
  },
  /**
   * Subscribe to database LISTEN / NOTIFY for multi-instances events
   *
   * **Delivery guarantee: at-most-once, not at-least-once (task 708, feature 411).** Postgres
   * NOTIFY has no persistence — a message published while nobody is LISTENing on `wiki` (the only
   * other instance down or mid-restart, or this instance's own listener between a dropped
   * connection and `connectListener`'s reconnect landing, see `helpers/pubsub.ts`) is dropped by
   * the server for good, not queued for redelivery. `notifyViaDB`/`notifier` (`createNotifier`)
   * mirror that faithfully on the sending side rather than trying to paper over it: a send with no
   * live client is a silent no-op, never buffered.
   *
   * All eight current subscribers below already tolerate a missed notification, but not for the same
   * reason a naive read of their code might suggest — none re-checks the DB on a timer:
   *  - `configSvc.subscribeToEvents()`'s `reloadConfig` handler, `maintenance.subscribeToEvents()`'s
   *    `flushCaches`/`disconnectWebsockets` handlers, and `groups`/`sites`/`approvals`/
   *    `classificationLevels`/`glossary`/`locales`' `reloadGroups`/`reloadSites`/`reloadApprovals`/
   *    `reloadClassificationLevels`/`reloadGlossary`/`reloadLocales` handlers (each model's own
   *    `broadcastReload()` is what emits the matching outbound event, right after refreshing this
   *    instance's own cache — see `models/groups.ts`'s `broadcastReload()` for the shape every one of
   *    them follows) are purely edge-triggered. A missed one has no independent side channel back
   *    except another matching event later, or this instance's own restart.
   *  - What actually closes the common case is `index.ts`: `preBoot()` calls
   *    `configSvc.loadFromDb()` and `postBoot()` calls `groups`/`sites`/`locales`/`approvals`/
   *    `classificationLevels` `.reloadCache()` **unconditionally on every boot**, not gated on any
   *    notification having arrived. So an instance that missed an event while it was down is always
   *    fully resynced the moment it comes back — that is the scenario the task description calls
   *    out, and it is closed by construction, not by chance.
   *  - The one gap this does *not* close is a notification lost during this instance's own brief
   *    reconnect window while it otherwise stays up the whole time: nothing re-syncs until the next
   *    matching event or a restart. Judged low-severity (bounded window, and every current event —
   *    `reloadConfig` on every settings save, `flushCaches`/`disconnectWebsockets` as one-shot admin
   *    actions, `reloadGroups`/`reloadSites`/`reloadApprovals` on their respective model writes —
   *    has no state beyond what the database already holds and the next write's own broadcast will
   *    resync) and left as a documented at-most-once contract rather than closed with a new poller —
   *    see `dev/multi-instance-verify/README.md` §8 and `core/db.test.ts` for the full writeup and
   *    regression coverage. A future subscriber that needs stronger guarantees should re-sync from
   *    the DB itself (on an interval, or at least on its own boot) rather than assume this channel
   *    ever redelivers.
   *  - `glossary.subscribeToEvents()`'s `invalidateGlossaryCache` handler (OpenProject #2038) is the
   *    seventh, and needs no boot-time re-sync at all to close the same gap: its cache is lazily
   *    populated per site on first read rather than warmed at boot, so a fresh `WIKI.cache` (a new
   *    `LRUCache` every process start, `index.ts`) simply has nothing stale to miss-invalidate right
   *    after a restart. The residual reconnect-window gap above still applies while the instance
   *    stays up, which is what `models/glossary.ts`'s bounded `CACHE_TTL_MS` on each cache entry is
   *    the belt for — see its own doc comment.
   */
  async subscribeToNotifications(): Promise<void> {
    const connectionAppName = `Wiki.js - ${WIKI.INSTANCE_ID}:EVENTS`

    // -> `connectListener` attaches the 'error' handler this client needs (see helpers/pubsub.ts):
    //    on a dropped connection it re-connects and re-LISTENs on its own, rather than throwing on
    //    an unhandled 'error' and taking the process down with it.
    this.listenerHandle = await connectListener({
      pool: this.listenerPool!,
      applicationName: connectionAppName,
      channels: ['wiki'],
      label: 'event bus',
      onNotification: (msg) => {
        if (msg.channel !== 'wiki') {
          return
        }
        try {
          const decoded = JSON.parse(msg.payload!)
          if ('event' in decoded && decoded.source !== WIKI.INSTANCE_ID) {
            WIKI.logger.debug('cluster', 'event received', {
              event: decoded.event,
              instance: decoded.source
            })
            WIKI.events.inbound.emit(decoded.event, decoded.value)
          }
        } catch {}
      },
      getClient: () => this.pubsubClient,
      setClient: (client) => {
        this.pubsubClient = client
      }
    })

    // -> Cast because `onAny` types the event as every pair the map allows plus Emittery's own meta
    //    events, and this listener is written to the one shape they have in common
    WIKI.events.outbound.onAny(this.notifyViaDB as any)

    // -> Listen to inbound events

    // WIKI.auth.subscribeToEvents()
    WIKI.configSvc.subscribeToEvents()
    maintenance.subscribeToEvents()
    WIKI.models.groups.subscribeToEvents()
    WIKI.models.sites.subscribeToEvents()
    WIKI.models.approvalRules.subscribeToEvents()
    WIKI.models.classificationLevels.subscribeToEvents()
    WIKI.models.glossary.subscribeToEvents()
    WIKI.models.locales.subscribeToEvents()
    // WIKI.db.pages.subscribeToEvents()

    WIKI.logger.debug('cluster', 'event listener subscribed')
  },
  /**
   * Unsubscribe from database LISTEN / NOTIFY
   */
  async unsubscribeFromNotifications(): Promise<void> {
    if (this.listenerHandle) {
      WIKI.events.outbound.offAny(this.notifyViaDB as any)
      WIKI.events.inbound.clearListeners()
      // -> Whatever the last events queued goes out before the client goes: releasing it from under a
      //    notification in flight would fail that one for no reason
      await notifier.drained()
      await this.listenerHandle.close()
      this.listenerHandle = null
    }
  },
  /**
   * Shut down the database manager for a graceful process exit.
   *
   * Composes the two independent teardown steps the caller previously fired off separately (and
   * unawaited — see `index.ts`'s `SHUTTING_DOWN` handler, task 708 follow-up OpenProject #2023)
   * into one awaitable promise: unsubscribe from LISTEN/NOTIFY first, then end the pool. Ordering
   * matters, not just bundling — `unsubscribeFromNotifications()`'s own `notifier.drained()` still
   * needs a live pool to flush anything queued, so ending the pool first would fail that drain for
   * no reason.
   *
   * `pool` can be `null` if `init()` was never called (e.g. worker mode never creates one for some
   * call paths, or a test harness) — guarded rather than assumed non-null. `backend/index.ts`'s
   * `gracefulServer(...)` `closePromises` holds this call (OpenProject #2028).
   */
  async shutdown(): Promise<void> {
    await this.unsubscribeFromNotifications()
    await this.pool?.end()
  },
  /**
   * Publish event via database NOTIFY
   *
   * Takes one `{ name, data }` object, which is what Emittery hands an `onAny` listener — not the
   * `(eventName, eventData)` pair `on` listeners used to get before 2.x. `data` is absent, rather
   * than undefined, for an event emitted without a payload.
   *
   * @param event Event fired, and its payload
   */
  notifyViaDB({ name, data }: { name?: string; data?: unknown }): void {
    notifier.send(
      'wiki',
      JSON.stringify({
        source: WIKI.INSTANCE_ID,
        event: name,
        value: data ?? null
      })
    )
  },
  /**
   * Attempt initial connection
   */
  async connect(db: WikiDb): Promise<void> {
    try {
      await db.execute('SELECT 1 + 1;')
    } catch (err: any) {
      if (this.connectAttempts < 10) {
        // -> One record per failed attempt, at `warn`: this is the self-healing case, and the
        //    `error` an operator has to act on is the throw below once the attempts run out.
        WIKI.logger.warn('db', 'connection failed, retrying', {
          attempt: `${++this.connectAttempts}/10`,
          ...(err.code ? { code: err.code, address: `${err.address}:${err.port}` } : {}),
          error: err
        })
        await setTimeout(3000)
        await this.connect(db)
      } else {
        throw err
      }
    }
  },
  /**
   * Refuse to run against a Wiki.js 2.x database.
   *
   * Checked before anything is created or migrated, because there is no upgrade path: the 3.x
   * migrations would run over the 2.x tables they know nothing about and leave a database that is
   * neither version. Exits rather than throws — a 2.x database is not something a retry or a later
   * boot phase can recover from, and the operator has to point the config at a fresh one.
   */
  async checkForLegacyInstall(db: WikiDb): Promise<void> {
    const res = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${WIKI.config.db.schema} AND table_name IN ${LEGACY_TABLES}
      LIMIT 1
    `)
    if (res.rows.length > 0) {
      WIKI.logger.error(
        'db',
        'refusing to boot, upgrading from a 2.x installation is unsupported',
        {
          table: res.rows[0].table_name,
          schema: WIKI.config.db.schema
        }
      )
      process.exit(1)
    }
  },
  /**
   * Migrate DB Schemas
   *
   * Holds a session-scoped advisory lock (`MIGRATION_LOCK_KEY`) across the legacy-install check,
   * `CREATE SCHEMA`, `CREATE EXTENSION` and `migrate()` below — see `MIGRATION_LOCK_KEY`'s own doc
   * comment for why. Taken off `this.pool` rather than `WIKI.db.$client`/`withAdvisoryLock`: `WIKI.db`
   * is only assigned from this method's caller's return value (`index.ts` does `WIKI.db =
   * await dbManager.init()`), so it does not exist yet at this point in boot.
   *
   * Returns the still-held lock handle rather than releasing it itself, so a wider caller can go on
   * holding it past this method returning — `init()` releases it immediately for now, but a boot
   * sequence that also needs to serialize first-run seeding against this same lock (task 2044) can
   * hold it further before calling `release()`.
   */
  async syncSchemas(db: WikiDb): Promise<AdvisoryLockHandle> {
    const lock = await acquireAdvisoryLock(this.pool as Pool, MIGRATION_LOCK_KEY)
    try {
      await this.checkForLegacyInstall(db)

      await db.execute(`CREATE SCHEMA IF NOT EXISTS ${WIKI.config.db.schema}`)

      /*
        Here rather than at the top of the first migration, for the same reason the schema itself is:
        the migrations need these to exist and cannot express them.

        `drizzle-kit generate` builds a migration by diffing the schema definition against the previous
        snapshot, and an extension is part of neither — so a hand-written `CREATE EXTENSION` preamble
        survives only until somebody regenerates, at which point the very first migration fails on the
        `ltree` column it can no longer create. Stated here, that cannot happen.

        Idempotent, so a database whose extensions an administrator installed by hand is untouched.
      */
      for (const extension of REQUIRED_EXTENSIONS) {
        await db.execute(`CREATE EXTENSION IF NOT EXISTS ${extension}`)
      }

      await migrate(db, {
        migrationsFolder: path.join(WIKI.SERVERPATH, 'db/migrations'),
        migrationsSchema: WIKI.config.db.schema,
        migrationsTable: 'migrations'
      })

      return lock
    } catch (err) {
      await lock.release()
      throw err
    }
  }
}
