import { eq, lt, sql } from 'drizzle-orm'
import { pageDrafts as pageDraftsTable } from '../db/schema.ts'

/**
 * How long an abandoned draft (page never reopened after a crash/tab-close) is kept before it is
 * swept — see {@link PageDrafts.purgeStale}. A row this old outlived any plausible "reopen the page
 * and get offered the recovery" window; keeping it forever would only grow the table for content
 * nobody is coming back for. Exported for `models/pageDrafts.db.test.ts`, which checks the real
 * constant rather than a hardcoded copy of it.
 */
export const STALE_DRAFT_DAYS = 30

/** One page's autosaved draft: the raw Yjs state and when it was last updated. */
export interface PageDraft {
  state: Buffer
  updatedAt: Date
}

/**
 * Page drafts model (OpenProject #2454)
 *
 * The durable half of collaborative-editing autosave: `core/collab.ts` debounce-persists a room's
 * live Yjs document state here as edits happen, and reads it back to seed a room that has to be
 * rebuilt from scratch (no peer instance already holding the page open) — see `db/schema.ts`'s
 * `pageDrafts` table comment for the full picture, including why the row is deleted rather than
 * merely marked stale once a real save lands.
 */
class PageDrafts {
  /** The persisted draft for a page, or `undefined` when none exists (never edited collaboratively
   * since its last save, or never edited at all). */
  async get(pageId: string): Promise<PageDraft | undefined> {
    const [row] = await WIKI.db
      .select({ state: pageDraftsTable.state, updatedAt: pageDraftsTable.updatedAt })
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
      .limit(1)
    return row
  }

  /**
   * Persist a room's current Yjs state as the page's draft, replacing whatever was stored before.
   *
   * One row per page (`pageId` is the primary key), so a collaborative session's debounced writes
   * simply overwrite the previous snapshot rather than accumulating a history — the draft is a
   * recovery copy of "the latest synced state", not a version log.
   */
  async save(pageId: string, siteId: string, state: Uint8Array): Promise<void> {
    const buffer = Buffer.from(state)
    await WIKI.db
      .insert(pageDraftsTable)
      .values({ pageId, siteId, state: buffer, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: pageDraftsTable.pageId,
        set: { state: buffer, updatedAt: new Date() }
      })
  }

  /** Forget a page's draft, e.g. once its content has genuinely been saved. Safe to call for a page
   * with no draft row. */
  async clear(pageId: string): Promise<void> {
    await WIKI.db.delete(pageDraftsTable).where(eq(pageDraftsTable.pageId, pageId))
  }

  /**
   * Drop drafts nothing has touched in {@link STALE_DRAFT_DAYS} — a page abandoned mid-edit and never
   * reopened. Everything else is already cleared on save by `core/collab.ts#pageSaved()`; this is
   * only the backstop for what that path never sees.
   *
   * @returns How many rows were dropped
   */
  async purgeStale(): Promise<number> {
    const result = await WIKI.db
      .delete(pageDraftsTable)
      .where(lt(pageDraftsTable.updatedAt, sql`now() - make_interval(days => ${STALE_DRAFT_DAYS})`))
    return result.rowCount ?? 0
  }
}

export const pageDrafts = new PageDrafts()
