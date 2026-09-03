import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Wrap a tool's answer in the one content shape every tool here returns: a single text block holding
 * the JSON. Declared identically in all six tool files before this — the sort of four-line function
 * that stays identical right up until one copy quietly starts pretty-printing.
 */
export function toResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/**
 * The sentence every `siteId` argument ends with. A tool call may leave `siteId` out, and on the
 * common single-site wiki that is the right thing to do (`mcp/site.ts#resolveDefaultSiteId`) — so
 * the description has to say both that it is optional and how to find the value when it is not.
 */
export const SITE_ID_HINT = 'Omit on a single-site instance; see `list_sites` otherwise.'

/**
 * The optional `siteId` argument, with a per-tool lead sentence ("Which site to search.") in front of
 * the shared hint. Only the lead differs between tools, so only the lead is passed in.
 *
 * @param hint Overrides `SITE_ID_HINT` for `update_page`, whose argument names the site a page it was
 *   already given the id of belongs to — `list_sites` is not how a caller would look that up.
 */
export function siteIdArg(lead: string, hint: string = SITE_ID_HINT) {
  return z.string().uuid().optional().describe(`${lead} ${hint}`)
}

/**
 * The optional `locale` argument, for a tool that acts on one page in one locale and falls back to
 * the site's primary when the caller does not say. `search_pages` declares its own instead: there,
 * omitting it means every locale rather than the primary one.
 */
export const localeArg = z.string().optional().describe("The site's primary locale when omitted.")
