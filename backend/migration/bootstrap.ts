/**
 * Shared boot sequence for every standalone migration-CLI entry point under `../tasks/` —
 * `migrate.ts` (the import) and `verify-migration.ts` (Feature 421 task 748's post-import
 * verification). Both need the exact same minimal runtime and nothing else: modeled on `worker.ts`'s
 * minimal `WIKI` global, not `index.ts`'s full boot — no HTTP server, no scheduler, no cache, no
 * collab websockets, just enough to talk to the 3.0 destination database and run the model methods
 * each script needs.
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
 * Only the models an import/verify phase actually reads/writes through — `sites`, `settings`,
 * `users`, `groups`, `authentication`, `storage`, `tags`, `tree`, `pages`, `pageHistory`, `assets` —
 * never the full 27-model registry `models/index.ts` exports. Same principle `worker.ts` follows for
 * its one model: a one-shot process pays the import cost of everything it pulls in, and the full
 * registry drags in cheerio, sanitize-html, bcrypt and the rest of the HTTP-server-only models for a
 * script that never serves a request.
 */
async function loadModels(): Promise<WikiGlobal['models']> {
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
    { assets }
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
    import('../models/assets.ts')
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
    assets
  } as WikiGlobal['models']
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
