/**
 * Ambient declarations for the `WIKI` global singleton.
 *
 * `WIKI` is assembled in `backend/index.ts` (and a minimal subset in `backend/worker.ts`) and is
 * reachable from every module without importing it. Members that come from typed dependencies are
 * typed properly here; the ones backed by our own not-yet-converted modules are left loose and
 * should be replaced with `typeof import('...')` as each module moves to TypeScript.
 */

import type { FastifyInstance } from 'fastify'
import type gracefulServer from '@gquittet/graceful-server'
import type Emittery from 'emittery'
import type { LRUCache } from 'lru-cache'

declare global {
  interface WikiGlobal {
    IS_DEBUG: boolean
    ROOTPATH: string
    SERVERPATH: string
    INSTANCE_ID: string
    startedAt: Temporal.Instant
    version: string
    releaseDate: string
    devMode: boolean

    app: FastifyInstance
    server: ReturnType<typeof gracefulServer>
    cache: LRUCache<string, any>
    /**
     * HA propagation buses. Event names are dynamic (they travel over postgres NOTIFY), so the
     * event map is left open — `Record<string, any>` is also what makes dataless `emit(name)`
     * calls legal, since Emittery's default `unknown` payload forbids them.
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
     * install, say. Set once, in `core/db.ts#syncSchemas()` (which calls
     * `core/pgvectorBootstrap.ts#bootstrapPgvector()`), and read by every consumer rather than each
     * re-probing for itself.
     *
     * `semanticSearch` (Task #3095) is true once `bootstrapPgvector()` has successfully created the
     * `vector` extension, the `pageEmbeddingChunks` table and its HNSW index at boot -- false when
     * the connected role lacked privilege to create the extension, or the Postgres server has no
     * pgvector installed at all. Every Feature under Epic #3050 (local embedding pipeline / semantic
     * search) reads this rather than re-probing.
     *
     * Optional here (rather than always-present): `worker.ts`'s minimal `WIKI` never sets it (a
     * worker thread never calls `syncSchemas()`), and a test `WIKI` stub that never sets it should
     * read `undefined` rather than throw. Every consumer reads it as `WIKI.capabilities?.semanticSearch`.
     */
    capabilities?: {
      semanticSearch: boolean
    }

    /**
     * Merged config.yml + base.yml defaults + the `settings` DB table. Assembled at runtime from
     * YAML and JSONB, so it stays intentionally untyped.
     */
    config: any
    /** Contents of `base.yml` — set by configSvc.init(), not by index.ts */
    data: any

    collab: typeof import('../core/collab.ts').default
    configSvc: typeof import('../core/config.ts').default
    db: import('../core/db.ts').WikiDb
    dbManager: typeof import('../core/db.ts').default
    logger: ReturnType<typeof import('../core/logger.ts').default.init>
    scheduler: typeof import('../core/scheduler.ts').default
    models: typeof import('../models/index.ts').default

    // TODO: type this against `sites`' Drizzle row type (backend/db/schema.ts) instead of `any` --
    // the table has been a real Drizzle table for a while now, this just hasn't been tightened up
    sites: Record<string, any>
    sitesMappings: Record<string, string>

    /** Only present in worker threads (see worker.ts) */
    ensureDb?: () => Promise<boolean | void>
  }

  var WIKI: WikiGlobal
}
