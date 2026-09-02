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
import { defaultLocale } from '../../helpers/localeRouting.ts'
import { resolveRequestedSite } from '../site.ts'
import { renderRefusalGuidance } from '../renderRefusal.ts'
import { localeArg, siteIdArg, toResult } from './shared.ts'

const createPageInputSchema = {
  path: z.string().min(1).describe('Where to create the page, as a slash-separated path.'),
  title: z.string().min(1).describe('The page title.'),
  content: z
    .string()
    .min(1)
    .describe('The page source, in whatever format `editor` names (markdown by default).'),
  siteId: siteIdArg('Which site to create the page on.'),
  locale: localeArg,
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

/**
 * Create a page, gated exactly like `POST /_api/sites/:siteId/pages` (`api/pages/write.ts`): a personal
 * access token only (see `pageActorFor()`'s doc comment for why an admin-issued key is refused), and
 * `write:pages` on the path being created.
 *
 * `render` is never sent to `models/pages.ts#createPage()` — the frontend markdown pipeline that
 * produces it does not run here (see `models/rendering.ts`'s own doc comment). `createPage()` itself
 * covers that gap (OpenProject #1716): it confirms up front that this instance can actually render the
 * page, then queues the same headless-browser render a stale stored page's re-render would get.
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
  // -> Resolved once and reused for both the permission check below and the actual write, so they can
  //    never land on different locales — `||`, not `??`, to mirror `models/pages.ts#createPage()`'s own
  //    `input.locale || defaultLocale(siteId)` fallback exactly: an empty-string `locale` argument is
  //    "unset" there too, not a locale of its own.
  const locale = args.locale || defaultLocale(site.id)
  if (
    !WIKI.models.groups.checkAccess(actorFor(ctx), 'write:pages', {
      path: args.path,
      locale,
      siteId: site.id,
      // -> The page does not exist yet -- there is no classification to check against, same as any
      //    other create-permission check (see `RulePageRef`'s own doc comment).
      classification: null
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
        locale,
        description: args.description,
        tags: args.tags,
        publishState: args.publishState ?? 'published'
      },
      actor
    )
  } catch (err: any) {
    throw new McpToolError(renderRefusalGuidance(err) ?? err.message)
  }

  // -> #1118: instance-wide visibility that an agent wrote this, separate from the page's own
  //   `pageHistory` attribution (#1119) -- see `models/auditLog.ts`'s `AUDIT_EVENTS` doc comment for
  //   why only the write tools log here, not every read.
  await WIKI.models.auditLog.record({
    event: 'mcp.writeToolCalled',
    actor: auditActorFor(ctx),
    targetType: 'page',
    targetId: page.id,
    targetLabel: page.path,
    detail: { tool: 'create_page' },
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

export function registerCreatePageTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'create_page',
    {
      description:
        'Create a new wiki page from source content. Requires a personal access token — the page is attributed to its owner — and `write:pages` on the target path. Refused if a page already exists there.',
      inputSchema: createPageInputSchema
    },
    (args) => handleCreatePage(getCtx(), args)
  )
}
