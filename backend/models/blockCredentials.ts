import { and, eq } from 'drizzle-orm'
import { blockCredentials as blockCredentialsTable } from '../db/schema.ts'

/**
 * A stored credential's public shape — everything about it except `secret`, which never leaves this
 * model. See the file header below for why.
 */
export interface BlockCredential {
  id: string
  siteId: string
  name: string
  createdAt: Date
  updatedAt: Date
}

const publicSelection = {
  id: blockCredentialsTable.id,
  siteId: blockCredentialsTable.siteId,
  name: blockCredentialsTable.name,
  createdAt: blockCredentialsTable.createdAt,
  updatedAt: blockCredentialsTable.updatedAt
}

/**
 * Block credentials model (OpenProject #868)
 *
 * A block prop lives in a page's own markdown, readable by anyone holding `read:source` on that
 * page — not a safe place for an endpoint's auth token. This model is the credential store `block
 * -live-data` (and any future server-fetching block) points at instead: a block prop carries a
 * credential's `id` alone, and only this model's `getSecret()` ever reads the `secret` column back
 * out, for the server-side fetch that resolves the block's data (`models/liveData.ts`). Every other
 * method here — the ones an API route can reach — returns {@link BlockCredential}, which has no
 * `secret` field to leak.
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
   * The secret itself, for the server-side fetch alone — never routed through an API response.
   *
   * @returns `undefined` when no such credential exists on this site, so a caller cannot use this to
   *   probe whether an id from another site exists.
   */
  async getSecret(siteId: string, id: string): Promise<string | undefined> {
    const [row] = await WIKI.db
      .select({ secret: blockCredentialsTable.secret })
      .from(blockCredentialsTable)
      .where(and(eq(blockCredentialsTable.siteId, siteId), eq(blockCredentialsTable.id, id)))
    return row?.secret
  }

  async createCredential(siteId: string, name: string, secret: string): Promise<BlockCredential> {
    const [row] = await WIKI.db
      .insert(blockCredentialsTable)
      .values({ siteId, name, secret })
      .returning(publicSelection)
    return row!
  }

  /**
   * Replace a credential's secret, keeping its id and name. Reissuing a leaked or expiring token
   * without an author having to update every block prop that references this credential's id.
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
