import { asc, eq } from 'drizzle-orm'
import { comments as commentsTable, users as usersTable } from '../db/schema.ts'

/** A stored comment row, as returned by the primitives below. */
export interface Comment {
  id: string
  siteId: string
  pageId: string
  authorId: string | null
  replyTo: string | null
  content: string
  render: string | null
  guestName: string | null
  guestEmail: string | null
  guestIp: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * A comment as returned by {@link Comments.listForPage} — a {@link Comment} minus `guestEmail` /
 * `guestIp` (private fields with no reason to leave this layer for a page-view list) plus a resolved
 * `authorName` display name, nested under its parent via `replies` rather than left flat.
 *
 * Nesting was chosen over a flat `{ ..., replyTo }[]` because the two API consumers this exists for —
 * a page-view comment list and, later, an admin moderation view — both want to walk a thread
 * top-down. Handing them a tree means neither has to re-derive parent/child structure from
 * `replyTo` itself; that grouping happens once, here, against the single flat query this method
 * already ran. A flat shape would only have been simpler if a consumer needed to look up one comment
 * by id in isolation, which none currently does.
 */
export interface ThreadedComment {
  id: string
  siteId: string
  pageId: string
  authorId: string | null
  /** The author's name when `authorId` is set, `guestName` otherwise. Matches the fallback
   *  `pageEditSubmissions`-style rows use elsewhere (see `models/approvals.ts`). Never null — a
   *  comment always has one or the other. */
  authorName: string
  replyTo: string | null
  content: string
  render: string | null
  createdAt: Date
  updatedAt: Date
  /** Direct replies to this comment, oldest first. Empty for a leaf. */
  replies: ThreadedComment[]
}

/** Trimmed content shorter than this is not a comment. Matches 2.5.x's `postNewComment`. */
const MIN_CONTENT_LENGTH = 2

/**
 * Comments model
 *
 * Create/update/delete primitives over the `comments` table — plain data access, nothing more. Two
 * things this deliberately does NOT do, both on purpose:
 *
 * - **No permission checks.** Neither `models/pages.ts` nor `models/pageWatching.ts` calls
 *   `WIKI.models.groups.checkAccess()` from inside the model — that happens one layer up, in the API
 *   route handler, which is where `FastifyRequest` and the session/actor legitimately live
 *   (`mayOnPage` in `api/pages.ts`, `api/watching.ts` calling `pageWatching.watch()`). This file
 *   follows the same layering: no `FastifyRequest` import, no embedded access check. Feature 391's
 *   route handlers are the ones that call `checkAccess`/`mayOnPage` before reaching any method here.
 * - **No `render` population.** This codebase's page-rendering pipeline is a headless-browser render
 *   queue (`models/rendering.ts`) — far too heavy to hold a request open for a short synchronous
 *   comment post. `render` stays nullable and untouched here for 2.5.x row-shape parity and so a
 *   future provider has somewhere to put sanitized HTML; actually populating it (markdown-it +
 *   DOMPurify, mirroring 2.5.x's `comment.js`) is Feature 390's default-provider job, not this one's.
 *
 * Also out of scope for this file: Akismet/spam/rate-limit policy, which belongs to Feature 390's
 * default provider.
 */
class Comments {
  /**
   * Store a new comment.
   *
   * The only validation done here is the same floor 2.5.x's `postNewComment` applied: trimmed
   * content must be at least {@link MIN_CONTENT_LENGTH} characters. Everything past that — spam
   * scoring, rate limits, guest field requirements — is policy that belongs to the provider layer,
   * not this primitive.
   */
  async create({
    siteId,
    pageId,
    authorId = null,
    replyTo = null,
    content,
    guestName = null,
    guestEmail = null,
    guestIp = null
  }: {
    siteId: string
    pageId: string
    authorId?: string | null
    replyTo?: string | null
    content: string
    guestName?: string | null
    guestEmail?: string | null
    guestIp?: string | null
  }): Promise<Comment> {
    const trimmed = content.trim()
    if (trimmed.length < MIN_CONTENT_LENGTH) {
      throw new Error(`Comment content must be at least ${MIN_CONTENT_LENGTH} characters.`)
    }

    const rows = await WIKI.db
      .insert(commentsTable)
      .values({
        siteId,
        pageId,
        authorId,
        replyTo,
        content: trimmed,
        guestName,
        guestEmail,
        guestIp
      })
      .returning()
    return rows[0] as Comment
  }

  /**
   * Update a comment's content.
   *
   * Same minimum-length floor as {@link create}. Touches `updatedAt` off `Temporal.Now.instant()`
   * rather than `new Date()` or luxon, per this repo's Temporal conventions — converted to a `Date`
   * at the boundary since the `updatedAt` column is a plain `timestamp` (mode: `date`).
   */
  async update(id: string, { content }: { content: string }): Promise<Comment> {
    const trimmed = content.trim()
    if (trimmed.length < MIN_CONTENT_LENGTH) {
      throw new Error(`Comment content must be at least ${MIN_CONTENT_LENGTH} characters.`)
    }

    const rows = await WIKI.db
      .update(commentsTable)
      .set({
        content: trimmed,
        updatedAt: new Date(Temporal.Now.instant().epochMilliseconds)
      })
      .where(eq(commentsTable.id, id))
      .returning()
    return rows[0] as Comment
  }

  /** Delete a comment. Cascades to its replies via the `replyTo` foreign key. */
  async delete(id: string): Promise<void> {
    await WIKI.db.delete(commentsTable).where(eq(commentsTable.id, id))
  }

  /**
   * Every comment on a page, threaded.
   *
   * One flat `SELECT ... LEFT JOIN users`, ordered oldest-first, resolving the display name at the
   * same time (`authorName` from the join, falling back to `guestName`) — the join is `left` because
   * `authorId` is nullable (a guest comment has no user row to join to). The tree is then built in
   * application code from that single result set: no N+1 per-reply queries.
   *
   * A reply whose `replyTo` names a comment absent from this page's result set is dropped rather than
   * surfaced as an orphaned top-level comment. In practice this cannot happen — the `replyTo` foreign
   * key cascades, so deleting a parent deletes every reply under it in the same transaction, and a
   * reply can only ever point at a comment on the same page — but the tree-builder does not trust
   * that invariant to hold forever; it degrades to silently omitting the reply instead of raising it
   * to the top level (which would misrepresent an orphaned reply as a fresh comment) or throwing.
   */
  async listForPage(pageId: string): Promise<ThreadedComment[]> {
    const rows = await WIKI.db
      .select({
        id: commentsTable.id,
        siteId: commentsTable.siteId,
        pageId: commentsTable.pageId,
        authorId: commentsTable.authorId,
        authorName: usersTable.name,
        guestName: commentsTable.guestName,
        replyTo: commentsTable.replyTo,
        content: commentsTable.content,
        render: commentsTable.render,
        createdAt: commentsTable.createdAt,
        updatedAt: commentsTable.updatedAt
      })
      .from(commentsTable)
      .leftJoin(usersTable, eq(usersTable.id, commentsTable.authorId))
      .where(eq(commentsTable.pageId, pageId))
      .orderBy(asc(commentsTable.createdAt))

    return buildThread(rows as any[])
  }

  /** How many comments a page has, replies included. */
  async countForPage(pageId: string): Promise<number> {
    return WIKI.db.$count(commentsTable, eq(commentsTable.pageId, pageId))
  }
}

/**
 * Build the reply tree {@link Comments.listForPage} returns from its single flat, `createdAt`-ordered
 * result set. Two passes over the same array: the first materializes every row as a `ThreadedComment`
 * (empty `replies`) keyed by id, the second walks the rows again in the same createdAt order and
 * attaches each one to its parent's `replies` (or to the returned root list, for a top-level comment)
 * — which is also why both `replies` arrays and the root list come out oldest-first for free, with no
 * separate sort step.
 */
function buildThread(
  rows: Array<{
    id: string
    siteId: string
    pageId: string
    authorId: string | null
    authorName: string | null
    guestName: string | null
    replyTo: string | null
    content: string
    render: string | null
    createdAt: Date
    updatedAt: Date
  }>
): ThreadedComment[] {
  const byId = new Map<string, ThreadedComment>()
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      siteId: row.siteId,
      pageId: row.pageId,
      authorId: row.authorId,
      authorName: row.authorName ?? row.guestName ?? '',
      replyTo: row.replyTo,
      content: row.content,
      render: row.render,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      replies: []
    })
  }

  const roots: ThreadedComment[] = []
  for (const row of rows) {
    const node = byId.get(row.id)!
    if (row.replyTo === null) {
      roots.push(node)
      continue
    }
    const parent = byId.get(row.replyTo)
    if (parent) {
      parent.replies.push(node)
    }
    // else: `replyTo` names a comment not present in this result set. See the doc comment on
    // `listForPage` — dropped, not surfaced as an orphan.
  }
  return roots
}

export const comments = new Comments()
