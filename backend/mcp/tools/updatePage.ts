import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  actorFor,
  auditActorFor,
  McpToolError,
  pageActorFor,
  type McpAuthContext,
  type McpAuthContextGetter
} from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import { renderRefusalGuidance } from '../renderRefusal.ts'
import { siteIdArg, toResult } from './shared.ts'

const updatePageInputSchema = {
  pageId: z
    .string()
    .uuid()
    .describe('The page to update. See `search_pages`/`get_page` for the id.'),
  // -> No `list_sites` pointer in this one's hint: the caller already holds the page id, which is not
  //    something `list_sites` would have told them
  siteId: siteIdArg('Which site the page belongs to.', 'Omit on a single-site instance.'),
  title: z.string().min(1).optional(),
  content: z
    .string()
    .optional()
    .describe(
      'The new page source. Only the fields present in the call are touched — omit a field to leave it as-is.'
    ),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  publishState: z.enum(['draft', 'published']).optional()
}

export interface UpdatePageArgs {
  pageId: string
  siteId?: string
  title?: string
  content?: string
  description?: string
  tags?: string[]
  publishState?: 'draft' | 'published'
}

/**
 * Update a page, gated exactly like `PATCH /_api/sites/:siteId/pages/:pageId` (`api/pages/write.ts`): a
 * personal access token only (see `pageActorFor()`'s doc comment), and `write:pages` ON THIS PAGE —
 * checked against the page as it stands, so a rule scoped to one branch is honored the same way it is
 * for the REST route.
 *
 * No `expectedUpdatedAt`/optimistic-concurrency argument: that guard exists for a human editor with a
 * stale copy open in a browser tab, which has no equivalent here — an MCP caller has no "copy it was
 * looking at" to go stale, only the read it made moments before this call.
 *
 * `content` with no accompanying render is exactly what `models/pages.ts#updatePage()` itself now
 * handles (OpenProject #1716): it confirms up front that this instance can actually render the page,
 * then queues the same headless-browser render a stale stored page's re-render would get.
 */
export async function handleUpdatePage(
  ctx: McpAuthContext,
  args: UpdatePageArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  const actor = pageActorFor(ctx)
  if (!actor) {
    throw new McpToolError(
      'Updating a page requires a personal access token — an admin-issued key has no user to attribute the edit to.'
    )
  }

  const target = await WIKI.models.pages.getPage({ siteId: site.id, id: args.pageId })
  if (!target) {
    throw new McpToolError('This page does not exist.')
  }
  if (
    !WIKI.models.groups.checkAccess(actorFor(ctx), 'write:pages', { ...target, siteId: site.id })
  ) {
    throw new McpToolError('You are not allowed to edit this page.')
  }

  let page
  try {
    page = await WIKI.models.pages.updatePage(
      site.id,
      args.pageId,
      {
        title: args.title,
        content: args.content,
        description: args.description,
        tags: args.tags,
        publishState: args.publishState
      },
      actor
    )
  } catch (err: any) {
    throw new McpToolError(renderRefusalGuidance(err) ?? err.message)
  }
  if (!page) {
    throw new McpToolError('This page does not exist.')
  }

  // -> #1118: same reasoning as `createPage.ts`'s own instrumentation -- instance-wide visibility that
  //   an agent wrote this, separate from `pageHistory`'s own per-page attribution (#1119).
  await WIKI.models.auditLog.record({
    event: 'mcp.writeToolCalled',
    actor: auditActorFor(ctx),
    targetType: 'page',
    targetId: page.id,
    targetLabel: page.path,
    detail: { tool: 'update_page' },
    siteId: site.id
  })

  return toResult({
    id: page.id,
    path: page.path,
    locale: page.locale,
    title: page.title,
    publishState: page.publishState,
    updatedAt: page.updatedAt
  })
}

export function registerUpdatePageTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'update_page',
    {
      description:
        'Update an existing wiki page. Accepts any subset of the fields; omitted ones are left unchanged. Requires a personal access token and `write:pages` on the page.',
      inputSchema: updatePageInputSchema
    },
    (args) => handleUpdatePage(getCtx(), args)
  )
}
