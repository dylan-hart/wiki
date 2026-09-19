import { z } from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
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
 * Mirrors `GET /_api/sites/:siteId/pages/:pageIdOrHash` (`api/pages/read.ts`): `read:pages` gates the
 * page, `read:source` its raw source, and a password-protected page comes back `isLocked: true` with
 * no body unless the key holds `write:pages`/`manage:pages` on it.
 *
 * `includeSource` is best-effort: without `read:source` the call still succeeds, with
 * `sourceOmitted: true` — refusing the whole read over one field would be a worse answer for an
 * agent that mostly wants the rendered content.
 */
export async function handleGetPage(
  ctx: McpAuthContext,
  args: GetPageArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  const actor = actorFor(ctx)
  const path = normalizePagePath(args.path)

  const page = await CARDINAL.models.pages.getPage({
    siteId: site.id,
    hash: generatePathHash(path || 'home'),
    locale: args.locale,
    withContent: Boolean(args.includeSource),
    // -> Mirrors `actorFrom(req)` on the REST route: a key with no user behind it is an anonymous
    //    reader, restricted to published pages.
    publicOnly: !pageActorFor(ctx),
    // -> Whoever may write or manage the page is not stopped by its own password
    unlocked: (unlockRef) =>
      CARDINAL.models.groups.checkAccess(actor, 'write:pages', { ...unlockRef, siteId: site.id }) ||
      CARDINAL.models.groups.checkAccess(actor, 'manage:pages', { ...unlockRef, siteId: site.id }),
    withPassword: false
  })

  if (!page) {
    throw new McpToolError('This page does not exist.')
  }
  // -> Not readable is indistinguishable from not there, as in `helpers/pageAccess.ts`
  if (!CARDINAL.models.groups.checkAccess(actor, 'read:pages', { ...page, siteId: site.id })) {
    throw new McpToolError('This page does not exist.')
  }

  // -> Never awaited: `models/pageviews.ts#record()` swallows its own failures, so logging cannot
  //    break this read. `ctx.keyId` is hashed, not stored: one key is one visitor.
  void CARDINAL.models.pageviews.record({
    siteId: site.id,
    pageId: page.id,
    clientType: 'mcp',
    visitorRawId: ctx.keyId
  })

  // FIXME: unlike `helpers/pageAccess.ts#mayReadSource`, `write:pages`/`manage:pages` do not imply
  //    `read:source` here, so an editor's key is refused source the REST route returns. OR in both.
  const maySeeSource = CARDINAL.models.groups.checkAccess(actor, 'read:source', {
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
    // -> Already blanked by `getPage()` itself when `isLocked`
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
