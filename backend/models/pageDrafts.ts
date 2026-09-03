import { eq, sql } from 'drizzle-orm'

import { pageDrafts as pageDraftsTable } from '../db/schema.ts'

/**
 * The last unsaved edit a page's collaboration room was holding when it emptied out without a save
 * (OpenProject #2455) -- see `db/schema.ts#pageDrafts` for the shape and `core/collab.ts` for who
 * writes and clears it. This model is the thin data-access layer over that one table: no business
 * logic of its own beyond the upsert-by-page-id `save()` needs.
 */

/** What `core/collab.ts` hands over when a dirty room empties out. */
export interface PageDraftSnapshot {
  pageId: string
  content: string
  title: string
  description: string
  icon: string
  authorId: string | null
  authorName: string | null
}

/** A stored draft, as read back for the editor's restore flow. */
export interface PageDraft {
  content: string
  title: string
  description: string
  icon: string
  authorId: string | null
  authorName: string | null
  updatedAt: Date
}

/** The lightweight existence check folded into `viewer.draft` on a page read -- no content. */
export interface PageDraftSummary {
  updatedAt: Date
  authorName: string | null
}

export const pageDrafts = {
  /**
   * Persist (or replace) the draft for a page.
   *
   * One row per page -- collaborative editing is a shared room, not a personal draft -- so a second
   * call for the same page overwrites the first rather than accumulating history. Called with no
   * expectation of being awaited by its caller: `core/collab.ts#closeRoomIfEmpty` fires this from a
   * websocket `close` handler and does not hold the room open for it.
   */
  async save(snapshot: PageDraftSnapshot): Promise<void> {
    const values = {
      content: snapshot.content,
      title: snapshot.title,
      description: snapshot.description,
      icon: snapshot.icon,
      authorId: snapshot.authorId,
      authorName: snapshot.authorName
    }
    await WIKI.db
      .insert(pageDraftsTable)
      .values({ pageId: snapshot.pageId, ...values })
      .onConflictDoUpdate({
        target: pageDraftsTable.pageId,
        set: { ...values, updatedAt: sql`now()` }
      })
  },

  /** The full stored draft for a page, or null when there is none. */
  async get(pageId: string): Promise<PageDraft | null> {
    const rows = await WIKI.db
      .select()
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
      .limit(1)
    return rows[0] ?? null
  },

  /**
   * Just enough to say "there is one, from roughly when, possibly by whom" -- what `viewer.draft`
   * needs to offer a restore without shipping the draft's content on every page read.
   */
  async summary(pageId: string): Promise<PageDraftSummary | null> {
    const rows = await WIKI.db
      .select({
        updatedAt: pageDraftsTable.updatedAt,
        authorName: pageDraftsTable.authorName
      })
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
      .limit(1)
    return rows[0] ?? null
  },

  /**
   * Drop the draft for a page, if there is one. Called once the page is actually saved
   * (`WIKI.collab.pageSaved`) or the reader chooses to discard it -- idempotent either way, since a
   * page with no draft has nothing here to delete.
   */
  async clear(pageId: string): Promise<void> {
    await WIKI.db.delete(pageDraftsTable).where(eq(pageDraftsTable.pageId, pageId))
  }
}
