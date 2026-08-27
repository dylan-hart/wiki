import { and, eq } from 'drizzle-orm'
import { blockCredentials as blockCredentialsTable } from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import { isValidOriginPrefixPattern } from '../helpers/network.ts'

/**
 * A stored credential's public shape — everything about it except `secret`, which never leaves this
 * model. See the file header below for why.
 */
export interface BlockCredential {
  id: string
  siteId: string
  name: string
  allowedOrigins: string[]
  createdAt: Date
  updatedAt: Date
}

const publicSelection = {
  id: blockCredentialsTable.id,
  siteId: blockCredentialsTable.siteId,
  name: blockCredentialsTable.name,
  allowedOrigins: blockCredentialsTable.allowedOrigins,
  createdAt: blockCredentialsTable.createdAt,
  updatedAt: blockCredentialsTable.updatedAt
}

/**
 * Throws unless every entry in `allowedOrigins` is a valid origin-plus-path-prefix pattern (see
 * `helpers/network.ts#isValidOriginPrefixPattern`) — the real enforcement point now that the shape
 * (scheme + host + port + path prefix) is too rich for a single JSON Schema `pattern` regex to fully
 * validate the way the old hostname-only allowlist could. The route schema still catches a
 * syntactically-not-a-URI entry (`format: 'uri'`); this is what catches a non-http(s) scheme or a
 * query/fragment-carrying entry regardless of caller.
 */
function assertValidAllowedOrigins(allowedOrigins: string[]): void {
  for (const origin of allowedOrigins) {
    if (!isValidOriginPrefixPattern(origin)) {
      throw new CustomError(
        'Bad Request',
        `"${origin}" is not a valid allowed origin: must be an absolute http(s) URL with no userinfo, query string, or fragment.`,
        400
      )
    }
  }
}

/**
 * Block credentials model (OpenProject #868, hardened by the #868 domain-allowlist follow-up)
 *
 * A block prop lives in a page's own markdown, readable by anyone holding `read:source` on that
 * page — not a safe place for an endpoint's auth token. This model is the credential store `block
 * -live-data` (and any future server-fetching block) points at instead: a block prop carries a
 * credential's `id` alone, and only this model's `getCredentialForResolve()` ever reads the
 * `secret` column back out, for the server-side fetch that resolves the block's data
 * (`models/liveData.ts`). Every other method here — the ones an API route can reach — returns
 * {@link BlockCredential}, which has no `secret` field to leak.
 *
 * `allowedOrigins` is a second, independent boundary: even a caller who legitimately knows a
 * credential's id (any `write:pages` author who can read a page already using it) can only have
 * that credential sent to an origin (and path prefix) the admin who created it explicitly allowed —
 * `models/liveData.ts#resolve()` is what enforces this, this model just stores, validates and
 * returns the list. `createCredential` requires at least one entry; `updateAllowedOrigins` may
 * reduce that to zero (deliberately disabling the credential — fail-closed, not a new hole).
 */
class BlockCredentials {
  /** A site's stored credentials, secrets excluded. What the admin credential list is built from. */
  async getSiteCredentials(siteId: string): Promise<BlockCredential[]> {
    return WIKI.db
      .select(publicSelection)
      .from(blockCredentialsTable)
      .where(eq(blockCredentialsTable.siteId, siteId))
      .orderBy(blockCredentialsTable.name)
  }

  /**
   * The secret and its allowlist, for the server-side fetch alone — the secret is never routed
   * through an API response.
   *
   * @returns `undefined` when no such credential exists on this site, so a caller cannot use this to
   *   probe whether an id from another site exists.
   */
  async getCredentialForResolve(
    siteId: string,
    id: string
  ): Promise<{ secret: string; allowedOrigins: string[] } | undefined> {
    const [row] = await WIKI.db
      .select({
        secret: blockCredentialsTable.secret,
        allowedOrigins: blockCredentialsTable.allowedOrigins
      })
      .from(blockCredentialsTable)
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return row
  }

  async createCredential(
    siteId: string,
    name: string,
    secret: string,
    allowedOrigins: string[]
  ): Promise<BlockCredential> {
    assertValidAllowedOrigins(allowedOrigins)
    const [row] = await WIKI.db
      .insert(blockCredentialsTable)
      .values({ siteId, name, secret, allowedOrigins })
      .returning(publicSelection)
    return row!
  }

  /**
   * Replace a credential's secret, keeping its id, name and allowlist. Reissuing a leaked or
   * expiring token without an author having to update every block prop that references this
   * credential's id.
   *
   * @returns Whether a matching row was found and updated
   */
  async rotateSecret(siteId: string, id: string, secret: string): Promise<boolean> {
    const result = await WIKI.db
      .update(blockCredentialsTable)
      .set({ secret, updatedAt: new Date() })
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Replace a credential's allowed-origins list, keeping its id, name and secret. Unlike creation,
   * this may reduce the list to empty — an admin deliberately disabling the credential rather than
   * deleting it, which is safe (the credential simply stops resolving for every URL) rather than a
   * new exposure.
   *
   * @returns Whether a matching row was found and updated
   */
  async updateAllowedOrigins(
    siteId: string,
    id: string,
    allowedOrigins: string[]
  ): Promise<boolean> {
    assertValidAllowedOrigins(allowedOrigins)
    const result = await WIKI.db
      .update(blockCredentialsTable)
      .set({ allowedOrigins, updatedAt: new Date() })
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return (result.rowCount ?? 0) > 0
  }

  async deleteCredential(siteId: string, id: string): Promise<boolean> {
    const result = await WIKI.db
      .delete(blockCredentialsTable)
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return (result.rowCount ?? 0) > 0
  }

  /** All of a site's credentials, called from `models/sites.ts#deleteSite()` — no FK cascade. */
  async deleteSiteCredentials(siteId: string): Promise<void> {
    await WIKI.db.delete(blockCredentialsTable).where(eq(blockCredentialsTable.siteId, siteId))
  }
}

export const blockCredentials = new BlockCredentials()
