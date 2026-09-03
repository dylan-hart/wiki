import { eq, lt, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { pageDrafts as pageDraftsTable } from '../db/schema.ts'

/**
 * How long an abandoned draft (page never reopened after a crash/tab-close) is kept before it is
 * swept — see {@link PageDrafts.purgeStale}. A row this old outlived any plausible "reopen the page
 * and get offered the recovery" window; keeping it forever would only grow the table for content
 * nobody is coming back for. Exported for `models/pageDrafts.db.test.ts`, which checks the real
 * constant rather than a hardcoded copy of it.
 */
export const STALE_DRAFT_DAYS = 30

/** One page's autosaved draft, as `core/collab.ts` needs it to reseed a room: the raw Yjs state and
 * when it was last updated. */
export interface PageDraft {
  state: Buffer
  updatedAt: Date
}

/** The plain fields a draft's Yjs state decodes to — what the recovery-restore flow (OpenProject
 * #2455) actually hands the frontend, rather than a raw Yjs update it has no use for over HTTP. */
export interface PageDraftContent {
  content: string
  title: string
  description: string
  icon: string
  authorName: string | null
  updatedAt: Date
}

/** The lightweight existence check folded into `viewer.draft` on a page read -- no content, and no
 * decode of the stored Yjs state. */
export interface PageDraftSummary {
  updatedAt: Date
  authorName: string | null
}

/**
 * The inverse of `core/collab.ts#buildSeed`: read a Yjs document's text/props back out as plain
 * values. Applied to a scratch `Y.Doc` built from a stored draft's raw state, never to a live room's
 * own doc — decoding a draft for the recovery-restore flow (OpenProject #2455) has nothing to do with
 * the room it may or may not still be part of.
 */
function decodeDraftState(state: Uint8Array): Omit<PageDraftContent, 'authorName' | 'updatedAt'> {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    const props = doc.getMap('props')
    return {
      content: doc.getText('content').toString(),
      title: (props.get('title') as string | undefined) ?? '',
      description: (props.get('description') as string | undefined) ?? '',
      icon: (props.get('icon') as string | undefined) ?? ''
    }
  } finally {
    doc.destroy()
  }
}

/**
 * Page drafts model (OpenProject #2454 / #2455)
 *
 * The durable half of collaborative-editing autosave-and-recover: `core/collab.ts` debounce-persists
 * a room's live Yjs document state here as edits happen (and once more, with best-effort author
 * attribution, as the room empties out), and reads it back to seed a room that has to be rebuilt from
 * scratch. The very same row backs the reader-facing recovery prompt — `summary()` for the
 * lightweight "there is one" signal folded into a page read, `getContent()` to decode the full thing
 * once a reader has chosen to restore it — see `db/schema.ts`'s `pageDrafts` table comment for the
 * full picture, including why the row is deleted rather than merely marked stale once a real save
 * lands.
 */
class PageDrafts {
  /** The persisted draft for a page, or `undefined` when none exists (never edited collaboratively
   * since its last save, or never edited at all). Raw Yjs state — what `core/collab.ts#initRoom`
   * needs to reseed a room. */
  async get(pageId: string): Promise<PageDraft | undefined> {
    const [row] = await WIKI.db
      .select({ state: pageDraftsTable.state, updatedAt: pageDraftsTable.updatedAt })
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
      .limit(1)
    return row
  }

  /** The full stored draft for a page, decoded into plain content/title/description/icon, or
   * `undefined` when there is none — what the `GET .../pages/:pageId/draft` route hands the reader
   * once they have chosen to restore it (OpenProject #2455). */
  async getContent(pageId: string): Promise<PageDraftContent | undefined> {
    const [row] = await WIKI.db
      .select({
        state: pageDraftsTable.state,
        authorName: pageDraftsTable.authorName,
        updatedAt: pageDraftsTable.updatedAt
      })
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
      .limit(1)
    if (!row) {
      return undefined
    }
    return { ...decodeDraftState(row.state), authorName: row.authorName, updatedAt: row.updatedAt }
  }

  /**
   * Just enough to say "there is one, from roughly when, possibly by whom" -- what `viewer.draft`
   * needs to offer a restore without decoding the draft's Yjs state on every page read.
   */
  async summary(pageId: string): Promise<PageDraftSummary | undefined> {
    const [row] = await WIKI.db
      .select({ updatedAt: pageDraftsTable.updatedAt, authorName: pageDraftsTable.authorName })
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
   * recovery copy of "the latest synced state", not a version log. `authorName` is best-effort
   * attribution of whoever was last known to be editing (OpenProject #2455) — pass `null` when it is
   * not known at the point of this particular write; a later write with a name overwrites it.
   */
  async save(
    pageId: string,
    siteId: string,
    state: Uint8Array,
    authorId: string | null = null,
    authorName: string | null = null
  ): Promise<void> {
    const buffer = Buffer.from(state)
    await WIKI.db
      .insert(pageDraftsTable)
      .values({ pageId, siteId, state: buffer, authorId, authorName, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: pageDraftsTable.pageId,
        set: { state: buffer, authorId, authorName, updatedAt: new Date() }
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
