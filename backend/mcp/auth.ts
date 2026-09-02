import { ApiKeyError } from '../models/apiKeys.ts'
import type { ApiKeyIdentity } from '../models/apiKeys.ts'
import type { AccessActor } from '../models/groups.ts'
import type { PageActor } from '../models/pages.ts'
import type { AuditActor } from '../models/auditLog.ts'

/**
 * Raised for anything that stops an MCP tool call before it reaches a model: an invalid/revoked/
 * expired key, or a site the key is not scoped to. `mcp/tools/*.ts` throw this directly and let the
 * MCP SDK's `registerTool` wrapper turn it into a `CallToolResult` with `isError: true` — the same
 * "throw a plain Error, the framework formats it" convention `openproject-mcp` uses throughout its
 * own `mcp/tools/*.ts`.
 */
export class McpToolError extends Error {}

/**
 * What an authenticated MCP caller acts as. For the stdio transport this is resolved once at startup
 * (`mcp/stdio.ts`) from the single key configured via `WIKI_MCP_API_KEY`; for the HTTP transport
 * (`mcp/http.ts`) it is resolved fresh on every request from that request's own bearer token, so a
 * shared HTTP endpoint can serve many callers at once, each seeing only what their own token grants.
 *
 * This wraps the SAME `models/apiKeys.ts` bearer-token mechanism `/_api/` already authenticates with
 * (`Authorization: Bearer <token>`), not a new credential type invented for MCP. `groupIds`/`userId`
 * carry straight through from the verified `ApiKeyIdentity` (`models/apiKeys.ts`): for a personal
 * access token that is the owning user's CURRENT group membership, live-resolved on every verify; for
 * an admin-issued key it is the key's own configured groups. Either way, `actorFor()` below checks
 * page-rule permissions (`read:pages`, `read:source`, …) against exactly those groups — the same
 * question `WIKI.models.groups.groupIdsForRequest()` answers for a bearer-token `/_api/` request — so
 * an MCP tool call is authorized as the real human (or admin-issued key) behind it, not as a fixed
 * stand-in. `manage:system` still bypasses every page rule everywhere (`checkAccess()`'s first line),
 * exactly as it does for `/_api/`.
 *
 * An admin-issued key minted with no groups therefore grants an MCP caller nothing page-scoped —
 * matching `/_api/`'s own behavior for the same key, not a gap specific to MCP.
 */
export interface McpAuthContext {
  /** The verifying key's own id, for logging — never the identity a permission check is made against. */
  keyId: string
  /** The key's group-wide permissions (`manage:system`, …), resolved from its groups at verify time. */
  permissions: string[]
  /** The single site this key is pinned to, or null for instance-wide. See `assertSiteInScope()`. */
  siteId: string | null
  /** Groups this identity speaks for — what page-rule permissions are checked against. See `actorFor()`. */
  groupIds: string[]
  /** The user this key acts as (a personal access token), or null for an admin-issued key. */
  userId: string | null
  /**
   * The key's own scope narrowing (`ApiKeyIdentity.scope`), unnarrowed by anything above — `groupIds`
   * is still the identity's full, unnarrowed group membership. Carried through to `actorFor()`/
   * `pageActorFor()` so `checkAccess()`/`mayHoldPermissionSomewhere()` narrow an MCP call's page/site
   * permissions the same way `/_api/`'s `WIKI.models.groups.actorForRequest()` does (OpenProject
   * #930) — without this, a key scoped to `['read:pages']` still held every page permission its
   * groups' rules granted when reached through an MCP tool call. Optional (defaulting to unscoped
   * when absent) so the many hand-built fixtures across `mcp/*.test.ts` that do not care about
   * scoping are not forced to set it -- `contextFromIdentity()` is the one real code path building
   * this from a verified token and always sets it.
   */
  scope?: string[] | null
  /**
   * Per-level classification allow-set (OpenProject #1205, replacing the earlier #1055 single-value
   * ceiling), threaded the same way -- this is the primitive that resolves the coworker's original
   * concern (`McpAuthContext`'s own doc comment): a token minted with an allow-set keeps an MCP agent
   * away from anything classified outside it, regardless of what the token owner's groups otherwise
   * grant.
   */
  allowedClassifications?: string[] | null
}

/**
 * Resolves an `McpAuthContext` at call time rather than closing over one fixed value. Every
 * `register*Tool()` (`mcp/tools/*.ts`) takes one of these instead of a plain `McpAuthContext`, so that
 * a tool call made partway through a long-lived HTTP session (`mcp/http.ts`) is authorized against
 * THAT REQUEST's own freshly-verified identity — not the identity captured back when the session was
 * first opened. `mcp/http.ts` updates its session's stored context on every request before dispatching
 * into the transport, so a revoked/regrouped personal access token stops granting what it used to on
 * the very next call, not only once the session itself is torn down. The stdio transport
 * (`mcp/stdio.ts`), whose identity is fixed for the life of the process, just wraps its one resolved
 * context in a getter that always returns it.
 */
export type McpAuthContextGetter = () => McpAuthContext

/**
 * Map a verified `ApiKeyIdentity` onto the shape an MCP tool call is authorized against. Exported for
 * `mcp/http.ts`, which verifies a token itself (to also run it through `helpers/rateLimit.ts`'s
 * `limitApiKey()`, which expects the raw identity) rather than through `authenticateApiKey()` above.
 */
export function contextFromIdentity(identity: ApiKeyIdentity): McpAuthContext {
  return {
    keyId: identity.id,
    permissions: identity.permissions,
    siteId: identity.siteId,
    groupIds: identity.groupIds,
    userId: identity.userId,
    scope: identity.scope,
    allowedClassifications: identity.allowedClassifications
  }
}

/**
 * Verify a bearer token and resolve what it grants, the same way the `onRequest` hook in `index.ts`
 * does for `/_api/`.
 *
 * @throws McpToolError with a reason safe to surface to the caller (a startup failure message for the
 *         stdio transport, an HTTP 401 body for the HTTP transport)
 */
export async function authenticateApiKey(token: string): Promise<McpAuthContext> {
  try {
    return contextFromIdentity(await WIKI.models.apiKeys.verify(token))
  } catch (err: any) {
    if (err instanceof ApiKeyError) {
      throw new McpToolError(`The MCP API key is not usable: ${err.message}`)
    }
    throw err
  }
}

/**
 * The actor a tool call's permission checks (`checkAccess()`, `mayHoldPermissionSomewhere()`) are
 * decided against — the calling identity's own groups, so a personal access token is authorized as
 * its owner's real page-rule grants rather than a shared fallback. See `McpAuthContext`'s doc comment.
 */
export function actorFor(ctx: McpAuthContext): AccessActor {
  return {
    groupIds: ctx.groupIds,
    permissions: ctx.permissions,
    scope: ctx.scope,
    allowedClassifications: ctx.allowedClassifications,
    // -> Belt and braces alongside `assertSiteInScope()` (OpenProject #2189/#2199): the tool
    //    routing layer already refuses a call against a site the key isn't pinned to, but carrying
    //    the pin onto the actor closes `checkAccess()`/`checkSiteAccess()` themselves too.
    siteId: ctx.siteId
  }
}

/**
 * Who a write tool call (`create_page`/`update_page`) saves as, or `null` when it may not save at all.
 *
 * Mirrors `helpers/pageAccess.ts`'s `actorFrom()`: a page records a real author, and only a personal access
 * token (`ctx.userId` set) has one to offer — an admin-issued key has no user behind it to attribute
 * the page to, exactly as it grants no page-saving through `/_api/` either. `write:scripts`/
 * `write:styles` are page-rule-scoped, so `groupIds` travels with the actor the same way it does there.
 *
 * `via: 'mcp'` is what makes the resulting `pageHistory` row distinguishable from an edit made through
 * the standard editor (OpenProject #1119) — `models/pages.ts`'s write methods thread `actor.via`
 * straight through to `pageHistory.record()`.
 */
export function pageActorFor(ctx: McpAuthContext): PageActor | null {
  if (!ctx.userId) {
    return null
  }
  return {
    id: ctx.userId,
    permissions: ctx.permissions,
    groupIds: ctx.groupIds,
    scope: ctx.scope,
    allowedClassifications: ctx.allowedClassifications,
    siteId: ctx.siteId,
    via: 'mcp'
  }
}

/**
 * Whether this actor holds `write:pages`/`manage:pages` ANYWHERE ON THIS SITE — the same question
 * `api/pages/read.ts`'s search route asks before deciding whether unpublished pages and password-protected
 * excerpts belong in a result set. See `PAGE_PASSWORD_BYPASS_ROLES`'s doc comment there for why DENY
 * is ignored and why this is deliberately coarser than a per-page check.
 *
 * @param siteId The site being searched — `searchPages.ts`'s `handleSearchPages` already resolved
 *   one before calling this, so a `write:pages` rule scoped to a different site no longer answers
 *   `true` here (OpenProject #2146/#2162).
 */
export function maySeeEverything(actor: AccessActor, siteId: string): boolean {
  return WIKI.models.groups.mayHoldPermissionSomewhere(
    actor,
    ['write:pages', 'manage:pages'],
    siteId
  )
}

/**
 * Who a tool call audit-logs as (`models/auditLog.ts`, #1118) -- mirrors `actorFromRequest()`'s own
 * `req.apiKey` branch (`models/auditLog.ts`) exactly: named by the key's id rather than resolving the
 * personal token's owning user, so every apiKey-authenticated write -- MCP or `/_api/` -- is attributed
 * the same way in this log. `ctx` carries no IP (a tool handler only ever sees the auth context, not
 * the request), so `actorIp` is left at the model's own `''` default.
 */
export function auditActorFor(ctx: McpAuthContext): AuditActor {
  return { id: null, name: `API Key ${ctx.keyId}` }
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
