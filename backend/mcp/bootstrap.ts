/**
 * Minimal boot for the stdio MCP process (`mcp/stdio.ts`), modeled on `migration/bootstrap.ts`: no
 * HTTP server, scheduler, cache or collab. The full `models/index.ts` registry would drag in
 * cheerio, sanitize-html, bcrypt and other HTTP-only weight for a process that never serves a
 * request. `mcp/http.ts` runs inside the Fastify process and needs none of this.
 */

import path from 'node:path'
import configSvc from '../core/config.ts'
import dbManager from '../core/db.ts'
import logger from '../core/logger.ts'

/**
 * Only the models a tool call reaches -- extend alongside `mcp/tools/`, never import the full
 * registry. `pageHistory` and `auditLog` are not optional: every `models/pages.ts` write records
 * history, and `mcp/stdio.ts` audit-logs at session start, so omitting either throws on `undefined`.
 */
async function loadModels(): Promise<CardinalGlobal['models']> {
  const [
    { sites },
    { groups },
    { apiKeys },
    { search },
    { tree },
    { pages },
    { pageHistory },
    { auditLog },
    { settings }
  ] = await Promise.all([
    import('../models/sites.ts'),
    import('../models/groups.ts'),
    import('../models/apiKeys.ts'),
    import('../models/search.ts'),
    import('../models/tree.ts'),
    import('../models/pages.ts'),
    import('../models/pageHistory.ts'),
    import('../models/auditLog.ts'),
    // -> No tool touches it; `configSvc.loadFromDb()` below reads it
    import('../models/settings.ts')
  ])
  return {
    sites,
    groups,
    apiKeys,
    search,
    tree,
    pages,
    pageHistory,
    auditLog,
    settings
  } as CardinalGlobal['models']
}

/**
 * `index.ts`'s `preBoot()` cut down to what a tool call needs: db settings (`apiKeys.verify()` reads
 * `auth.certs` and `api.isEnabled`), the sites cache and the group rules cache.
 */
export async function bootstrapMcpRuntime(instanceId: string): Promise<CardinalGlobal> {
  const CARDINAL = {
    IS_DEBUG: process.env.NODE_ENV === 'development',
    ROOTPATH: process.cwd(),
    INSTANCE_ID: instanceId,
    SERVERPATH: path.join(process.cwd(), 'backend'),
    configSvc
  } as unknown as CardinalGlobal
  global.CARDINAL = CARDINAL

  // -> `silent: true` — the stdio transport needs stdout free for JSON-RPC frames only;
  //    `configSvc.init()`'s error path writes to stderr, which is safe
  await CARDINAL.configSvc.init(true)
  CARDINAL.logger = logger.init()

  CARDINAL.dbManager = dbManager
  CARDINAL.db = await dbManager.init()
  CARDINAL.models = await loadModels()

  if (!(await CARDINAL.configSvc.loadFromDb())) {
    throw new Error(
      'No settings found in the database. Run the main Cardinal.js server at least once before starting the MCP server.'
    )
  }

  await CARDINAL.models.sites.reloadCache()
  await CARDINAL.models.groups.reloadCache()

  return CARDINAL
}
