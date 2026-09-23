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
  verifyListenerDelivery,
  type ListenerHandle
} from '../helpers/pubsub.ts'
import { acquireAdvisoryLock, type AdvisoryLockHandle } from '../helpers/advisoryLock.ts'
import maintenance from './maintenance.ts'
import { bootstrapPgvector } from './pgvectorBootstrap.ts'

/**
 * Module-level rather than on the object below: `notifyViaDB` is handed to Emittery as a bare
 * listener and has no `this`. The getter is optional-chained because a worker thread's minimal
 * `CARDINAL` has no `dbManager`; a send there degrades to `createNotifier`'s no-op.
 */
const notifier = createNotifier(() => CARDINAL.dbManager?.pubsubClient ?? null, 'event bus')

/**
 * `ltree` types the page tree's folder paths and answers its ancestor queries; `pg_trgm` backs
 * fuzzy title matching. `pgcrypto` is only there so a backfill migration can call `digest()` —
 * `gen_random_uuid()` is core Postgres.
 */
const REQUIRED_EXTENSIONS = ['ltree', 'pg_trgm', 'pgcrypto']

/**
 * Drizzle computes `migrationsToRun` outside any lock, so two instances booting cold would both run
 * the same migrations and the loser would fail on `relation already exists`. Held for the whole of
 * `syncSchemas()`, the loser blocks until the winner has committed and then finds nothing to run.
 */
const MIGRATION_LOCK_KEY = 'wiki:migrate'

/**
 * Either table means a Wiki.js 2.x database: `knex_migrations` is the 2.x migration ledger, and the
 * 2.x-only `searchEngines` is a second signal should the ledger have been dropped. 3.x creates
 * neither. These are the exact identifiers 2.x created, compared case-sensitively.
 */
const LEGACY_TABLES = ['knex_migrations', 'searchEngines']

/**
 * Emits every query at `debug sql` with no gate of its own; the `sql` scope's threshold decides
 * whether the line survives.
 *
 * Bound parameter values are never logged, only described. A parameter routinely carries a secret —
 * `models/settings.ts#updateConfig` binds the whole settings blob as one JSONB parameter — and the
 * line reaches the container log and every connected admin terminal client.
 */
export const queryLogger = {
  logQuery(query: string, params: unknown[]): void {
    CARDINAL.logger.debug(
      'sql',
      query,
      params.length > 0 ? { params: describeQueryParams(params) } : undefined
    )
  }
}

function describeQueryParams(params: unknown[]): string {
  const count = params.length
  return `(${count} param${count === 1 ? '' : 's'}: ${params.map(describeQueryParam).join(', ')})`
}

/** Type and length only, never the value itself — see `queryLogger`. */
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
 * A generated `select` with its relations joined in runs to several kilobytes; the leading clause
 * is enough to say which shape of query is slow.
 */
const SLOW_QUERY_TEXT_LIMIT = 200

/** Marks an already-wrapped client, so a second wrap cannot stack timers and report twice. */
const SLOW_QUERY_INSTRUMENTED = Symbol('wiki:slowQueryInstrumented')

/** 0 means off. Read per call, so a test can drive the wrapper through the config value alone. */
function slowQueryThresholdMs(): number {
  const configured = Number(CARDINAL.config.slowQueryMs)
  return Number.isFinite(configured) && configured > 0 ? configured : 0
}

/**
 * `pg` accepts `query(text, values?)`, `query({ text, values })` (what Drizzle sends) and
 * `query(submittable)` for a `Cursor`/`QueryStream`. A submittable streams rows after returning, so
 * it has no single duration to report: `null`, and the call goes through untimed.
 */
function describeQueryCall(args: unknown[]): { text: string; values: unknown[] } | null {
  const [first, second] = args
  if (typeof first === 'string') {
    return { text: first, values: Array.isArray(second) ? second : [] }
  }
  if (typeof first === 'object' && first !== null && typeof (first as any).text === 'string') {
    const config = first as { text: string; values?: unknown[]; submit?: unknown }
    // -> A `Cursor` also carries `text`, and is distinguished by being submittable.
    if (typeof config.submit === 'function') {
      return null
    }
    return {
      text: config.text,
      values: Array.isArray(config.values) ? config.values : Array.isArray(second) ? second : []
    }
  }
  return null
}

/**
 * Parameters go through the same `describeQueryParams` redactor as `queryLogger`: a `warn` reaches
 * stdout and every admin log client at the default `logLevel`, not only when the firehose is on.
 */
function reportSlowQuery(
  text: string,
  values: unknown[],
  ms: number,
  rows: number | undefined
): void {
  CARDINAL.logger.warn('sql', 'slow query', {
    ...(rows === undefined ? {} : { rows }),
    query: text.length > SLOW_QUERY_TEXT_LIMIT ? `${text.slice(0, SLOW_QUERY_TEXT_LIMIT)}…` : text,
    ...(values.length > 0 ? { params: describeQueryParams(values) } : {}),
    ms
  })
}

/**
 * Wraps each physical connection's `query` once, as the main pool's `connect` listener. Drizzle's
 * `Logger` cannot time a query: it is called synchronously before the query is sent.
 *
 * Sitting on the pool, below Drizzle, it also times raw `db.execute()` calls and the boot-time
 * migration runner — deliberately. The LISTEN/NOTIFY pool carries no query traffic and is not
 * instrumented.
 *
 * A rejected query is reported too, without `rows`: a `statement_timeout` cancellation is the slow
 * query most worth naming.
 */
export function instrumentSlowQueries(client: any): void {
  if (!client || typeof client.query !== 'function' || client[SLOW_QUERY_INSTRUMENTED]) {
    return
  }
  client[SLOW_QUERY_INSTRUMENTED] = true

  const runQuery = client.query.bind(client)

  client.query = (...args: any[]) => {
    if (slowQueryThresholdMs() <= 0) {
      return runQuery(...args)
    }
    const described = describeQueryCall(args)
    if (!described) {
      return runQuery(...args)
    }

    const startedAt = Date.now()
    const finish = (result: any) => {
      const ms = Date.now() - startedAt
      const threshold = slowQueryThresholdMs()
      if (threshold > 0 && ms >= threshold) {
        reportSlowQuery(
          described.text,
          described.values,
          ms,
          typeof result?.rowCount === 'number' ? result.rowCount : undefined
        )
      }
    }

    // -> `query(..., callback)` is the other half of `pg`'s API and is what `pg-pool`'s own internal
    //    calls use; wrapping only the promise form would leave those untimed.
    const last = args[args.length - 1]
    if (typeof last === 'function') {
      const timed = args.slice(0, -1)
      timed.push((err: any, result: any) => {
        finish(result)
        last(err, result)
      })
      return runQuery(...timed)
    }

    const result = runQuery(...args)
    if (result && typeof result.then === 'function') {
      return result.then(
        (resolved: any) => {
          finish(resolved)
          return resolved
        },
        (err: any) => {
          finish(undefined)
          throw err
        }
      )
    }
    return result
  }
}

/**
 * `logger` is passed unconditionally rather than spread in from a conditional: a spread in the
 * config literal collapses the inferred relations to `EmptyRelations`, which would untype the whole
 * `db.query.*` relational API.
 */
function createDb(client: Pool) {
  return drizzle({ client, relations, logger: queryLogger })
}

export type WikiDb = ReturnType<typeof createDb>

/**
 * Derived from `WikiDb['transaction']` rather than imported from `drizzle-orm/node-postgres`, so it
 * always matches the `TRelations` `createDb` instantiates.
 */
export type WikiTx = Parameters<Parameters<WikiDb['transaction']>[0]>[0]

/**
 * What a model method takes as an optional `db` parameter, defaulting to `CARDINAL.db`, when its
 * writes should be able to join a caller-controlled transaction.
 */
export type WikiDbOrTx = WikiDb | WikiTx

/**
 * A worker thread runs one CPU-bound job, so its pool is a single non-persistent connection
 * whatever `pool.min`/`pool.max` are configured to.
 */
export function resolvePoolSizeOptions(
  workerMode: boolean,
  configuredPool: PoolConfig
): Partial<PoolConfig> {
  return workerMode ? { min: 0, max: 1 } : configuredPool
}

export type DirectConnectionSource = 'DATABASE_DIRECT_URL' | 'db.direct'

export interface DirectConnectionInput {
  directUrl?: string | null
  direct?: { host?: unknown; port?: unknown } | null
  queryFromUrl: boolean
}

export interface DirectConnection {
  config: PoolConfig
  source: DirectConnectionSource | null
  ignoredDirectBlock: boolean
}

function isSet(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

export function resolveDirectConnection(
  queryConfig: PoolConfig,
  input: DirectConnectionInput
): DirectConnection {
  if (isSet(input.directUrl)) {
    return {
      config: {
        connectionString: String(input.directUrl).trim(),
        ...(queryConfig.ssl !== undefined ? { ssl: queryConfig.ssl } : {})
      },
      source: 'DATABASE_DIRECT_URL',
      ignoredDirectBlock: false
    }
  }

  const host = input.direct?.host
  const port = input.direct?.port
  if (!isSet(host) && !isSet(port)) {
    return { config: queryConfig, source: null, ignoredDirectBlock: false }
  }
  if (input.queryFromUrl) {
    return { config: queryConfig, source: null, ignoredDirectBlock: true }
  }

  let resolvedPort = queryConfig.port
  if (isSet(port)) {
    resolvedPort = Number(String(port).trim())
    if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
      throw new Error(`db.direct.port must be a port number, got "${String(port)}"`)
    }
  }
  return {
    config: {
      ...queryConfig,
      host: isSet(host) ? String(host).trim() : queryConfig.host,
      port: resolvedPort
    },
    source: 'db.direct',
    ignoredDirectBlock: false
  }
}

export default {
  pool: null as Pool | null,
  /**
   * Dedicated to the permanently-held LISTEN/NOTIFY clients, so holding them for the process
   * lifetime never eats into `CARDINAL.config.pool.max`.
   */
  listenerPool: null as Pool | null,
  pubsubClient: null as PoolClient | null,
  listenerHandle: null as ListenerHandle | null,
  config: null as PoolConfig | null,
  dbName: null as string | null | undefined,
  VERSION: null as string | null,
  onReady: createDeferred(),
  connectAttempts: 0,
  async init(workerMode = false): Promise<WikiDb> {
    const startedAt = Date.now()

    if (process.env.DATABASE_URL) {
      this.config = {
        connectionString: process.env.DATABASE_URL
      }
      this.dbName = parse(process.env.DATABASE_URL).database
    } else {
      this.config = {
        host: CARDINAL.config.db.host.toString(),
        user: CARDINAL.config.db.user.toString(),
        password: CARDINAL.config.db.pass.toString(),
        database: CARDINAL.config.db.db.toString(),
        port: CARDINAL.config.db.port
      }
      this.dbName = this.config.database
    }

    let dbUseSSL =
      CARDINAL.config.db.ssl === true ||
      CARDINAL.config.db.ssl === 'true' ||
      CARDINAL.config.db.ssl === 1 ||
      CARDINAL.config.db.ssl === '1'
    let sslOptions: any = null
    if (dbUseSSL && isPlainObject(this.config) && CARDINAL.config.db?.sslOptions?.auto === false) {
      sslOptions = CARDINAL.config.db.sslOptions
      sslOptions.rejectUnauthorized = sslOptions.rejectUnauthorized !== false
      if (sslOptions.ca && sslOptions.ca.indexOf('-----') !== 0) {
        sslOptions.ca = await fs.readFile(path.resolve(CARDINAL.ROOTPATH, sslOptions.ca), 'utf-8')
      }
      if (sslOptions.cert) {
        sslOptions.cert = await fs.readFile(
          path.resolve(CARDINAL.ROOTPATH, sslOptions.cert),
          'utf-8'
        )
      }
      if (sslOptions.key) {
        sslOptions.key = await fs.readFile(path.resolve(CARDINAL.ROOTPATH, sslOptions.key), 'utf-8')
      }
      if (sslOptions.pfx) {
        // -> PKCS#12 is binary DER, unlike the PEM `ca`/`cert`/`key` above -- reading it as 'utf-8'
        //    corrupts the bundle and fails the TLS handshake. No encoding argument returns the raw
        //    `Buffer` node-postgres expects for `pfx`.
        sslOptions.pfx = await fs.readFile(path.resolve(CARDINAL.ROOTPATH, sslOptions.pfx))
      }
    } else {
      sslOptions = true
    }

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

    // -> `connectionTimeoutMillis` bounds how long `pool.connect()` waits for a checkout on a
    //    saturated pool -- unset, pg-pool waits forever and every DB-backed caller wedges with it.
    //    A worker's single connection can wedge the same way, so worker mode inherits it too.
    //    `statement_timeout` has Postgres itself cancel a runaway query on a held connection.
    const poolConfig = CARDINAL.config.pool ?? {}
    this.pool = new Pool({
      application_name: `Cardinal.js - ${CARDINAL.INSTANCE_ID}:${workerMode ? 'WORKER' : 'MAIN'}`,
      ...this.config,
      connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
      ...resolvePoolSizeOptions(workerMode, CARDINAL.config.pool),
      options: `-c search_path=${CARDINAL.config.db.schema} -c statement_timeout=${poolConfig.statementTimeoutMillis}`
    })

    // -> The pool emits 'error' when an idle client's connection fails (a Postgres restart, a
    //    failover); with no listener that is an uncaught exception and kills the process.
    //    node-postgres discards the broken client itself, so logging is the whole handling.
    //    Attached inside `init()` so worker mode is covered too.
    this.pool.on('error', (err: any, client: any) => {
      CARDINAL.logger.error('db', 'pool error', {
        ...(err.code ? { code: err.code } : {}),
        ...(client?.processID ? { pid: client.processID } : {}),
        error: err
      })
    })

    // -> `connect` fires once per new physical connection, before anything has used it. Attached
    //    unconditionally: `instrumentSlowQueries` owns the on/off decision, per call.
    this.pool.on('connect', instrumentSlowQueries)

    // -> A worker thread never opens a LISTEN/NOTIFY client.
    let directSource: DirectConnectionSource | null = null
    if (!workerMode) {
      const direct = resolveDirectConnection(this.config, {
        directUrl: process.env.DATABASE_DIRECT_URL,
        direct: CARDINAL.config.db.direct,
        queryFromUrl: Boolean(process.env.DATABASE_URL)
      })
      if (direct.ignoredDirectBlock) {
        CARDINAL.logger.warn('db', 'db.direct is ignored while DATABASE_URL is set', {
          use: 'DATABASE_DIRECT_URL'
        })
      }
      directSource = direct.source
      this.listenerPool = createListenerPool({
        ...direct.config,
        options: `-c search_path=${CARDINAL.config.db.schema}`
      })
    }

    const db = createDb(this.pool)

    await this.connect(db)

    const resVersion = await db.execute('SHOW server_version;')
    const dbVersion = semver.coerce(resVersion.rows[0].server_version as string, { loose: true })!
    this.VERSION = dbVersion.version
    if (dbVersion.major < 16) {
      CARDINAL.logger.error('db', 'postgres version is unsupported', {
        postgres: dbVersion.version,
        minimum: '16'
      })
      process.exit(1)
    }

    if (!workerMode) {
      await verifyListenerDelivery({
        listenerPool: this.listenerPool!,
        notify: (channel, payload) =>
          this.pool!.query('SELECT pg_notify($1, $2)', [channel, payload])
      })
    }

    await this.dropSchemaIfDev(db)

    let migrationsApplied = 0
    if (!workerMode) {
      // -> Released straight away: first-run seeding (`configSvc.ensureSeeded()`) takes the same
      //    lock key for itself rather than inheriting this handle.
      const before = await this.countAppliedMigrations(db)
      const migrationLock = await this.syncSchemas(db)
      await migrationLock.release()
      migrationsApplied = (await this.countAppliedMigrations(db)) - before
    }

    CARDINAL.logger.info('db', 'connected', {
      postgres: this.VERSION,
      schema: CARDINAL.config.db.schema,
      ...(workerMode ? {} : { migrations: migrationsApplied }),
      ...(directSource ? { listeners: directSource } : {}),
      ms: Date.now() - startedAt
    })

    return db
  },
  /**
   * Answers 0 rather than throwing when the table does not exist yet, which is what a first-run
   * database looks like. Read either side of `syncSchemas()` to count what this boot applied.
   */
  async countAppliedMigrations(db: WikiDb): Promise<number> {
    try {
      const res = await db.execute(
        `SELECT count(*)::int AS total FROM ${CARDINAL.config.db.schema}.migrations`
      )
      return (res.rows[0]?.total as number) ?? 0
    } catch {
      return 0
    }
  },
  /**
   * `dev.dropSchema` alone is not trusted: a config file or env var carried into production would
   * drop the schema on the next boot. `CARDINAL.IS_DEBUG` derives solely from `NODE_ENV`, so the
   * same misconfiguration cannot flip it. A blocked request is logged, so a developer on the wrong
   * `NODE_ENV` can see why nothing was dropped.
   */
  async dropSchemaIfDev(db: WikiDb): Promise<void> {
    if (!CARDINAL.config.dev?.dropSchema) {
      return
    }
    if (!CARDINAL.IS_DEBUG) {
      CARDINAL.logger.warn('db', 'dev.dropSchema refused, not a debug boot', {
        schema: CARDINAL.config.db.schema
      })
      return
    }
    CARDINAL.logger.warn('db', 'dev mode, dropping schema', { schema: CARDINAL.config.db.schema })
    await db.execute(`DROP SCHEMA IF EXISTS ${CARDINAL.config.db.schema} CASCADE;`)
  },
  /**
   * Delivery is at-most-once. Postgres NOTIFY has no persistence: a message published while nobody
   * is LISTENing on `wiki` (the other instance down, or this one's listener mid-reconnect) is
   * dropped for good, and `notifier` does not buffer a send made with no live client either.
   *
   * Every subscriber below is edge-triggered and tolerates that, because `index.ts` loads the
   * config and reloads each model cache unconditionally on every boot, so an instance that missed
   * an event while down resyncs as it comes back. A notification lost during a reconnect while the
   * instance stays up is not recovered until the next matching event or a restart. A subscriber
   * needing a stronger guarantee must re-sync from the DB itself rather than assume redelivery.
   */
  async subscribeToNotifications(): Promise<void> {
    const connectionAppName = `Cardinal.js - ${CARDINAL.INSTANCE_ID}:EVENTS`

    // -> `connectListener` re-connects and re-LISTENs on its own when the connection drops.
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
          if ('event' in decoded && decoded.source !== CARDINAL.INSTANCE_ID) {
            CARDINAL.logger.debug('cluster', 'event received', {
              event: decoded.event,
              instance: decoded.source
            })
            CARDINAL.events.inbound.emit(decoded.event, decoded.value)
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
    CARDINAL.events.outbound.onAny(this.notifyViaDB as any)

    CARDINAL.configSvc.subscribeToEvents()
    maintenance.subscribeToEvents()
    CARDINAL.models.groups.subscribeToEvents()
    CARDINAL.models.sites.subscribeToEvents()
    CARDINAL.models.approvalRules.subscribeToEvents()
    CARDINAL.models.classificationLevels.subscribeToEvents()
    CARDINAL.models.glossary.subscribeToEvents()
    CARDINAL.models.locales.subscribeToEvents()

    CARDINAL.logger.debug('cluster', 'event listener subscribed')
  },
  async unsubscribeFromNotifications(): Promise<void> {
    if (this.listenerHandle) {
      CARDINAL.events.outbound.offAny(this.notifyViaDB as any)
      CARDINAL.events.inbound.clearListeners()
      // -> Queued notifications go out before the client is released from under them
      await notifier.drained()
      await this.listenerHandle.close()
      this.listenerHandle = null
    }
  },
  /** Unsubscribes first, so no inbound cluster event starts a query on a pool that is ending. */
  async shutdown(): Promise<void> {
    await this.unsubscribeFromNotifications()
    await this.pool?.end()
  },
  /**
   * An Emittery `onAny` listener, which is handed one `{ name, data }` object; `data` is absent for
   * an event emitted without a payload.
   */
  notifyViaDB({ name, data }: { name?: string; data?: unknown }): void {
    notifier.send(
      'wiki',
      JSON.stringify({
        source: CARDINAL.INSTANCE_ID,
        event: name,
        value: data ?? null
      })
    )
  },
  async connect(db: WikiDb): Promise<void> {
    try {
      await db.execute('SELECT 1 + 1;')
    } catch (err: any) {
      if (this.connectAttempts < 10) {
        // -> `warn`, since a retry may yet heal it: the `error` an operator has to act on is the
        //    throw below once the attempts run out.
        CARDINAL.logger.warn('db', 'connection failed, retrying', {
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
   * Refuses a Wiki.js 2.x database before anything is created or migrated: there is no in-place
   * upgrade, and the 3.x migrations would run over the 2.x tables and leave a database that is
   * neither version. Exits rather than throws, since no retry or later boot phase can recover.
   */
  async checkForLegacyInstall(db: WikiDb): Promise<void> {
    const res = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${CARDINAL.config.db.schema} AND table_name IN ${LEGACY_TABLES}
      LIMIT 1
    `)
    if (res.rows.length > 0) {
      CARDINAL.logger.error(
        'db',
        'refusing to boot, upgrading from a 2.x installation is unsupported',
        {
          table: res.rows[0].table_name,
          schema: CARDINAL.config.db.schema
        }
      )
      process.exit(1)
    }
  },
  /**
   * Runs entirely under `MIGRATION_LOCK_KEY`, taken off `this.pool` because `CARDINAL.db` is not
   * assigned until `init()` returns. The lock is returned still held, for the caller to release; it
   * is released here only on failure.
   */
  async syncSchemas(db: WikiDb): Promise<AdvisoryLockHandle> {
    const lock = await acquireAdvisoryLock(this.pool as Pool, MIGRATION_LOCK_KEY)
    try {
      await this.checkForLegacyInstall(db)

      await db.execute(`CREATE SCHEMA IF NOT EXISTS ${CARDINAL.config.db.schema}`)

      /*
        Here rather than in a migration: `drizzle-kit generate` diffs the schema definition against
        the previous snapshot, and an extension is part of neither, so a hand-written
        `CREATE EXTENSION` preamble survives only until somebody regenerates.

        Idempotent, so a database whose extensions an administrator installed by hand is untouched.
      */
      for (const extension of REQUIRED_EXTENSIONS) {
        await db.execute(`CREATE EXTENSION IF NOT EXISTS ${extension}`)
      }

      await migrate(db, {
        migrationsFolder: path.join(CARDINAL.SERVERPATH, 'db/migrations'),
        migrationsSchema: CARDINAL.config.db.schema,
        migrationsTable: 'migrations'
      })

      // -> Optional, unlike `REQUIRED_EXTENSIONS`: `bootstrapPgvector()` never throws, so a
      //    Postgres without pgvector (or without the privilege to install it) still boots.
      CARDINAL.capabilities = { semanticSearch: await bootstrapPgvector(db) }

      return lock
    } catch (err) {
      await lock.release()
      throw err
    }
  }
}
