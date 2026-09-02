import { and, eq } from 'drizzle-orm'
import { blockCredentials as blockCredentialsTable } from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import { isValidOriginPattern } from '../helpers/network.ts'

/**
 * A stored credential's public shape — everything about it except `secret`, which never leaves this
 * model. See the file header below for why.
 */
export type BlockCredential = Omit<typeof blockCredentialsTable.$inferSelect, 'secret'>

const publicSelection = {
  id: blockCredentialsTable.id,
  siteId: blockCredentialsTable.siteId,
  name: blockCredentialsTable.name,
  allowedOrigins: blockCredentialsTable.allowedOrigins,
  createdAt: blockCredentialsTable.createdAt,
  updatedAt: blockCredentialsTable.updatedAt
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
 * that credential sent to an origin+path-prefix the admin who created it explicitly allowed
 * (OpenProject #2185/#2195 — an entry is a full `scheme://host[:port]/path-prefix`, not a bare
 * hostname) — `models/liveData.ts#resolve()` is what enforces this, this model just validates the
 * syntax and stores/returns the list. `createCredential` requires at least one entry;
 * `updateAllowedOrigins` may reduce that to zero (deliberately disabling the credential —
 * fail-closed, not a new hole).
 */
class BlockCredentials {
  /**
   * @throws {CustomError} `Bad Request` (400) for any entry that isn't a valid
   *   `scheme://host[:port][/path-prefix]` origin — see `helpers/network.ts#isValidOriginPattern`.
   *   The API route's own JSON Schema `pattern` already rejects a malformed entry before it reaches
   *   here in the ordinary case; this is what keeps that guarantee true for every other caller of
   *   this model too (tests, a future importer, …), not just the one route.
   */
  private assertValidAllowedOrigins(allowedOrigins: string[]): void {
    for (const entry of allowedOrigins) {
      if (!isValidOriginPattern(entry)) {
        throw new CustomError(
          'Bad Request',
          `"${entry}" is not a valid allowed origin — expected an absolute http(s) origin with an optional path prefix and no query or fragment (e.g. "https://api.example.com/v1").`,
          400
        )
      }
    }
  }
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
    this.assertValidAllowedOrigins(allowedOrigins)
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
   * Replace a credential's allowed origins list, keeping its id, name and secret. Unlike creation,
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
    this.assertValidAllowedOrigins(allowedOrigins)
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
}

export const blockCredentials = new BlockCredentials()
