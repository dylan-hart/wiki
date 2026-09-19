import { and, eq } from 'drizzle-orm'
import { blockCredentials as blockCredentialsTable } from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import { isValidOriginPattern } from '../helpers/network.ts'

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
 * A block prop lives in a page's own markdown, readable by anyone holding `read:source` on that
 * page — not a safe place for an endpoint's auth token. This model is the credential store a
 * server-fetching block points at instead: a block prop carries a credential's `id` alone, and only
 * `getCredentialForResolve()` ever reads the `secret` column back out, for the server-side fetch
 * that resolves the block's data (`models/liveData.ts`). Every other method here — the ones an API
 * route can reach — returns {@link BlockCredential}, which has no `secret` field to leak.
 *
 * `allowedOrigins` is a second, independent boundary: even a caller who legitimately knows a
 * credential's id (any `write:pages` author who can read a page already using it) can only have that
 * credential sent to an origin+path-prefix the admin who created it explicitly allowed — an entry is
 * a full `scheme://host[:port]/path-prefix`, not a bare hostname. `models/liveData.ts#resolve()`
 * enforces it; this model only validates the syntax and stores the list.
 */
class BlockCredentials {
  /**
   * @throws {CustomError} `Bad Request` (400) for any entry that isn't a valid
   *   `scheme://host[:port][/path-prefix]` origin. The API route's own JSON Schema `pattern` already
   *   rejects a malformed entry in the ordinary case; this keeps that guarantee true for every other
   *   caller of this model too, not just the one route.
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
  async getSiteCredentials(siteId: string): Promise<BlockCredential[]> {
    return CARDINAL.db
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
    const [row] = await CARDINAL.db
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
    const [row] = await CARDINAL.db
      .insert(blockCredentialsTable)
      .values({ siteId, name, secret, allowedOrigins })
      .returning(publicSelection)
    return row!
  }

  /**
   * Reissues a leaked or expiring token without an author having to update every block prop that
   * references this credential's id.
   *
   * @returns Whether a matching row was found and updated
   */
  async rotateSecret(siteId: string, id: string, secret: string): Promise<boolean> {
    const result = await CARDINAL.db
      .update(blockCredentialsTable)
      .set({ secret, updatedAt: new Date() })
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Unlike creation, this may reduce the list to empty — an admin deliberately disabling the
   * credential rather than deleting it, which is fail-closed (it simply stops resolving for every
   * URL) rather than a new exposure.
   *
   * @returns Whether a matching row was found and updated
   */
  async updateAllowedOrigins(
    siteId: string,
    id: string,
    allowedOrigins: string[]
  ): Promise<boolean> {
    this.assertValidAllowedOrigins(allowedOrigins)
    const result = await CARDINAL.db
      .update(blockCredentialsTable)
      .set({ allowedOrigins, updatedAt: new Date() })
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return (result.rowCount ?? 0) > 0
  }

  async deleteCredential(siteId: string, id: string): Promise<boolean> {
    const result = await CARDINAL.db
      .delete(blockCredentialsTable)
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return (result.rowCount ?? 0) > 0
  }
}

export const blockCredentials = new BlockCredentials()
