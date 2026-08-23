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

const updatePageInputSchema = {
  pageId: z
    .string()
    .uuid()
    .describe('The page to update. See `search_pages`/`get_page` for the id.'),
  siteId: z
    .string()
    .uuid()
    .optional()
    .describe('Which site the page belongs to. Omit on a single-site instance.'),
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

function toResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/**
 * Update a page, gated exactly like `PATCH /_api/sites/:siteId/pages/:pageId` (`api/pages.ts`): a
 * personal access token only (see `pageActorFor()`'s doc comment), and `write:pages` ON THIS PAGE —
 * checked against the page as it stands, so a rule scoped to one branch is honored the same way it is
 * for the REST route.
 *
 * No `expectedUpdatedAt`/optimistic-concurrency argument: that guard exists for a human editor with a
 * stale copy open in a browser tab, which has no equivalent here — an MCP caller has no "copy it was
 * looking at" to go stale, only the read it made moments before this call.
 *
 * Same caveat as `create_page` on `content` with no accompanying render: sending it leaves the
 * previous render in place (`models/pages.ts#updatePage()`'s own documented behavior for a
 * source-only edit), which now shows stale HTML until the page is re-saved through an editor or its
 * re-render is queued.
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
    throw new McpToolError(err.message)
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
