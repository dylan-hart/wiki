/**
 * Minimal boot sequence for the MCP server process (`mcp/stdio.ts`).
 *
 * Modeled on `migration/bootstrap.ts` (itself modeled on `worker.ts`'s minimal `WIKI` global): no HTTP
 * server, no scheduler, no cache, no collab websockets, no rate limiter — just enough of `WIKI` for the
 * handful of models an MCP tool call actually reads through. A one-shot/long-lived side process pays
 * the import cost of everything it pulls in, and the full `models/index.ts` registry drags in cheerio,
 * sanitize-html, bcrypt and the rest of the HTTP-server-only models for a process that never serves a
 * request.
 *
 * The MCP process is a separate OS process from `node backend` (the stdio transport requires exclusive
 * use of its own stdin/stdout, so it cannot share a process with a chatty Fastify server logging to the
 * same stream) but it is not a standalone *service*: it lives in this same `backend/` workspace, reuses
 * the exact same models, schema and database as the main app, and is deployed as part of the same
 * package — the distinction the work package's "registered alongside the existing Fastify app" guidance
 * is actually drawing (see `mcp/stdio.ts`'s doc comment for the fuller reasoning, and
 * `docs/variances.md` for the HTTP/SSE transport that WOULD run inside the Fastify process).
 */

import path from 'node:path'
import configSvc from '../core/config.ts'
import dbManager from '../core/db.ts'
import logger from '../core/logger.ts'

/**
 * Only the models an MCP tool call reads through today: `sites` (site lookup/scoping), `groups`
 * (page-rule permission checks), `apiKeys` (bearer token verification), `search`, `tree` and `pages`
 * (the read surface itself), plus `settings` — not touched by any tool directly, but read by
 * `configSvc.loadFromDb()` below. Extend this list alongside `mcp/tools/` as new tools are added —
 * never import the full registry here, for the reason in the file-level doc comment above.
 */
async function loadModels(): Promise<WikiGlobal['models']> {
  const [{ sites }, { groups }, { apiKeys }, { search }, { tree }, { pages }, { settings }] =
    await Promise.all([
      import('../models/sites.ts'),
      import('../models/groups.ts'),
      import('../models/apiKeys.ts'),
      import('../models/search.ts'),
      import('../models/tree.ts'),
      import('../models/pages.ts'),
      // -> `configSvc.loadFromDb()` below reads `WIKI.models.settings.getConfig()` directly
      import('../models/settings.ts')
    ])
  return { sites, groups, apiKeys, search, tree, pages, settings } as WikiGlobal['models']
}

/**
 * Sets up the ambient `WIKI` global and connects it to the database, mirroring `index.ts`'s
 * `preBoot()` for exactly the subset an MCP tool call needs: settings (for `auth.certs` and
 * `api.isEnabled`, which `apiKeys.verify()` reads), the sites cache (`WIKI.sites`, read by every
 * tool for site lookup/scoping) and the group page-rules cache (`WIKI.models.groups.checkAccess()`,
 * the permission check every read tool applies to its results).
 *
 * `instanceId` distinguishes this process in logs (`mcp-stdio`) the same way `migrate-cli` /
 * `verify-migration-cli` do for the migration CLI.
 */
export async function bootstrapMcpRuntime(instanceId: string): Promise<WikiGlobal> {
  const WIKI = {
    IS_DEBUG: process.env.NODE_ENV === 'development',
    ROOTPATH: process.cwd(),
    INSTANCE_ID: instanceId,
    SERVERPATH: path.join(process.cwd(), 'backend'),
    configSvc
  } as unknown as WikiGlobal
  global.WIKI = WIKI

  // -> `silent: true` — the stdio transport (`mcp/stdio.ts`) needs stdout free for JSON-RPC frames
  //    only; `configSvc.init()`'s own error path still writes to stderr via `console.error`, which is
  //    safe regardless of transport
  await WIKI.configSvc.init(true)
  WIKI.logger = logger.init()

  WIKI.dbManager = dbManager
  WIKI.db = await dbManager.init()
  WIKI.models = await loadModels()

  if (!(await WIKI.configSvc.loadFromDb())) {
    throw new Error(
      'No settings found in the database. Run the main Wiki.js server at least once before starting the MCP server.'
    )
  }

  await WIKI.models.sites.reloadCache()
  await WIKI.models.groups.reloadCache()

  return WIKI
}
