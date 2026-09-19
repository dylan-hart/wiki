import { eq, lt, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { pageDrafts as pageDraftsTable } from '../db/schema.ts'

/**
 * How long an abandoned draft (page never reopened after a crash/tab-close) is kept before
 * {@link PageDrafts.purgeStale} sweeps it: past this, nobody is coming back to be offered the
 * recovery, and the row is pure table growth.
 */
export const STALE_DRAFT_DAYS = 30

/** One page's autosaved draft: the raw, undecoded Yjs state and when it was last written. */
export interface PageDraft {
  state: Buffer
  updatedAt: Date
}

/** The plain fields a draft's Yjs state decodes to — what the recovery-restore flow hands the
 * frontend, rather than a raw Yjs update it has no use for over HTTP. */
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
 * The inverse of `core/collab.ts#buildSeed`. Applied to a scratch `Y.Doc` built from a stored
 * draft's raw state, never to a live room's own doc.
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
 * The durable half of collaborative-editing autosave-and-recover: `core/collab.ts` debounce-persists
 * a room's live Yjs state here as edits happen, and again with best-effort author attribution as the
 * room empties out. The same row backs the reader-facing recovery prompt.
 */
class PageDrafts {
  /** Raw Yjs state, undecoded — a caller wanting plain content/title/description/icon wants
   * `getContent()` instead. Room seeding deliberately does not use this; see
   * `core/collab.ts#initRoom`. */
  async get(pageId: string): Promise<PageDraft | undefined> {
    const [row] = await CARDINAL.db
      .select({ state: pageDraftsTable.state, updatedAt: pageDraftsTable.updatedAt })
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
      .limit(1)
    return row
  }

  /** The stored draft decoded into plain fields — what the draft route hands a reader who has
   * chosen to restore it. */
  async getContent(pageId: string): Promise<PageDraftContent | undefined> {
    const [row] = await CARDINAL.db
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
   * needs to offer a restore without decoding Yjs state on every page read.
   */
  async summary(pageId: string): Promise<PageDraftSummary | undefined> {
    const [row] = await CARDINAL.db
      .select({ updatedAt: pageDraftsTable.updatedAt, authorName: pageDraftsTable.authorName })
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
      .limit(1)
    return row
  }

  /**
   * One row per page (`pageId` is the primary key), so a session's debounced writes overwrite the
   * previous snapshot rather than accumulating history — the draft is a recovery copy of the latest
   * synced state, not a version log. `authorName` is best-effort attribution of whoever was last
   * known to be editing: pass `null` when unknown here, and a later write with a name overwrites it.
   */
  async save(
    pageId: string,
    siteId: string,
    state: Uint8Array,
    authorId: string | null = null,
    authorName: string | null = null
  ): Promise<void> {
    const buffer = Buffer.from(state)
    await CARDINAL.db
      .insert(pageDraftsTable)
      .values({ pageId, siteId, state: buffer, authorId, authorName, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: pageDraftsTable.pageId,
        set: { state: buffer, authorId, authorName, updatedAt: new Date() }
      })
  }

  /** Safe to call for a page with no draft row. */
  async clear(pageId: string): Promise<void> {
    await CARDINAL.db.delete(pageDraftsTable).where(eq(pageDraftsTable.pageId, pageId))
  }

  /**
   * Drop drafts nothing has touched in {@link STALE_DRAFT_DAYS}. A draft whose page was genuinely
   * saved is already cleared by `core/collab.ts`; this is only the backstop for what that never sees.
   *
   * @returns How many rows were dropped
   */
  async purgeStale(): Promise<number> {
    const result = await CARDINAL.db
      .delete(pageDraftsTable)
      .where(lt(pageDraftsTable.updatedAt, sql`now() - make_interval(days => ${STALE_DRAFT_DAYS})`))
    return result.rowCount ?? 0
  }
}

export const pageDrafts = new PageDrafts()
