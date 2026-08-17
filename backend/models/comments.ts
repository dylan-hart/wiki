import { and, desc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm'
import {
  comments as commentsTable,
  pages as pagesTable,
  users as usersTable
} from '../db/schema.ts'

/**
 * Comments model
 *
 * Task 625 (Feature 394): the query layer behind the admin moderation listing/deletion endpoint in
 * `api/comments.ts`. Deliberately narrow — no `create`/`update`, no threading, no webhook emission.
 * Those belong to Feature 391's own `models/comments.ts` (built read-only-inspected on the sibling
 * `feature/comments-rest-api` branch, not merged here — see the provenance note on the `comments`
 * table in `db/schema.ts`), which this task does not attempt to duplicate. Once that branch merges,
 * the two files should become one: its `create`/`update`/`get`/`delete`/`listForPage` alongside this
 * file's `pageRefsForSite`/`listForAdmin`.
 *
 * Same layering rule as `models/pages.ts`/`models/pageWatching.ts`: **no permission checks here**.
 * `FastifyRequest`/the actor legitimately live one layer up, in `api/comments.ts`, which is what
 * calls `WIKI.models.groups.checkAccess()` — this file is plain data access, nothing more.
 */

/** A page as `helpers/pageRules.ts` needs to see it, plus the id everything else keys off of. */
export interface AdminPageRef {
  id: string
  path: string
  locale: string
  tags: string[]
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
   * `api/comments.ts`) — every comment returned is restricted to one of these page ids. An empty
   * array is a legitimate "nothing is accessible" answer, not "no filter": it short-circuits to an
   * empty result without touching `comments` at all.
   */
  pageIds: string[]
  /** Substring match against the resolved author name (account name, or `guestName`). */
  author?: string
  dateFrom?: Date
  dateTo?: Date
  offset?: number
  limit?: number
}

const DEFAULT_LIMIT = 25

class Comments {
  /**
   * Minimal page refs for a site — just `id`/`path`/`locale`/`tags`, the exact shape
   * `helpers/pageRules.ts` matches a rule against. Deliberately not the full `Page` row
   * `models/pages.ts` deals in: the admin moderation listing evaluates `manage:comments` against
   * every one of these once per request (see the query-strategy note on `accessiblePageIdsForAdmin`
   * in `api/comments.ts`), so keeping the row narrow keeps that bounded by page COUNT, not page
   * CONTENT.
   *
   * `pathFilter`, when given, is pushed into the query as a prefix `ILIKE` — the same "starts with"
   * semantics `api/pages.ts`'s page search uses for its own `path` filter — rather than applied
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
        tags: pagesTable.tags
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
    limit = DEFAULT_LIMIT
  }: ListForAdminOptions): Promise<{ results: AdminComment[]; totalHits: number }> {
    if (pageIds.length === 0) {
      return { results: [], totalHits: 0 }
    }

    const authorName = sql<string>`coalesce(${usersTable.name}, ${commentsTable.guestName}, '')`
    const conditions = [eq(commentsTable.siteId, siteId), inArray(commentsTable.pageId, pageIds)]
    if (dateFrom) {
      conditions.push(gte(commentsTable.createdAt, dateFrom))
    }
    if (dateTo) {
      conditions.push(lte(commentsTable.createdAt, dateTo))
    }
    if (author) {
      conditions.push(ilike(authorName, `%${author}%`))
    }
    const where = and(...conditions)

    const [results, countRows] = await Promise.all([
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
        .limit(limit)
        .offset(offset),
      WIKI.db
        .select({ count: sql<number>`count(*)::int` })
        .from(commentsTable)
        .leftJoin(usersTable, eq(usersTable.id, commentsTable.authorId))
        .where(where)
    ])

    return { results: results as AdminComment[], totalHits: countRows[0]?.count ?? 0 }
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
        tags: pagesTable.tags
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
      page: { id: row.pageId, path: row.path, locale: row.locale, tags: row.tags }
    }
  }

  /**
   * Delete a comment.
   *
   * `feature/comments-rest-api` (Feature 391) has its own page-scoped delete with a self-authorship
   * exception (a comment's own author may delete it without `manage:comments`) — not present on this
   * branch, so this task adds this one instead, per its own description. This primitive carries no
   * policy of its own; `api/comments.ts` only ever calls it after `manage:comments` has already been
   * checked, since the admin moderation surface has no self-authorship exception to begin with.
   */
  async delete(id: string): Promise<void> {
    await WIKI.db.delete(commentsTable).where(eq(commentsTable.id, id))
  }
}

export const comments = new Comments()
