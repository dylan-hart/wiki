import { z } from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
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
    )
}

export interface RenderDiagramArgs {
  type: 'mermaid' | 'plantuml'
  source: string
  format?: 'svg' | 'png'
  theme?: string
}

/**
 * Mirrors `helpers/rateLimit.ts#limitRenders`'s `req.session?.user?.id ?? req.ip` key: a personal
 * access token shares its owner's budget with the web UI, while an admin-issued key gets a bucket
 * keyed by the key itself, an MCP call having no `req.ip` to fall back to.
 */
function renderLimitKey(ctx: McpAuthContext): string {
  return `render:${ctx.userId ?? `mcp:${ctx.keyId}`}`
}

/**
 * Mirrors `POST /_api/diagrams/render` (`api/diagrams.ts`): the same
 * `CARDINAL.models.diagramRender.render()`, the same {@link RENDER_LIMIT}, `manage:system` exempt.
 * The model's own errors are already worded for a caller, so they are rethrown verbatim.
 */
export async function handleRenderDiagram(
  ctx: McpAuthContext,
  args: RenderDiagramArgs
): Promise<CallToolResult> {
  if (!ctx.permissions.includes('manage:system')) {
    const verdict = await CARDINAL.models.rateLimits.consume(renderLimitKey(ctx), RENDER_LIMIT)
    if (!verdict.allowed) {
      throw new McpToolError(
        `Too many render requests. Try again in ${Math.ceil(verdict.retryAfter / 60)} minute(s).`
      )
    }
  }

  let result
  try {
    result = await CARDINAL.models.diagramRender.render({
      type: args.type,
      source: args.source,
      theme: args.theme,
      format: args.format
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
