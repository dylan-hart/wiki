import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { actorFor, McpToolError, pageActorFor, type McpAuthContext } from '../auth.ts'
import { defaultLocale, resolveRequestedSite } from '../site.ts'

const createPageInputSchema = {
  path: z.string().min(1).describe('Where to create the page, as a slash-separated path.'),
  title: z.string().min(1).describe('The page title.'),
  content: z
    .string()
    .min(1)
    .describe(
      "The page source, in whatever format `editor` names (markdown by default). This is stored as-is — there is no HTML render pipeline reachable from here, so the page's rendered view is blank until it is opened and saved once in the editor."
    ),
  siteId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Which site to create the page on. Omit on a single-site instance; see `list_sites` otherwise.'
    ),
  locale: z.string().optional().describe("The site's primary locale when omitted."),
  editor: z
    .string()
    .optional()
    .describe('The editor/format `content` is written in. `markdown` when omitted.'),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  publishState: z
    .enum(['draft', 'published'])
    .optional()
    .describe('Published immediately (the default) or saved as a draft.')
}

export interface CreatePageArgs {
  path: string
  title: string
  content: string
  siteId?: string
  locale?: string
  editor?: string
  description?: string
  tags?: string[]
  publishState?: 'draft' | 'published'
}

function toResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/**
 * Create a page, gated exactly like `POST /_api/sites/:siteId/pages` (`api/pages.ts`): a personal
 * access token only (see `pageActorFor()`'s doc comment for why an admin-issued key is refused), and
 * `write:pages` on the path being created.
 *
 * `render` is never sent to `models/pages.ts#createPage()` — the frontend markdown pipeline that
 * produces it does not run here (see `models/rendering.ts`'s own doc comment), so a page saved through
 * this tool has no rendered HTML until an editor opens and re-saves it, or an administrator queues a
 * re-render (`POST …/pages/:pageId/render`). Documented on the tool description, not hidden.
 */
export async function handleCreatePage(
  ctx: McpAuthContext,
  args: CreatePageArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  const actor = pageActorFor(ctx)
  if (!actor) {
    throw new McpToolError(
      'Creating a page requires a personal access token — an admin-issued key has no user to attribute the page to.'
    )
  }
  const locale = args.locale ?? defaultLocale(site)
  if (
    !WIKI.models.groups.checkAccess(actorFor(ctx), 'write:pages', {
      path: args.path,
      locale,
      siteId: site.id
    })
  ) {
    throw new McpToolError('You are not allowed to create a page here.')
  }

  let page
  try {
    page = await WIKI.models.pages.createPage(
      site.id,
      {
        path: args.path,
        title: args.title,
        editor: args.editor ?? 'markdown',
        content: args.content,
        locale: args.locale,
        description: args.description,
        tags: args.tags,
        publishState: args.publishState ?? 'published'
      },
      actor
    )
  } catch (err: any) {
    throw new McpToolError(err.message)
  }

  return toResult({
    id: page.id,
    path: page.path,
    locale: page.locale,
    title: page.title,
    publishState: page.publishState,
    updatedAt: page.updatedAt
  })
}

export function registerCreatePageTool(server: McpServer, ctx: McpAuthContext): void {
  server.registerTool(
    'create_page',
    {
      description:
        'Create a new wiki page from source content. Requires a personal access token — the page is attributed to its owner — and `write:pages` on the target path. Refused if a page already exists there.',
      inputSchema: createPageInputSchema
    },
    (args) => handleCreatePage(ctx, args)
  )
}
