import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { RENDER_LIMIT } from '../../helpers/rateLimit.ts'
import { McpToolError, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'

const renderDiagramInputSchema = {
  type: z.enum(['mermaid', 'plantuml']).describe('Which diagram language `source` is written in.'),
  source: z
    .string()
    .min(1)
    .describe(
      'The diagram source, exactly as it would appear inside a ```mermaid or ```plantuml fence.'
    ),
  format: z
    .enum(['svg', 'png'])
    .optional()
    .describe('The image format to return. `svg` when omitted.'),
  theme: z
    .string()
    .optional()
    .describe(
      'Mermaid only. One of `default`, `dark`, `neutral`, `forest`; anything else (including `auto`, which needs a reader to follow) falls back to `default`.'
    ),
  server: z
    .string()
    .optional()
    .describe(
      'PlantUML only. A PlantUML server to render against; the public plantuml.com server when omitted.'
    )
}

export interface RenderDiagramArgs {
  type: 'mermaid' | 'plantuml'
  source: string
  format?: 'svg' | 'png'
  theme?: string
  server?: string
}

/**
 * Rate-limit key for a diagram render, mirroring `helpers/rateLimit.ts#limitRenders`'s own
 * `req.session?.user?.id ?? req.ip` shape: a personal access token shares its owner's budget with
 * anything they render through the web UI in the same window, while an admin-issued key (no
 * `userId`) gets its own bucket keyed by the key itself, since an MCP call has no `req.ip` to fall
 * back to.
 */
function renderLimitKey(ctx: McpAuthContext): string {
  return `render:${ctx.userId ?? `mcp:${ctx.keyId}`}`
}

/**
 * Draw a Mermaid or PlantUML diagram to a static SVG/PNG, for an agent that wants the image rather
 * than the fenced source — mirrors `POST /_api/diagrams/render` (`api/diagrams.ts`) exactly, right
 * down to delegating to the same `WIKI.models.diagramRender.render()` and applying the same
 * {@link RENDER_LIMIT} the REST route's `limitRenders` preHandler enforces (see {@link renderLimitKey}
 * for how the two share it). `manage:system` is exempt, same as the REST route.
 *
 * Any `CustomError` `diagramRender.render()` throws (missing-Puppeteer, offline PlantUML, a source
 * over the size cap, an empty source, or a diagram that failed to draw) carries a message written for
 * exactly this — see the model's own throw sites — so it is rethrown as-is via `McpToolError`, the
 * same one-line mapping `createPage.ts`/`updatePage.ts` use for a model validation failure.
 */
export async function handleRenderDiagram(
  ctx: McpAuthContext,
  args: RenderDiagramArgs
): Promise<CallToolResult> {
  if (!ctx.permissions.includes('manage:system')) {
    const verdict = await WIKI.models.rateLimits.consume(renderLimitKey(ctx), RENDER_LIMIT)
    if (!verdict.allowed) {
      throw new McpToolError(
        `Too many render requests. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
      )
    }
  }

  let result
  try {
    result = await WIKI.models.diagramRender.render({
      type: args.type,
      source: args.source,
      theme: args.theme,
      format: args.format,
      server: args.server
    })
  } catch (err: any) {
    throw new McpToolError(err.message)
  }

  return {
    content: [
      {
        type: 'image',
        data: result.data.toString('base64'),
        mimeType: result.contentType
      }
    ]
  }
}

export function registerRenderDiagramTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'render_diagram',
    {
      description:
        'Render a Mermaid or PlantUML diagram to a static SVG/PNG image, server-side. Mermaid needs the Puppeteer extension installed on this instance; PlantUML needs the instance to be online. Rate-limited the same as the web UI’s own diagram export.',
      inputSchema: renderDiagramInputSchema
    },
    (args) => handleRenderDiagram(getCtx(), args)
  )
}
