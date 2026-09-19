import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/server'

/** The one content shape every tool answers in; a copy in a tool file is a regression. */
export function toResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/**
 * Omitting `siteId` is the right call on a single-site wiki (`mcp/site.ts#resolveDefaultSiteId`), so
 * every description has to say both that and where to find the value when it is not.
 */
export const SITE_ID_HINT = 'Omit on a single-site instance; see `list_sites` otherwise.'

/**
 * @param hint Overridden by the tools whose `siteId` names the site of a page they already have the
 *   id of — `list_sites` is not how a caller would look that up.
 */
export function siteIdArg(lead: string, hint: string = SITE_ID_HINT) {
  return z.string().uuid().optional().describe(`${lead} ${hint}`)
}

/**
 * For a tool acting on one page in one locale. `search_pages` declares its own instead: there,
 * omitting it means every locale rather than the primary one.
 */
export const localeArg = z.string().optional().describe("The site's primary locale when omitted.")
