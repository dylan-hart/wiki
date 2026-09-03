import { eq, lt, sql } from 'drizzle-orm'
import { pageDrafts as pageDraftsTable } from '../db/schema.ts'

/**
 * Page drafts model
 *
 * The autosave source behind Feature #2426 ("Autosave draft while editing"): one row per page,
 * holding the last-synced Yjs document state for that page's collaborative-editing room
 * (`core/collab.ts`). Nothing here understands Yjs — a row is opaque bytes in, opaque bytes back out —
 * which is deliberate: this model owns the persistence, `core/collab.ts` owns what the bytes mean.
 *
 * At most one live draft per page, so every write is an upsert keyed on `pageId` rather than an
 * insert-then-update pair.
 */
class PageDrafts {
  /**
   * The persisted draft for a page, or `null` if there is none.
   */
  async get(pageId: string): Promise<Buffer | null> {
    const [row] = await WIKI.db
      .select({ state: pageDraftsTable.state })
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
      .limit(1)
    return row?.state ?? null
  }

  /**
   * Replace a page's persisted draft with `state`, creating the row if this is the first one.
   */
  async save(pageId: string, siteId: string, state: Uint8Array): Promise<void> {
    const buffer = Buffer.from(state)
    await WIKI.db
      .insert(pageDraftsTable)
      .values({ pageId, siteId, state: buffer })
      .onConflictDoUpdate({
        target: pageDraftsTable.pageId,
        set: { state: buffer, updatedAt: sql`now()` }
      })
  }

  /**
   * Drop a page's persisted draft, e.g. once a real save has committed its content and there is
   * nothing left to recover.
   */
  async clear(pageId: string): Promise<void> {
    await WIKI.db.delete(pageDraftsTable).where(eq(pageDraftsTable.pageId, pageId))
  }

  /**
   * Drop drafts nothing has touched in a week -- the backstop for a page whose room was abandoned
   * mid-edit (a crash, a tab closed and never reopened) and never came back for its draft. A week
   * comfortably outlasts any real "I'll get back to this tomorrow" gap while still bounding the
   * table's growth for pages nobody ever returns to.
   *
   * @returns How many rows were dropped
   */
  async purgeStale(): Promise<number> {
    const result = await WIKI.db
      .delete(pageDraftsTable)
      .where(lt(pageDraftsTable.updatedAt, sql`now() - interval '7 days'`))
    return result.rowCount ?? 0
  }
}

export const pageDrafts = new PageDrafts()
