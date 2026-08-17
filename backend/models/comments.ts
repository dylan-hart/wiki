import { eq } from 'drizzle-orm'
import { comments as commentsTable } from '../db/schema.ts'

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
 * Also out of scope for this file: Akismet/spam/rate-limit policy (Feature 390's default provider)
 * and threaded listing / counts (`listForPage` / `countForPage`, a separate task on this Feature).
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
}

export const comments = new Comments()
