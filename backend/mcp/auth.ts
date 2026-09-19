import { ApiKeyError } from '../models/apiKeys.ts'
import type { ApiKeyIdentity } from '../models/apiKeys.ts'
import type { AccessActor } from '../models/groups.ts'
import type { PageActor } from '../models/pages.ts'
import type { AuditActor } from '../models/auditLog.ts'

/**
 * Stops a tool call before it reaches a model (unusable key, out-of-scope site). Tools throw it
 * directly: the MCP SDK's `registerTool` wrapper turns a thrown Error into an `isError: true` result.
 */
export class McpToolError extends Error {}

/**
 * What an authenticated MCP caller acts as: the same `models/apiKeys.ts` bearer token `/_api/`
 * authenticates with, not an MCP-specific credential. Page-rule permissions are checked against
 * `groupIds` -- a personal access token's owner's current groups, or an admin-issued key's
 * configured ones -- so an admin-issued key with no groups grants nothing page-scoped, as on `/_api/`.
 */
export interface McpAuthContext {
  /** For logging and audit naming only — never what a permission check is made against. */
  keyId: string
  /** Global permissions only (`manage:system`, …); page-rule ones are decided from `groupIds`. */
  permissions: string[]
  /** The one site this key is pinned to, or null for instance-wide. */
  siteId: string | null
  groupIds: string[]
  /** The owning user of a personal access token, or null for an admin-issued key. */
  userId: string | null
  /**
   * The key's scope narrowing; `groupIds` stays the full membership, so `checkAccess()` needs this
   * to narrow page/site permissions. Optional only so hand-built test fixtures may omit it --
   * `contextFromIdentity()` always sets it.
   */
  scope?: string[] | null
  /**
   * Classification allow-set: keeps a caller away from anything classified outside it, whatever
   * the key's groups otherwise grant.
   */
  allowedClassifications?: string[] | null
}

/**
 * A getter rather than a fixed value, so a tool call made partway through a long-lived session is
 * authorized against the latest verified identity: a revoked or regrouped token stops granting on
 * the next call, not when the session ends.
 */
export type McpAuthContextGetter = () => McpAuthContext

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

/** @throws McpToolError whose message is safe to surface to the caller. */
export async function authenticateApiKey(token: string): Promise<McpAuthContext> {
  try {
    return contextFromIdentity(await CARDINAL.models.apiKeys.verify(token))
  } catch (err: any) {
    if (err instanceof ApiKeyError) {
      throw new McpToolError(`The MCP API key is not usable: ${err.message}`)
    }
    throw err
  }
}

export function actorFor(ctx: McpAuthContext): AccessActor {
  return {
    groupIds: ctx.groupIds,
    permissions: ctx.permissions,
    scope: ctx.scope,
    allowedClassifications: ctx.allowedClassifications,
    // -> Belt and braces alongside `assertSiteInScope()`: with the pin on the actor,
    //    `checkAccess()`/`checkSiteAccess()` refuse a foreign site themselves too.
    siteId: ctx.siteId
  }
}

/**
 * Who a write tool call saves as, or `null` when it may not save at all. Mirrors
 * `helpers/pageAccess.ts#actorFrom`: a page records a real author, and only a personal access token
 * has one. `via: 'mcp'` is what tells the `pageHistory` row apart from a standard-editor edit.
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
 * Whether the actor holds `write:pages`/`manage:pages` anywhere on this site -- what decides
 * whether unpublished pages and password-protected excerpts belong in a search result. Deliberately
 * coarser than a per-page check, same as `PAGE_PASSWORD_BYPASS_ROLES` in `api/pages/read.ts`.
 */
export function maySeeEverything(actor: AccessActor, siteId: string): boolean {
  return CARDINAL.models.groups.mayHoldPermissionSomewhere(
    actor,
    ['write:pages', 'manage:pages'],
    siteId
  )
}

/**
 * Mirrors `models/auditLog.ts#actorFromRequest`'s `req.apiKey` branch: named by key id, not by a
 * personal token's owner, so every API-key write is attributed the same way. A tool handler never
 * sees the request, so there is no IP to pass.
 */
export function auditActorFor(ctx: McpAuthContext): AuditActor {
  return { id: null, name: `API Key ${ctx.keyId}` }
}

/**
 * Mirrors `helpers/apiKeySite.ts#enforceApiKeySite`, throwing instead of writing a Fastify reply:
 * there is no HTTP response here.
 */
export function assertSiteInScope(ctx: McpAuthContext, siteId: string): void {
  if (ctx.siteId && ctx.siteId !== siteId) {
    throw new McpToolError('The configured MCP API key is not scoped to this site.')
  }
}
