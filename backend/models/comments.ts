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
import { loadModule } from '../helpers/moduleRegistry.ts'
import {
  comments as commentsTable,
  pages as pagesTable,
  users as usersTable
} from '../db/schema.ts'
import type { CommentProvider } from './commentProviders.ts'
import type { CommentProviderModule } from '../modules/comments/default/comments.ts'

export type Comment = typeof commentsTable.$inferSelect

/**
 * A {@link Comment} shaped for a page-view list: the private `guestEmail`/`guestIp` dropped, and
 * replies nested so no consumer re-derives the thread from `replyTo`.
 */
export interface ThreadedComment {
  id: string
  siteId: string
  pageId: string
  authorId: string | null
  authorName: string
  replyTo: string | null
  content: string
  render: string | null
  createdAt: Date
  updatedAt: Date
  /** Oldest first. */
  replies: ThreadedComment[]
}

export interface AdminPageRef {
  id: string
  path: string
  locale: string
  tags: string[]
  classification: string
}

export interface AdminComment {
  id: string
  siteId: string
  pageId: string
  pagePath: string
  authorId: string | null
  authorName: string
  replyTo: string | null
  content: string
  createdAt: Date
  updatedAt: Date
}

export interface AdminCommentWithPage {
  id: string
  siteId: string
  pageId: string
  page: AdminPageRef
}

export interface ListForAdminOptions {
  siteId: string
  /**
   * The accessible-pages set the caller has already computed. `null` is no restriction at all (a
   * `manage:system` actor) and omits the `pageId IN (...)` condition entirely; an empty array is a
   * legitimate "nothing is accessible", not "no filter".
   */
  pageIds: string[] | null
  author?: string
  dateFrom?: Date
  dateTo?: Date
  offset?: number
  limit?: number
  /**
   * Max page ids bound into one `pageId IN (...)` before `pageIds` is split across several queries
   * merged in memory. The default sits comfortably under postgres' 65,535-bind-parameter limit;
   * exposed so a test can exercise the chunking path without tens of thousands of real rows.
   */
  pageIdChunkSize?: number
}

const DEFAULT_PAGE_ID_CHUNK_SIZE = 20000

/** Matches the floor 2.5.x's `postNewComment` applied. */
const MIN_CONTENT_LENGTH = 2

/**
 * Mirrors `CommentInput.content`'s `maxLength` in `api/schemas/comment.ts` — keep in sync. ajv
 * covers the request-driven routes; `create`/`update` are reachable directly too, so the ceiling is
 * enforced here as well.
 */
const MAX_CONTENT_LENGTH = 32768

const DEFAULT_LIMIT = 25

const DEFAULT_GUEST_PII_RETENTION_DAYS = 90

/**
 * No permission checks and no `FastifyRequest` import: access checks, Akismet scoring and rate
 * limits belong one layer up, in `api/comments.ts`, which is where the session and the request's own
 * ip/UA/permalink legitimately live.
 *
 * `render` is populated synchronously by the site's comment-provider module, never through the
 * headless-browser queue `models/renderQueue.ts` drives — far too heavy to hold a comment post open
 * for.
 */

const providerModules: Record<string, CommentProviderModule> = {}

class Comments {
  /**
   * `null` when there is no active provider or it is embed-only — Disqus, Commento and Artalk
   * declare client-side config only, with no sibling `comments.ts`. Public so `api/comments.ts`'s
   * POST route can run `checkSpam()` against the request's own ip/UA/permalink, which this model
   * cannot see.
   *
   * The config is deliberately unmasked, unlike `commentProviders.getActiveProvider()`, which is
   * masked because it can reach an anonymous reader's browser: a caller here needs the real Akismet
   * key/`minDelay`, not a redacted display value.
   */
  async activeProviderModule(
    siteId: string
  ): Promise<{ provider: CommentProvider; module: CommentProviderModule } | null> {
    const providers = await CARDINAL.models.commentProviders.getSiteProviders(siteId)
    const provider = providers.find((p) => p.isEnabled)
    if (!provider) {
      return null
    }
    const mod = await loadModule<CommentProviderModule>(
      providerModules,
      provider.module,
      // -> Extension-sensitive dynamic import, invisible to the type checker: renaming the module
      //    file means updating this specifier by hand.
      () => import(`../modules/comments/${provider.module}/comments.ts`),
      'comments',
      () => provider.hasImplementation
    )
    if (!mod) {
      return null
    }
    return { provider, module: mod }
  }

  /**
   * A `null` result degrades rather than refusing the comment. `PageComments.vue` renders `render`
   * alone, so a provider that throws leaves that comment showing an empty body.
   */
  private async renderForSite(siteId: string, content: string): Promise<string | null> {
    const active = await this.activeProviderModule(siteId)
    if (!active) {
      return null
    }
    try {
      return (await active.module.render(content)).render
    } catch (err: any) {
      CARDINAL.logger.warn('ext', 'rendering a comment failed', {
        module: active.provider.module,
        siteId,
        error: err
      })
      return null
    }
  }
  async create({
    siteId,
    pageId,
    authorId = null,
    replyTo = null,
    content,
    guestName = null,
    guestEmail = null,
    guestIp = null,
    createdAt,
    updatedAt
  }: {
    siteId: string
    pageId: string
    authorId?: string | null
    replyTo?: string | null
    content: string
    guestName?: string | null
    guestEmail?: string | null
    guestIp?: string | null
    /**
     * Only the migration importer supplies this, to carry a 2.x comment's real post date across —
     * which is also what keeps an imported thread's `createdAt` ordering chronological rather than
     * import-ordered. A live post keeps the column's `now()` default.
     */
    createdAt?: string
    updatedAt?: string
  }): Promise<Comment> {
    const trimmed = content.trim()
    if (trimmed.length < MIN_CONTENT_LENGTH) {
      throw new Error(`Comment content must be at least ${MIN_CONTENT_LENGTH} characters.`)
    }
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      throw new Error(`Comment content must be at most ${MAX_CONTENT_LENGTH} characters.`)
    }

    const render = await this.renderForSite(siteId, trimmed)

    const rows = await CARDINAL.db
      .insert(commentsTable)
      .values({
        siteId,
        pageId,
        authorId,
        replyTo,
        content: trimmed,
        render,
        guestName,
        guestEmail,
        guestIp,
        ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
        ...(updatedAt ? { updatedAt: new Date(updatedAt) } : {})
      })
      .returning()
    const comment = rows[0]
    await this.emitEvent('comment:new', comment, await this.resolveAuthorName(comment))
    return comment
  }

  /**
   * Only the migration importer needs this: a 2.x reply can name a comment appearing later in the
   * same source stream, so an import creates every comment top-level and threads them in a second
   * pass. A live reply knows its parent's id at `create()` time.
   */
  async setReplyTo(id: string, replyTo: string): Promise<void> {
    await CARDINAL.db.update(commentsTable).set({ replyTo }).where(eq(commentsTable.id, id))
  }

  /**
   * The extra {@link get} is what learns which site's provider to re-render with — a bare
   * `UPDATE ... SET content` has no `siteId` to hand.
   */
  async update(id: string, { content }: { content: string }): Promise<Comment> {
    const trimmed = content.trim()
    if (trimmed.length < MIN_CONTENT_LENGTH) {
      throw new Error(`Comment content must be at least ${MIN_CONTENT_LENGTH} characters.`)
    }
    if (trimmed.length > MAX_CONTENT_LENGTH) {
      throw new Error(`Comment content must be at most ${MAX_CONTENT_LENGTH} characters.`)
    }

    const existing = await this.get(id)
    const render = existing ? await this.renderForSite(existing.siteId, trimmed) : null

    const rows = await CARDINAL.db
      .update(commentsTable)
      .set({
        content: trimmed,
        render,
        updatedAt: new Date(Temporal.Now.instant().epochMilliseconds)
      })
      .where(eq(commentsTable.id, id))
      .returning()
    const comment = rows[0]
    await this.emitEvent('comment:edit', comment, await this.resolveAuthorName(comment))
    return comment
  }

  async get(id: string): Promise<Comment | null> {
    const rows = await CARDINAL.db
      .select()
      .from(commentsTable)
      .where(eq(commentsTable.id, id))
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * Replies cascade via the `replyTo` foreign key. The row is fetched first so `comment:delete`
   * still has `authorId`/`siteId`/`pageId` to emit once it is gone.
   */
  async delete(id: string): Promise<void> {
    const existing = await this.get(id)
    await CARDINAL.db.delete(commentsTable).where(eq(commentsTable.id, id))
    if (existing) {
      await this.emitEvent('comment:delete', existing)
    }
  }

  /**
   * The comment itself stays -- its content and position in the thread are not PII, only who the
   * guest was is. The "still has a guest column set" condition is what stops an already-swept table
   * being rewritten on every run; `authorId IS NULL` is cheap defense in depth, since a logged-in
   * author's row never has these columns populated.
   */
  async purgeGuestPii(retentionDays: number): Promise<number> {
    const cutoff = new Date(
      Temporal.Now.instant().subtract({ hours: retentionDays * 24 }).epochMilliseconds
    )
    const result = await CARDINAL.db
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
      CARDINAL.logger.info('pages', 'purged guest PII from old comments', {
        comments: purged,
        retentionDays
      })
    }
    return purged
  }

  getGuestPiiRetentionDays(): number {
    return CARDINAL.config.comments?.guestPiiRetentionDays ?? DEFAULT_GUEST_PII_RETENTION_DAYS
  }

  /**
   * One flat query — the join is `left` because a guest comment has no user row — with the tree
   * built in application code from that single result set, rather than an N+1 of per-reply queries.
   */
  async listForPage(pageId: string): Promise<ThreadedComment[]> {
    const rows = await CARDINAL.db
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

  async countForPage(pageId: string): Promise<number> {
    return CARDINAL.db.$count(commentsTable, eq(commentsTable.pageId, pageId))
  }

  /**
   * Deliberately not the full `Page` row, only what `helpers/pageRules.ts` matches a rule against:
   * the admin moderation listing evaluates `manage:comments` against every one of these once per
   * request, so a narrow row keeps that bounded by page COUNT, not page CONTENT. `pathFilter` is
   * pushed into the query so it shrinks the very set about to be permission-checked.
   */
  async pageRefsForSite(siteId: string, pathFilter?: string): Promise<AdminPageRef[]> {
    const conditions = [eq(pagesTable.siteId, siteId)]
    if (pathFilter) {
      conditions.push(ilike(pagesTable.path, `${pathFilter}%`))
    }
    return CARDINAL.db
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

    const fetchSlice = (ids: string[] | null, sliceLimit: number, sliceOffset: number) => {
      const where = and(...baseConditions, ...(ids ? [inArray(commentsTable.pageId, ids)] : []))
      return Promise.all([
        CARDINAL.db
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
        CARDINAL.db
          .select({ count: sql<number>`count(*)::int` })
          .from(commentsTable)
          .leftJoin(usersTable, eq(usersTable.id, commentsTable.authorId))
          .where(where)
      ])
    }

    const pageIdChunks = pageIds === null ? null : chunk(pageIds, pageIdChunkSize)

    // Few enough ids to bind in one query: pagination stays in SQL, nothing merged in memory.
    if (pageIdChunks === null || pageIdChunks.length <= 1) {
      const [results, countRows] = await fetchSlice(pageIds, limit, offset)
      return { results: results as AdminComment[], totalHits: countRows[0]?.count ?? 0 }
    }

    /*
     * More page ids than fit one bind-safe `IN (...)`: one query per chunk, each pulling
     * `offset + limit` rows, since any chunk's rows can sort ahead of or behind another's and only
     * the merged, re-sorted set can be sliced to the requested page. Summing each chunk's own
     * `count(*)` stays exact because the chunks are disjoint page-id sets.
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

  async getWithPage(id: string): Promise<AdminCommentWithPage | null> {
    const rows = await CARDINAL.db
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
   * Only for the `metadata.authorName` a hook payload carries. An API response's own `authorName`
   * is resolved at the route layer instead, since that also has to cover `listForPage`'s shape.
   */
  private async resolveAuthorName(comment: {
    authorId: string | null
    guestName: string | null
  }): Promise<string> {
    if (comment.authorId) {
      const user = await CARDINAL.models.users.getById(comment.authorId)
      if (user) {
        return user.name
      }
    }
    return comment.guestName ?? ''
  }

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
    await CARDINAL.models.hooks.emit(
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
 * Relies on `rows` arriving `createdAt`-ordered: walking them in order is what leaves every
 * `replies` array and the root list oldest-first with no separate sort step.
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
    // else: parent absent from this result set — dropped, not surfaced as an orphan.
  }
  return roots
}

export const comments = new Comments()
