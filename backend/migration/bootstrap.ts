/**
 * Shared boot sequence for every standalone migration-CLI entry point under `../tasks/` —
 * `migrate.ts` (the import) and `verify-migration.ts` (Feature 421 task 748's post-import
 * verification). Both need the exact same minimal runtime and nothing else: modeled on `worker.ts`'s
 * minimal `WIKI` global, not `index.ts`'s full boot — no HTTP server, no scheduler, no real cache
 * backend, no collab websockets, just enough to talk to the 3.0 destination database and run the
 * model methods each script needs. `WIKI.events`/`WIKI.cache` are still populated, with no-op stubs
 * (see `createEventsStub()`/`createCacheStub()` below) rather than left undefined, because the
 * models this bootstrap loads unconditionally reach for both on their normal write paths.
 *
 * Extracted out of `migrate.ts` (which originally inlined this) so `verify-migration.ts` does not
 * have to duplicate it — see task 748's own description, "sharing the harness's bootstrap".
 */

import path from 'node:path'
import configSvc from '../core/config.ts'
import dbManager from '../core/db.ts'
import logger from '../core/logger.ts'
import { ExportBundleSourceConnector } from './connectors/export-bundle.ts'
import { PostgresSourceConnector } from './connectors/postgres.ts'
import type { ParsedSource } from './source-args.ts'
import type { SourceConnector } from './connector.ts'

/**
 * Only the models an import/verify phase actually reads/writes through, never the full 27-model
 * registry `models/index.ts` exports. Same principle `worker.ts` follows for its one model: a
 * one-shot process pays the import cost of everything it pulls in, and the full registry drags in
 * cheerio, sanitize-html, bcrypt and the rest of the HTTP-server-only models for a script that never
 * serves a request.
 *
 * This set is sized against the model calls the built importers actually make, not just the ones
 * they call directly:
 * - `sites`, `settings`, `users`, `groups`, `authentication`, `storage`, `tags`, `tree`, `pages`,
 *   `pageHistory`, `assets` — called directly by `importers/users-groups.ts` and `page-import.ts`.
 * - `locales`, `rendering`, `search`, `hooks`, `flags`, `classificationLevels` — reached
 *   transitively via `WIKI.models.pages.createPage()` (`models/pages.ts:681,688,697,728,766,825,
 *   918,919,927`), the only page write path an importer calls today.
 * - `navigation` — called directly by `navigation-import.ts` (`WIKI.models.navigation.ensureSiteNav`
 *   et al.).
 *
 * `glossary` is deliberately NOT included: it is only reached through `pages.ts`'s `updatePage`/
 * `movePage`/`deletePage`, and no importer built so far calls any of those. Add it here the moment
 * one does — a call through an unloaded model throws `TypeError: Cannot read properties of
 * undefined`, not a type error, since `types/global.d.ts` types `WIKI.models` as fully populated.
 */
export async function loadModels(): Promise<WikiGlobal['models']> {
  const [
    { sites },
    { settings },
    { users },
    { groups },
    { authentication },
    { storage },
    { tags },
    { tree },
    { pages },
    { pageHistory },
    { assets },
    { locales },
    { rendering },
    { search },
    { hooks },
    { flags },
    { classificationLevels },
    { navigation }
  ] = await Promise.all([
    import('../models/sites.ts'),
    import('../models/settings.ts'),
    import('../models/users.ts'),
    import('../models/groups.ts'),
    import('../models/authentication.ts'),
    import('../models/storage.ts'),
    import('../models/tags.ts'),
    import('../models/tree.ts'),
    import('../models/pages.ts'),
    import('../models/pageHistory.ts'),
    import('../models/assets.ts'),
    import('../models/locales.ts'),
    import('../models/rendering.ts'),
    import('../models/search.ts'),
    import('../models/hooks.ts'),
    import('../models/flags.ts'),
    import('../models/classificationLevels.ts'),
    import('../models/navigation.ts')
  ])
  return {
    sites,
    settings,
    users,
    groups,
    authentication,
    storage,
    tags,
    tree,
    pages,
    pageHistory,
    assets,
    locales,
    rendering,
    search,
    hooks,
    flags,
    classificationLevels,
    navigation
  } as WikiGlobal['models']
}

/**
 * No-op `WIKI.events` stub: a one-shot CLI process has no cluster to broadcast an HA propagation
 * event to, but write paths that unconditionally call `WIKI.events.outbound.emit(...)`
 * (`models/groups.ts#broadcastReload`, for one) need the member to exist. Shaped like
 * `backend/test/mocks.ts#createEventsStub()`.
 */
export function createEventsStub(): WikiGlobal['events'] {
  const bus = () => ({
    emit: async () => {},
    on: () => {},
    onAny: () => {},
    offAny: () => {},
    clearListeners: () => {}
  })
  return { inbound: bus(), outbound: bus() } as unknown as WikiGlobal['events']
}

/**
 * No-op `WIKI.cache` stub: nothing in a one-shot CLI process benefits from a request-scoped cache,
 * but write paths that unconditionally touch `WIKI.cache` need the member to exist. Shaped like
 * `backend/test/mocks.ts#createCacheStub()`.
 */
export function createCacheStub(): WikiGlobal['cache'] {
  const store = new Map<string, unknown>()
  const stub = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value)
      return stub
    },
    has: (key: string) => store.has(key),
    delete: (key: string) => store.delete(key),
    getRemainingTTL: () => 0,
    clear: () => store.clear()
  }
  return stub as unknown as WikiGlobal['cache']
}

/**
 * Sets up the ambient `WIKI` global and connects it to the 3.0 destination database: `configSvc`,
 * `logger`, then `dbManager.init()` (with `workerMode` defaulting to `false`, so this legitimately
 * runs `syncSchemas()` -> `checkForLegacyInstall()` + migrations against the 3.0 destination, same as
 * `index.ts`'s `preBoot()` — the *destination* must be a current 3.0 schema, so refusing a 2.x-shaped
 * one is exactly the right check here), then the narrow model subset above.
 *
 * `instanceId` distinguishes entry points in logs (`migrate-cli` vs. `verify-migration-cli`) without
 * either needing to know about the other.
 */
export async function bootstrapMigrationRuntime(instanceId: string): Promise<WikiGlobal> {
  const WIKI = {
    IS_DEBUG: process.env.NODE_ENV === 'development',
    ROOTPATH: process.cwd(),
    INSTANCE_ID: instanceId,
    SERVERPATH: path.join(process.cwd(), 'backend'),
    configSvc
  } as unknown as WikiGlobal
  global.WIKI = WIKI

  await WIKI.configSvc.init()
  WIKI.logger = logger.init()

  WIKI.dbManager = dbManager
  WIKI.db = await dbManager.init()
  WIKI.models = await loadModels()
  WIKI.events = createEventsStub()
  WIKI.cache = createCacheStub()

  return WIKI
}

/** Builds the configured `SourceConnector` (never connected yet — the caller still owns `connect()`/
 * `disconnect()`), shared between `migrate.ts` and `verify-migration.ts` so both open the exact same
 * kind of connection to the exact same source for their respective purposes. */
export function buildSourceConnector(source: ParsedSource): SourceConnector {
  return source.kind === 'postgres'
    ? new PostgresSourceConnector(source.config)
    : new ExportBundleSourceConnector(source.path)
}
