import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { generatePathHash, normalizePagePath } from '../../helpers/common.ts'
import {
  actorFor,
  McpToolError,
  pageActorFor,
  type McpAuthContext,
  type McpAuthContextGetter
} from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import { localeArg, siteIdArg, toResult } from './shared.ts'

const getPageInputSchema = {
  path: z.string().describe('Slash-separated path of the page to read. The home page when empty.'),
  siteId: siteIdArg('Which site to read from.'),
  locale: localeArg,
  includeSource: z
    .boolean()
    .optional()
    .describe('Also return the page source (markdown/etc.), not just its rendered HTML.')
}

export interface GetPageArgs {
  path: string
  siteId?: string
  locale?: string
  includeSource?: boolean
}

/**
 * Read a single page by path, restricted to what the configured key may actually read. Mirrors
 * `GET /_api/sites/:siteId/pages/:pageIdOrHash` (`api/pages.ts`): `read:pages` gates the page at all,
 * `read:source` gates the raw source on top of that, a password-protected page comes back with
 * `isLocked: true` and no body unless the key holds `write:pages`/`manage:pages` on it, and
 * `publicOnly` is derived from `pageActorFor(ctx)` exactly as the REST route derives it from
 * `actorFrom(req)` (`helpers/pageAccess.ts`) — an admin-issued key (no `ctx.userId`) is therefore a
 * `publicOnly` reader over MCP too, not a full-publish-state one; see `pageActorFor()`'s doc comment
 * for why that mirrors `actorFrom()` deliberately.
 *

 * `includeSource` is honored best-effort: asked for without `read:source` on the page, the call still
 * succeeds and returns everything else, with `sourceOmitted: true` explaining why — refusing the whole
 * read over a permission gap on one field it didn't strictly need would be a worse answer for an agent
 * that mostly wants the rendered content.
 */
export async function handleGetPage(
  ctx: McpAuthContext,
  args: GetPageArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  const actor = actorFor(ctx)
  const path = normalizePagePath(args.path)

  const page = await WIKI.models.pages.getPage({
    siteId: site.id,
    hash: generatePathHash(path || 'home'),
    locale: args.locale,
    withContent: Boolean(args.includeSource),
    // -> Mirrors `actorFrom(req)` on the REST route: no attributable user behind the key means an
    //    anonymous reader, restricted to published pages, on both transports alike.
    publicOnly: !pageActorFor(ctx),
    // -> Whoever may write or manage the page is not stopped by its own password
    unlocked: (unlockRef) =>
      WIKI.models.groups.checkAccess(actor, 'write:pages', { ...unlockRef, siteId: site.id }) ||
      WIKI.models.groups.checkAccess(actor, 'manage:pages', { ...unlockRef, siteId: site.id }),
    withPassword: false
  })

  if (!page) {
    throw new McpToolError('This page does not exist.')
  }
  // -> Not readable is indistinguishable from not there, same as `loadReadablePage()` in
  //    `helpers/pageAccess.ts`
  if (!WIKI.models.groups.checkAccess(actor, 'read:pages', { ...page, siteId: site.id })) {
    throw new McpToolError('This page does not exist.')
  }

  // -> Best-effort, never awaited: `models/pageviews.ts#record()` swallows its own failures and
  //    no-ops entirely under the admin opt-out, so a logging failure can never break this read.
  //    `ctx.keyId` is hashed rather than stored -- the same convention `api/pages.ts`'s
  //    `recordPageview()` uses for a bearer-key REST caller, and for the same reason: two different
  //    keys are two different visitors, the same key reused is one. This is the `mcp` counterpart to
  //    that route's `api`/`browser` split (OpenProject #1140's "web browser vs. API/MCP access").
  void WIKI.models.pageviews.record({
    siteId: site.id,
    pageId: page.id,
    clientType: 'mcp',
    visitorRawId: ctx.keyId
  })

  const maySeeSource = WIKI.models.groups.checkAccess(actor, 'read:source', {
    ...page,
    siteId: site.id
  })
  const includeSource = Boolean(args.includeSource) && !page.isLocked && maySeeSource

  return toResult({
    id: page.id,
    path: page.path,
    locale: page.locale,
    title: page.title,
    description: page.description,
    icon: page.icon,
    tags: page.tags,
    publishState: page.publishState,
    isLocked: page.isLocked,
    updatedAt: page.updatedAt,
    // -> Already withheld by `getPage()` itself when `isLocked` (see `toPage()`'s `locked` handling)
    render: page.render,
    content: includeSource ? page.content : undefined,
    sourceOmitted: Boolean(args.includeSource) && !includeSource
  })
}

export function registerGetPageTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'get_page',
    {
      description:
        'Read a single wiki page by path: its rendered content plus metadata, and optionally its raw source.',
      inputSchema: getPageInputSchema
    },
    (args) => handleGetPage(getCtx(), args)
  )
}
