import { ApiKeyError } from '../models/apiKeys.ts'
import type { AccessActor } from '../models/groups.ts'

/**
 * Raised for anything that stops an MCP tool call before it reaches a model: an invalid/revoked/
 * expired key, or a site the key is not scoped to. `mcp/tools/*.ts` throw this directly and let the
 * MCP SDK's `registerTool` wrapper turn it into a `CallToolResult` with `isError: true` — the same
 * "throw a plain Error, the framework formats it" convention `openproject-mcp` uses throughout its
 * own `mcp/tools/*.ts`.
 */
export class McpToolError extends Error {}

/**
 * What an authenticated MCP session acts as, for the lifetime of the process — resolved once at
 * startup (see `mcp/stdio.ts`) from the single instance-wide key configured via `WIKI_MCP_API_KEY`.
 *
 * INTERIM AUTH MODEL, documented here because it is the one thing every tool call inherits:
 *
 * This wraps the SAME `models/apiKeys.ts` bearer-token mechanism `/_api/` already authenticates with
 * (`Authorization: Bearer <token>`), not a new credential type invented for MCP. One key is configured
 * for the whole MCP server process, so every tool call — regardless of which human or agent is driving
 * the MCP client — acts with that one key's permissions. This is coarser than the wiki's real
 * authorization model, which is per-user: a page rule can differ from one person to the next, and this
 * collapses that to "whatever the operator's chosen key was issued for".
 *
 * The concrete effect on page-rule permissions specifically (`read:pages`, `read:source`, …): those
 * are decided by `WIKI.models.groups.checkAccess()` against an actor's GROUP membership, not its
 * global `permissions` list (see CLAUDE.md's Permissions section) — and a bearer-token-only request
 * carries no session, so it has no group membership of its own to offer. This mirrors exactly what
 * already happens for every OTHER bearer-token request in this codebase today (see
 * `models/groups.ts`'s `groupIdsForRequest()`): with no session, it resolves to the guests group. An
 * MCP tool call therefore sees whatever the guests group's page rules allow, UNLESS the configured key
 * holds `manage:system`, which bypasses every page rule everywhere (`checkAccess()`'s first line) —
 * exactly as it does for a `manage:system` key used against `/_api/` directly. There is nothing MCP-
 * specific about either half of that; it is the existing API-key trust model, used as-is.
 *
 * The ideal — matching a real page-rule grant to the human on the other end of the MCP client — is
 * per-user API tokens (`feature/per-user-api-tokens`, a concurrent item in this same batch). Once that
 * lands, an MCP client is expected to pass ITS caller's own per-user token instead of a shared
 * instance-wide one, and `actorFor()` below is the one place that changes: it would build the actor
 * from that token's real group membership instead of falling back to guests. Everything else in
 * `mcp/` — the tool surface, the site-scoping guard, the permission checks on results — is unchanged
 * by that migration, since it already asks `checkAccess()`/`mayHoldPermissionSomewhere()` for the
 * answer rather than assuming one.
 */
export interface McpAuthContext {
  /** The verifying key's own id, for logging — never the identity a permission check is made against. */
  keyId: string
  /** The key's group-wide permissions (`manage:system`, …), resolved from its groups at verify time. */
  permissions: string[]
  /** The single site this key is pinned to, or null for instance-wide. See `assertSiteInScope()`. */
  siteId: string | null
}

/**
 * Verify the configured bearer token and resolve what it grants, the same way the `onRequest` hook in
 * `index.ts` does for `/_api/` — just without a `FastifyRequest` to hang the result off, since this
 * process serves no HTTP requests. Called once at startup; see `mcp/stdio.ts`.
 *
 * @throws McpToolError with a reason safe to surface in a startup failure message
 */
export async function authenticateApiKey(token: string): Promise<McpAuthContext> {
  try {
    const identity = await WIKI.models.apiKeys.verify(token)
    return { keyId: identity.id, permissions: identity.permissions, siteId: identity.siteId }
  } catch (err: any) {
    if (err instanceof ApiKeyError) {
      throw new McpToolError(`The configured MCP API key is not usable: ${err.message}`)
    }
    throw err
  }
}

/**
 * The actor a tool call's permission checks (`checkAccess()`, `mayHoldPermissionSomewhere()`) are
 * decided against. See the INTERIM AUTH MODEL doc comment on `McpAuthContext` above for why this
 * resolves to the guests group's rules rather than the key's own groups.
 */
export function actorFor(ctx: McpAuthContext): AccessActor {
  return {
    groupIds: [WIKI.data.systemIds.guestsGroupId],
    permissions: ctx.permissions
  }
}

/**
 * Whether this actor holds `write:pages`/`manage:pages` ANYWHERE — the same question
 * `api/pages.ts`'s search route asks before deciding whether unpublished pages and password-protected
 * excerpts belong in a result set. See `PAGE_PASSWORD_BYPASS_ROLES`'s doc comment there for why DENY
 * is ignored and why this is deliberately coarser than a per-page check.
 */
export function maySeeEverything(actor: AccessActor): boolean {
  return WIKI.models.groups.mayHoldPermissionSomewhere(actor, ['write:pages', 'manage:pages'])
}

/**
 * Refuse a call whose configured key is scoped to one site but whose resource belongs to another.
 * Mirrors `helpers/apiKeySite.ts`'s `enforceApiKeySite()`, adapted to throw rather than write a Fastify
 * reply — there is no HTTP response here for the MCP SDK to turn into a `CallToolResult`.
 */
export function assertSiteInScope(ctx: McpAuthContext, siteId: string): void {
  if (ctx.siteId && ctx.siteId !== siteId) {
    throw new McpToolError('The configured MCP API key is not scoped to this site.')
  }
}
