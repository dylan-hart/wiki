/**
 * `CARDINAL` is assembled in `backend/index.ts` (and a minimal subset in `backend/worker.ts`) and is
 * reachable from every module without importing it.
 */

import type { FastifyInstance } from 'fastify'
import type Emittery from 'emittery'
import type { LRUCache } from 'lru-cache'
import type { ShutdownController } from '../core/http/shutdown.ts'

declare global {
  interface CardinalGlobal {
    IS_DEBUG: boolean
    ROOTPATH: string
    SERVERPATH: string
    INSTANCE_ID: string
    startedAt: Temporal.Instant
    version: string
    releaseDate: string
    devMode: boolean

    app: FastifyInstance
    server: ShutdownController
    cache: LRUCache<string, any>
    /**
     * HA propagation buses. Event names are dynamic (they travel over postgres NOTIFY), so the
     * event map is left open — `Record<string, any>` is also what makes dataless `emit(name)` calls
     * legal, since Emittery's default `unknown` payload forbids them.
     */
    events: {
      inbound: Emittery<Record<string, any>>
      outbound: Emittery<Record<string, any>>
    }

    auth: {
      groups: Record<string, unknown>
      strategies: Record<string, unknown>
    }

    /**
     * Boot-time feature flags for optional capabilities that depend on something outside this
     * codebase's control -- an extension the connected Postgres role may not be permitted to
     * install, say. Set once, in `core/db.ts#syncSchemas()`, and read by every consumer rather than
     * each re-probing for itself. `semanticSearch` is false when the connected role lacked privilege
     * to create the `vector` extension, or the server has no pgvector installed at all.
     *
     * Optional rather than always-present: a worker thread does not compute it, and instead reads it
     * out of piscina's `workerData` and assigns it onto its own minimal `CARDINAL` before the value
     * is ever read -- and a test `CARDINAL` stub that never sets it should read `undefined` rather
     * than throw. Every consumer reads it as `CARDINAL.capabilities?.semanticSearch`.
     */
    capabilities?: {
      semanticSearch: boolean
    }

    /**
     * Merged config.yml + base.yml defaults + the `settings` DB table. Assembled at runtime from
     * YAML and JSONB, so it stays intentionally untyped.
     */
    config: any
    /** Contents of `base.yml` — set by `configSvc.init()`, not by `index.ts`. */
    data: any

    collab: typeof import('../core/collab.ts').default
    configSvc: typeof import('../core/config.ts').default
    db: import('../core/db.ts').WikiDb
    dbManager: typeof import('../core/db.ts').default
    logger: ReturnType<typeof import('../core/logger.ts').default.init>
    scheduler: typeof import('../core/scheduler.ts').default
    models: typeof import('../models/index.ts').default

    /**
     * Cached site configs, keyed by site id -- `sitesMappings` is the hostname index onto them. Kept
     * current by `models/sites.ts`'s `reloadCache()` (a `ClusterReloaded` subclass, so every
     * instance in a cluster reloads together).
     */
    sites: Record<string, import('../db/schema.ts').SiteRow>
    sitesMappings: Record<string, string>

    /** Only present in worker threads. */
    ensureDb?: () => Promise<boolean | void>
  }

  var CARDINAL: CardinalGlobal
}
