import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql
} from 'drizzle-orm'
import { chunk } from 'es-toolkit/array'
import {
  comments as commentsTable,
  pages as pagesTable,
  users as usersTable
} from '../db/schema.ts'

/** A stored comment row, as returned by the primitives below. */
export type Comment = typeof commentsTable.$inferSelect

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

/** A page as `helpers/pageRules.ts` needs to see it, plus the id everything else keys off of. */
export interface AdminPageRef {
  id: string
  path: string
  locale: string
  tags: string[]
  classification: string
}

/** A comment as the admin moderation listing hands it back — flat, one row per comment. */
export interface AdminComment {
  id: string
  siteId: string
  pageId: string
  pagePath: string
  authorId: string | null
  /** The author's display name when `authorId` is set, `guestName` otherwise. Never null. */
  authorName: string
  replyTo: string | null
  content: string
  createdAt: Date
  updatedAt: Date
}

/** A comment plus just enough of its page to decide `manage:comments` against. */
export interface AdminCommentWithPage {
  id: string
  siteId: string
  pageId: string
  page: AdminPageRef
}

export interface ListForAdminOptions {
  siteId: string
  /**
   * The accessible-pages set the caller has already computed (see `accessiblePageIdsForAdmin` in
   * `api/comments.ts`) — every comment returned is restricted to one of these page ids.
   *
   * `null` means no restriction at all — a `manage:system` actor, who may see every page on the
   * site. The `pageId IN (...)` condition is omitted entirely rather than populated with every page
   * id on the site: that used to be exactly backwards, materialising the full page list only to
   * immediately turn it back into "everything", and binding it twice (once for the page query, once
   * for its `count(*)`) at up to postgres' 65,535-parameter ceiling.
   *
   * An empty array is still a legitimate "nothing is accessible" answer, not "no filter": it
   * short-circuits to an empty result without touching `comments` at all.
   */
  pageIds: string[] | null
  /** Substring match against the resolved author name (account name, or `guestName`). */
  author?: string
  dateFrom?: Date
  dateTo?: Date
  offset?: number
  limit?: number
  /**
   * Max page ids bound into one `pageId IN (...)` query before `pageIds` is split into several
   * queries whose rows are merged in memory instead. Defaults to a value comfortably under
   * postgres' 65,535-bind-parameter limit; exposed mainly so a test can exercise the chunking path
   * without needing tens of thousands of real rows in a throwaway database.
   */
  pageIdChunkSize?: number
}

/** {@link ListForAdminOptions.pageIdChunkSize}'s default. */
const DEFAULT_PAGE_ID_CHUNK_SIZE = 20000

/** Trimmed content shorter than this is not a comment. Matches 2.5.x's `postNewComment`. */
const MIN_CONTENT_LENGTH = 2

/**
 * Trimmed content longer than this is rejected. Mirrors `CommentInput.content`'s `maxLength` in
 * `api/schemas/comment.ts` — AJV enforces it for the request-driven POST/PATCH routes before the
 * handler ever calls into this model, but `create`/`update` are also reachable directly (a future
 * caller, the admin moderation surface, a script), so the ceiling is enforced here too rather than
 * relying solely on schema validation at the one entry point that currently has it.
 */
const MAX_CONTENT_LENGTH = 32768

const DEFAULT_LIMIT = 25

/** Guest identity columns (`guestName`/`guestEmail`/`guestIp`) are retained no longer than this by
 *  default -- admin-configurable via `WIKI.config.comments?.guestPiiRetentionDays`. See
 *  `purgeGuestPii()`. Mirrors `auditLog`'s `DEFAULT_AUDIT_LOG_RETENTION_DAYS` shape. */
const DEFAULT_GUEST_PII_RETENTION_DAYS = 90

/**
 * Comments model
 *
 * Create/update/delete/read primitives over the `comments` table — plain data access, nothing more.
 * Merges two independently-built halves at merge-review time: Feature 391's page-view primitives
 * (`create`/`update`/`delete`/`listForPage`/`countForPage`) and Feature 394's admin moderation query
 * layer (`pageRefsForSite`/`listForAdmin`/`getWithPage`), each built on its own unmerged branch
 * against the other's absence — see their original branch history for the individual design notes.
 * Both `delete` implementations were byte-for-byte identical and are kept once.
 *
 * Two things this deliberately does NOT do, both on purpose:
 *
 * - **No permission checks.** Neither `models/pages.ts` nor `models/pageWatching.ts` calls
 *   `WIKI.models.groups.checkAccess()` from inside the model — that happens one layer up, in the API
 *   route handler, which is where `FastifyRequest` and the session/actor legitimately live
 *   (`mayOnPage` in `helpers/pageAccess.ts`, `api/watching.ts` calling `pageWatching.watch()`). This file
 *   follows the same layering: no `FastifyRequest` import, no embedded access check.
 * - **No `render` population.** This codebase's page-rendering pipeline is a headless-browser render
 *   queue (`models/renderQueue.ts`) — far too heavy to hold a request open for a short synchronous
 *   comment post. `render` stays nullable and untouched here for 2.5.x row-shape parity and so a
 *   future provider has somewhere to put sanitized HTML; actually populating it (markdown-it +
 *   DOMPurify, mirroring 2.5.x's `comment.js`) is Feature 390's default-provider job, not this one's.
 *
 * Also out of scope for this file: Akismet/spam/rate-limit policy, which belongs to Feature 390's
 * default provider.
 *
 * **Hook emission** (task 610, moved here from `api/comments.ts` by OpenProject #1923): `create`,
 * `update` and `delete` each queue their `comment:new` / `comment:edit` / `comment:delete` webhook
 * deliveries themselves, matching the convention `models/pages.ts`'s `page:create` et al. and
 * `models/assets.ts`'s `asset:upload` et al. already follow — the route layer used to do this instead,
 * which was the one exception to that pattern. `delete` re-fetches the row before removing it
 * specifically so the emitted payload still has `authorId` to hand (a caller may only have a
 * page-scoped ref, not the full row) — the same two-lookup shape the admin moderation delete route
 * already used before this move.
 */
class Comments {
  /**
   * Store a new comment.
   *
   * The only validation done here is the same floor 2.5.x's `postNewComment` applied — trimmed
   * content must be at least {@link MIN_CONTENT_LENGTH} characters — plus a ceiling of
   * {@link MAX_CONTENT_LENGTH} characters. Everything past that — spam scoring, rate limits, guest
   * field requirements — is policy that belongs to the provider layer, not this primitive.
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
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      throw new Error(`Comment content must be at most ${MAX_CONTENT_LENGTH} characters.`)
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
    const comment = rows[0]
    await this.emitEvent('comment:new', comment, await this.resolveAuthorName(comment))
    return comment
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
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      throw new Error(`Comment content must be at most ${MAX_CONTENT_LENGTH} characters.`)
    }

    const rows = await WIKI.db
      .update(commentsTable)
      .set({
        content: trimmed,
        updatedAt: new Date(Temporal.Now.instant().epochMilliseconds)
      })
      .where(eq(commentsTable.id, id))
      .returning()
    const comment = rows[0]
    await this.emitEvent('comment:edit', comment, await this.resolveAuthorName(comment))
    return comment
  }

  /**
   * A single comment by id, flat (no `replies`), or `null` when it does not exist. Existence and
   * ownership lookups (the page-scoped PATCH/DELETE routes' `maySelfModerate` check) need this
   * directly rather than searching a page's whole `listForPage` tree for one id.
   */
  async get(id: string): Promise<Comment | null> {
    const rows = await WIKI.db.select().from(commentsTable).where(eq(commentsTable.id, id)).limit(1)
    return rows[0] ?? null
  }

  /**
   * Delete a comment. Cascades to its replies via the `replyTo` foreign key.
   *
   * Fetches the row first so `comment:delete` still has `authorId`/`siteId`/`pageId` to emit once the
   * row is gone — a caller may only be holding a page-scoped ref (`AdminCommentWithPage`, from
   * `getWithPage`), not the full row this needs. A no-op, non-emitting delete when `id` does not name
   * an existing comment (nothing to fetch, nothing to emit).
   */
  async delete(id: string): Promise<void> {
    const existing = await this.get(id)
    await WIKI.db.delete(commentsTable).where(eq(commentsTable.id, id))
    if (existing) {
      await this.emitEvent('comment:delete', existing)
    }
  }

  /**
   * Sweeps guest identity columns off comments older than the retention window
   * (`tasks/simple/purge-guest-pii.ts`), nulling `guestName`/`guestEmail`/`guestIp` in place rather
   * than deleting the comment itself -- its content and position in the thread are not PII, only who
   * the guest was is. Restricted to `authorId IS NULL` (a logged-in author's row never has these
   * columns populated in the first place, but the guard is cheap defense in depth) and to rows that
   * still have at least one guest column set, so a comment already swept is not rewritten on every
   * run once a table is fully purged. Mirrors `auditLog.purge()`'s shape: one statement, no batching.
   *
   * @param retentionDays How many days of guest identity to keep
   * @returns How many comments had their guest columns cleared
   */
  async purgeGuestPii(retentionDays: number): Promise<number> {
    const cutoff = new Date(
      Temporal.Now.instant().subtract({ hours: retentionDays * 24 }).epochMilliseconds
    )
    const result = await WIKI.db
      .update(commentsTable)
      .set({ guestName: null, guestEmail: null, guestIp: null })
      .where(
        and(
          isNull(commentsTable.authorId),
          lt(commentsTable.createdAt, cutoff),
          or(
            isNotNull(commentsTable.guestName),
            isNotNull(commentsTable.guestEmail),
            isNotNull(commentsTable.guestIp)
          )
        )
      )
    const purged = result.rowCount ?? 0
    if (purged > 0) {
      WIKI.logger.info('pages', 'purged guest PII from old comments', {
        comments: purged,
        retentionDays
      })
    }
    return purged
  }

  /** The configured guest-PII retention window, in days. */
  getGuestPiiRetentionDays(): number {
    return WIKI.config.comments?.guestPiiRetentionDays ?? DEFAULT_GUEST_PII_RETENTION_DAYS
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

  /**
   * Minimal page refs for a site — just `id`/`path`/`locale`/`tags`, the exact shape
   * `helpers/pageRules.ts` matches a rule against. Deliberately not the full `Page` row
   * `models/pages.ts` deals in: the admin moderation listing evaluates `manage:comments` against
   * every one of these once per request (see the query-strategy note on `accessiblePageIdsForAdmin`
   * in `api/comments.ts`), so keeping the row narrow keeps that bounded by page COUNT, not page
   * CONTENT.
   *
   * `pathFilter`, when given, is pushed into the query as a prefix `ILIKE` — the same "starts with"
   * semantics `api/pages/read.ts`'s page search uses for its own `path` filter — rather than applied
   * after the fact, so it shrinks the very set about to be permission-checked, for free.
   */
  async pageRefsForSite(siteId: string, pathFilter?: string): Promise<AdminPageRef[]> {
    const conditions = [eq(pagesTable.siteId, siteId)]
    if (pathFilter) {
      conditions.push(ilike(pagesTable.path, `${pathFilter}%`))
    }
    return WIKI.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification
      })
      .from(pagesTable)
      .where(and(...conditions))
  }

  /**
   * Comments across a site, restricted to `pageIds`, filtered and paginated.
   *
   * One query for the page (`LIMIT`/`OFFSET` pushed to SQL, not applied to a fetched-then-sliced
   * array) plus one `count(*)` query sharing the same `WHERE`, both indexed on
   * `comments_siteId_idx (siteId, createdAt)` and narrowed further by `pageId IN (...)`. Neither
   * query, nor anything in `api/comments.ts` that calls this, touches the database once per comment —
   * see the query-strategy note on `accessiblePageIdsForAdmin` in that file for the full picture.
   */
  async listForAdmin({
    siteId,
    pageIds,
    author,
    dateFrom,
    dateTo,
    offset = 0,
    limit = DEFAULT_LIMIT,
    pageIdChunkSize = DEFAULT_PAGE_ID_CHUNK_SIZE
  }: ListForAdminOptions): Promise<{ results: AdminComment[]; totalHits: number }> {
    if (pageIds !== null && pageIds.length === 0) {
      return { results: [], totalHits: 0 }
    }

    const authorName = sql<string>`coalesce(${usersTable.name}, ${commentsTable.guestName}, '')`
    const baseConditions = [eq(commentsTable.siteId, siteId)]
    if (dateFrom) {
      baseConditions.push(gte(commentsTable.createdAt, dateFrom))
    }
    if (dateTo) {
      baseConditions.push(lte(commentsTable.createdAt, dateTo))
    }
    if (author) {
      baseConditions.push(ilike(authorName, `%${author}%`))
    }

    // One query pair for a slice of `pageIds` (or none at all, for `null` — no restriction), sharing
    // the same `WHERE` between the page query and its `count(*)`, exactly as a single unchunked call
    // always has.
    const fetchSlice = (ids: string[] | null, sliceLimit: number, sliceOffset: number) => {
      const where = and(...baseConditions, ...(ids ? [inArray(commentsTable.pageId, ids)] : []))
      return Promise.all([
        WIKI.db
          .select({
            id: commentsTable.id,
            siteId: commentsTable.siteId,
            pageId: commentsTable.pageId,
            pagePath: pagesTable.path,
            authorId: commentsTable.authorId,
            authorName,
            replyTo: commentsTable.replyTo,
            content: commentsTable.content,
            createdAt: commentsTable.createdAt,
            updatedAt: commentsTable.updatedAt
          })
          .from(commentsTable)
          .innerJoin(pagesTable, eq(pagesTable.id, commentsTable.pageId))
          .leftJoin(usersTable, eq(usersTable.id, commentsTable.authorId))
          .where(where)
          .orderBy(desc(commentsTable.createdAt))
          .limit(sliceLimit)
          .offset(sliceOffset),
        WIKI.db
          .select({ count: sql<number>`count(*)::int` })
          .from(commentsTable)
          .leftJoin(usersTable, eq(usersTable.id, commentsTable.authorId))
          .where(where)
      ])
    }

    const pageIdChunks = pageIds === null ? null : chunk(pageIds, pageIdChunkSize)

    // No restriction, or few enough ids to bind in one query: identical shape (and identical query
    // count) to before this task — pagination stays pushed to SQL, nothing merged in memory.
    if (pageIdChunks === null || pageIdChunks.length <= 1) {
      const [results, countRows] = await fetchSlice(pageIds, limit, offset)
      return { results: results as AdminComment[], totalHits: countRows[0]?.count ?? 0 }
    }

    /*
     * More accessible page ids than fit in one bind-safe `IN (...)` (a delegated moderator with a
     * huge rule-matched page set — `manage:system` never reaches here, since its `pageIds` is
     * `null`): one query per chunk instead of one oversized bind. Each chunk pulls only up to
     * `offset + limit` rows — enough to guarantee correctness once every chunk's rows are merged and
     * re-sorted, since any chunk's rows could sort ahead of or behind another chunk's — then the
     * merged, re-sorted set is sliced down to the requested page. `totalHits` sums each chunk's own
     * `count(*)`, which stays exact since the chunks are disjoint page-id sets.
     */
    const chunkResults = await Promise.all(
      pageIdChunks.map((idsChunk) => fetchSlice(idsChunk, offset + limit, 0))
    )
    const merged = chunkResults.flatMap(([rows]) => rows as AdminComment[])
    merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const totalHits = chunkResults.reduce(
      (sum, [, countRows]) => sum + (countRows[0]?.count ?? 0),
      0
    )

    return { results: merged.slice(offset, offset + limit), totalHits }
  }

  /** A single comment plus enough of its page to decide `manage:comments` against, or `null`. */
  async getWithPage(id: string): Promise<AdminCommentWithPage | null> {
    const rows = await WIKI.db
      .select({
        id: commentsTable.id,
        siteId: commentsTable.siteId,
        pageId: commentsTable.pageId,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification
      })
      .from(commentsTable)
      .innerJoin(pagesTable, eq(pagesTable.id, commentsTable.pageId))
      .where(eq(commentsTable.id, id))
      .limit(1)
    const row = rows[0]
    if (!row) {
      return null
    }
    return {
      id: row.id,
      siteId: row.siteId,
      pageId: row.pageId,
      page: {
        id: row.pageId,
        path: row.path,
        locale: row.locale,
        tags: row.tags,
        classification: row.classification
      }
    }
  }

  /**
   * Resolves the display name behind a comment: the account's current name for a logged in author,
   * the stored `guestName` otherwise. Used only to build the `metadata.authorName` a `comment:new`/
   * `comment:edit` hook payload carries — the API response's own `authorName` field is resolved
   * separately, at the route layer (`resolveAuthorName` in `api/comments.ts`), since that also has to
   * cover `listForPage`'s response shape, which never reaches this method at all.
   */
  private async resolveAuthorName(comment: {
    authorId: string | null
    guestName: string | null
  }): Promise<string> {
    if (comment.authorId) {
      const user = await WIKI.models.users.getById(comment.authorId)
      if (user) {
        return user.name
      }
    }
    return comment.guestName ?? ''
  }

  /**
   * Queue a `comment:new` / `comment:edit` / `comment:delete` webhook delivery (task 610; moved here
   * from `api/comments.ts`'s `emitCommentEvent` by OpenProject #1923 — see the class doc comment).
   * Payload shape is unchanged from that route-layer version: `comment:delete` carries only the base
   * identity fields, the other two events add `metadata.authorName`/`metadata.replyTo` and `content`.
   */
  private async emitEvent(
    event: 'comment:new' | 'comment:edit' | 'comment:delete',
    comment: Comment,
    authorName?: string
  ): Promise<void> {
    const base = {
      id: comment.id,
      pageId: comment.pageId,
      siteId: comment.siteId,
      authorId: comment.authorId,
      isGuest: comment.authorId === null
    }
    await WIKI.models.hooks.emit(
      event,
      comment.siteId,
      event === 'comment:delete'
        ? base
        : {
            ...base,
            metadata: { authorName, replyTo: comment.replyTo },
            content: comment.content
          }
    )
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
