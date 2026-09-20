import { z } from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
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
 * Gated like `PATCH /_api/sites/:siteId/pages/:pageId` (`api/pages/write.ts`): a personal access token
 * only (see `pageActorFor()`), and `write:pages` on the page as it stands.
 *
 * No `expectedUpdatedAt`/optimistic-concurrency argument: that guard is for a human editor with a
 * stale copy open in a browser tab, which an MCP caller has no equivalent of.
 *
 * No `render` is sent with changed `content`: `models/pages.ts#updatePage()` confirms this instance
 * can render the page and queues a headless-browser render itself.
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

  const target = await CARDINAL.models.pages.getPage({ siteId: site.id, id: args.pageId })
  if (!target) {
    throw new McpToolError('This page does not exist.')
  }
  if (
    !CARDINAL.models.groups.checkAccess(actorFor(ctx), 'write:pages', {
      ...target,
      siteId: site.id
    })
  ) {
    throw new McpToolError('You are not allowed to edit this page.')
  }

  let page
  try {
    page = await CARDINAL.models.pages.updatePage(
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

  await CARDINAL.models.auditLog.record({
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
