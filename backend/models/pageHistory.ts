import { diffLines } from 'diff'
import { isEqual } from 'es-toolkit/predicate'
import { and, desc, eq, lt, notExists, or, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import {
  pageHistory as pageHistoryTable,
  pages as pagesTable,
  users as usersTable
} from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import { invalidateGraphCache } from '../helpers/graphCache.ts'
import type { Page, PageActor, PageInput } from './pages.ts'

const HISTORY_LIST_DEFAULT_LIMIT = 50
const HISTORY_LIST_MAX_LIMIT = 200

/**
 * `moved` is a change of path or title, told apart from an ordinary edit because it is what breaks
 * links; `updated` is everything else, content and metadata alike.
 */
export const pageHistoryActions = ['created', 'updated', 'moved', 'deleted'] as const

export type PageHistoryAction = (typeof pageHistoryActions)[number]

/**
 * Kept alongside `action` rather than folded into it — what changed and what wrote it are
 * orthogonal, and every `action` value is possible either way.
 */
export const pageHistoryVia = ['editor', 'mcp'] as const

export type PageHistoryVia = (typeof pageHistoryVia)[number]

/**
 * Postgres intervals rather than durations computed here, so the cutoff is measured against the same
 * clock the rows were written by — `versionDate` defaults to `now()`. Calendar arithmetic comes
 * free: a month is a month, whichever one it lands in.
 */
export const purgeTimeframes = {
  '24h': '24 hours',
  '1m': '1 month',
  '3m': '3 months',
  '6m': '6 months',
  '1y': '1 year',
  '2y': '2 years'
} as const

export type PurgeTimeframe = keyof typeof purgeTimeframes

/**
 * A version's `meta` is taken straight off the stored page row, so a field added to a page is
 * captured without touching anything here. What is excluded is either derived from the content,
 * fixed for the page's whole life, or bookkeeping that says nothing about the version.
 */
const EXCLUDED_FROM_META = new Set([
  'id',
  'siteId',
  'creatorId',
  'createdAt',
  'updatedAt',
  'authorId',
  'hash',
  'render',
  'toc',
  'searchContent',
  'ts',
  'historyData',
  // -> Held in columns of their own
  'locale',
  'path',
  'title',
  'content'
])

/**
 * Either derived from the content (a render moves whenever the source does) or bookkeeping that
 * moves on every save regardless.
 */
const NOT_REPORTED_AS_CHANGED = new Set([
  'render',
  'toc',
  'searchContent',
  'ts',
  'hash',
  'authorId',
  'updatedAt',
  'historyData',
  'isSearchableComputed'
])

/** `id` goes null once that account is gone; the version stays. */
export type PageHistoryAuthor = {
  id: string | null
  name: string
  email: string
}

export type PageHistoryEntry = {
  id: string
  action: string
  /** `editor` or `mcp`. */
  via: string
  changedFields: string[]
  /** Empty when the site does not ask for a reason, or asked and was not answered. */
  reason: string
  versionDate: Date
  locale: string
  path: string
  title: string
  author: PageHistoryAuthor
}

export type PageHistoryVersion = PageHistoryEntry & {
  content: string
  meta: Record<string, any>
}

/**
 * Deliberately NOT `PageHistoryEntry`. `tags`/`classification` let the route narrow its per-row
 * `read:history` check with a TAG/TAGALL/CLASSIFICATION rule rather than a bare path/locale match,
 * and `author` carries no `email`: this listing is reachable by a caller who does NOT hold
 * `read:pages` at the deleted path.
 */
export type RecoverablePageEntry = Omit<PageHistoryEntry, 'author'> & {
  tags: string[]
  classification: string | null
  author: Omit<PageHistoryAuthor, 'email'>
}

/**
 * A whole timeline is hundreds of rows at a time and nothing reads an author's address off it, so
 * the email a `getVersion()` row still carries is left out of this projection entirely rather than
 * fetched and thrown away.
 */
export type PageHistoryListAuthor = Omit<PageHistoryAuthor, 'email'>

export type PageHistoryListEntry = Omit<PageHistoryEntry, 'author'> & {
  author: PageHistoryListAuthor
}

export type PageHistoryPage = {
  /** Newest first. */
  items: PageHistoryListEntry[]
  nextCursor: string | null
}

/**
 * `nextCursor` is derived from where the underlying `versionDate`/`id` keyset scan stopped, BEFORE
 * the route's per-row `read:history` filter runs -- so `items` can come back shorter than the
 * requested `limit` while `nextCursor` still correctly says there is more. A caller decides it has
 * reached the end by `nextCursor === null`, never by `items.length < limit`.
 */
export type PageHistoryRecoverablePage = {
  items: RecoverablePageEntry[]
  nextCursor: string | null
}

const RECOVERABLE_LIST_DEFAULT_LIMIT = 50
const RECOVERABLE_LIST_MAX_LIMIT = 200

type HistoryCursor = {
  versionDate: Date
  id: string
}

/**
 * Millisecond precision is what postgres stores, so a round trip never disagrees with the row it
 * came from. `id` rides along because several versions can share one `versionDate`, and it is what
 * keeps their relative order stable across pages.
 */
function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${cursor.versionDate.getTime()}|${cursor.id}`, 'utf8').toString('base64url')
}

/**
 * A value that does not decode is tampered or truncated, not something normal paging can produce --
 * hence a 400 rather than an empty page.
 */
function decodeHistoryCursor(raw: string): HistoryCursor {
  const invalid = () =>
    new CustomError('pageHistoryInvalidCursor', 'This history cursor is not valid.', 400)
  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    throw invalid()
  }
  const separatorIndex = decoded.indexOf('|')
  if (separatorIndex < 0) {
    throw invalid()
  }
  const epochMs = Number.parseInt(decoded.slice(0, separatorIndex), 10)
  const id = decoded.slice(separatorIndex + 1)
  if (!Number.isFinite(epochMs) || !id) {
    throw invalid()
  }
  return { versionDate: new Date(epochMs), id }
}

const entrySelection = {
  id: pageHistoryTable.id,
  action: pageHistoryTable.action,
  via: pageHistoryTable.via,
  changedFields: pageHistoryTable.changedFields,
  reason: pageHistoryTable.reason,
  versionDate: pageHistoryTable.versionDate,
  locale: pageHistoryTable.locale,
  path: pageHistoryTable.path,
  title: pageHistoryTable.title
}

/**
 * A null `changedFields` reads as no fields and a null `reason` as no reason, rather than either
 * surfacing as `null` in an API response.
 */
function toEntry(row: any) {
  return {
    id: row.id,
    action: row.action,
    via: row.via,
    changedFields: row.changedFields ?? [],
    reason: row.reason ?? '',
    versionDate: row.versionDate,
    locale: row.locale,
    path: row.path,
    title: row.title,
    author: {
      id: row.authorId ?? null,
      name: row.authorName ?? ''
    }
  }
}

/**
 * "Strictly after this cursor" in the `(versionDate DESC, id DESC)` order both paged reads scan in.
 *
 * Takes the columns rather than assuming `pageHistoryTable`: `listRecoverable` pages over its own
 * `DISTINCT ON` subquery, whose columns are the subquery's, not the table's.
 */
function keysetAfter(
  cols: { versionDate: PgColumn; id: PgColumn },
  cursor?: string | null
): SQL | undefined {
  if (!cursor) {
    return undefined
  }
  const after = decodeHistoryCursor(cursor)
  return or(
    lt(cols.versionDate, after.versionDate),
    and(eq(cols.versionDate, after.versionDate), lt(cols.id, after.id))
  )
}

/**
 * `all` is the union across both buckets, precomputed rather than left for a caller to add
 * `editor + mcp` together: a contributor who edited through both is one person, not two.
 */
export type PageHistoryContributorCounts = {
  editor: number
  mcp: number
  all: number
  /** Raw row counts, not `distinct authorId`, and NOT filtered to `authorId IS NOT NULL`: a
   *  since-deleted account's edits are still real rows against the page. */
  total: {
    editor: number
    mcp: number
    all: number
  }
}

/**
 * `changeCount` is ABSENT rather than zero when there is nothing to compare against — a page whose
 * only version is its creation, or one with no history at all. The metadata rail renders those as
 * `rev 1` alone, versus a `· 0 changes` clause that can never legitimately occur, so absence has to
 * stay distinguishable from a real zero all the way out to the response.
 */
export type PageRevisionSummary = {
  /** 1-based, and 1 rather than 0 for a page with no history rows at all. */
  ordinal: number
  /** Lines added plus lines removed between the newest version and the one before it. */
  changeCount?: number
  /**
   * Falls back to the column's default, `editor`, on a page whose history has been purged out from
   * under it -- there is no row left to answer from.
   */
  via: PageHistoryVia
}

/**
 * Counted off a line diff rather than off `changedFields`: the editor sends every field on every
 * save, so that column reports one changed field whether a comma moved or the page was rewritten.
 *
 * An edited line appears in both halves of the diff and is counted twice, deliberately — this is the
 * number of changed lines a unified diff would show, not of distinct source lines touched.
 */
function countChangedLines(before: string, after: string): number {
  let changed = 0
  for (const part of diffLines(before, after)) {
    if (part.added || part.removed) {
      changed += part.count ?? 0
    }
  }
  return changed
}

class PageHistory {
  /**
   * The snapshot is read from the stored row rather than taken from the caller, so what is recorded
   * is what was actually saved — not what the caller believed it was saving. For a deletion that
   * means this has to be called BEFORE the row goes.
   *
   * A failure here is logged and swallowed: losing a history entry is not a reason to fail the edit
   * that was the point of the request.
   *
   * @param changedFields Empty for a creation or a deletion, where the whole page is the change.
   * @param versionDate Dates the version in place of `now()`, for an import backdating to the
   *                     source page's real last-modified time (upstream requarks/wiki#4631).
   */
  async record({
    siteId,
    pageId,
    action,
    authorId,
    via = 'editor',
    changedFields = [],
    reason,
    versionDate
  }: {
    siteId: string
    pageId: string
    action: PageHistoryAction
    authorId: string
    via?: PageHistoryVia
    changedFields?: string[]
    reason?: string | null
    versionDate?: Date
  }): Promise<string | null> {
    try {
      const rows = await CARDINAL.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, pageId))
        .limit(1)
      const page = rows[0]
      if (!page) {
        CARDINAL.logger.warn('pages', 'cannot record page history, the page is not there', {
          page: pageId
        })
        return null
      }

      const meta: Record<string, any> = {}
      for (const [key, value] of Object.entries(page)) {
        if (!EXCLUDED_FROM_META.has(key)) {
          meta[key] = value
        }
      }

      const inserted = await CARDINAL.db
        .insert(pageHistoryTable)
        .values({
          pageId,
          siteId,
          authorId,
          action,
          via,
          changedFields,
          // -> An unanswered optional prompt sends an empty string; a version simply has no reason
          reason: reason?.trim() || null,
          locale: page.locale,
          path: page.path,
          title: page.title,
          content: page.content,
          meta,
          ...(versionDate ? { versionDate } : {})
        })
        .returning({ id: pageHistoryTable.id })

      // -> A new version moves `contributorCountsForGraph`'s edit-volume figures, so the cached
      //    graph bundle has to drop here too, not only on a page write
      invalidateGraphCache(siteId)

      return inserted[0]?.id ?? null
    } catch (err: any) {
      CARDINAL.logger.warn('pages', 'recording the page history failed', {
        page: pageId,
        error: err
      })
      return null
    }
  }

  /**
   * No content: a list of forty versions has no business carrying forty copies of the page.
   *
   * Paginated by keyset on `(versionDate, id)` rather than `OFFSET` -- a page edited daily for a
   * couple of years carries hundreds of versions, and `OFFSET` does more work for every page further
   * in, where a keyset cursor seeks in constant time off the `(pageId, versionDate)` index.
   *
   * @param options.limit A value outside `[1, max]` is clamped rather than rejected.
   */
  async list(
    siteId: string,
    pageId: string,
    options: { limit?: number; cursor?: string | null } = {}
  ): Promise<PageHistoryPage> {
    const limit = Math.min(
      Math.max(1, Math.trunc(options.limit ?? HISTORY_LIST_DEFAULT_LIMIT)),
      HISTORY_LIST_MAX_LIMIT
    )
    const rows = await CARDINAL.db
      .select({
        ...entrySelection,
        authorId: usersTable.id,
        authorName: usersTable.name
      })
      .from(pageHistoryTable)
      .leftJoin(usersTable, eq(usersTable.id, pageHistoryTable.authorId))
      .where(
        and(
          eq(pageHistoryTable.siteId, siteId),
          eq(pageHistoryTable.pageId, pageId),
          keysetAfter(pageHistoryTable, options.cursor)
        )
      )
      .orderBy(desc(pageHistoryTable.versionDate), desc(pageHistoryTable.id))
      // -> One extra row, never returned, to know whether a next page exists without a count query
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)

    return {
      items: page.map(toEntry),
      nextCursor:
        hasMore && last ? encodeHistoryCursor({ versionDate: last.versionDate, id: last.id }) : null
    }
  }

  /**
   * A since-deleted account is not counted as a synthetic "deleted user" contributor.
   * `COUNT(DISTINCT authorId)` excludes `NULL` by standard SQL aggregate semantics, so the unique
   * figures need no `WHERE` of their own, while `total.*` counts every row regardless.
   *
   * A page with no history at all is simply absent from the map.
   */
  async contributorCountsForGraph(
    siteId: string
  ): Promise<Map<string, PageHistoryContributorCounts>> {
    const isEditor = sql`${pageHistoryTable.via} = 'editor'`
    const isMcp = sql`${pageHistoryTable.via} = 'mcp'`

    const rows = await CARDINAL.db
      .select({
        pageId: pageHistoryTable.pageId,
        editor: sql<number>`count(distinct ${pageHistoryTable.authorId}) filter (where ${isEditor})::int`,
        mcp: sql<number>`count(distinct ${pageHistoryTable.authorId}) filter (where ${isMcp})::int`,
        all: sql<number>`count(distinct ${pageHistoryTable.authorId})::int`,
        totalEditor: sql<number>`count(*) filter (where ${isEditor})::int`,
        totalMcp: sql<number>`count(*) filter (where ${isMcp})::int`,
        totalAll: sql<number>`count(*)::int`
      })
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.siteId, siteId))
      .groupBy(pageHistoryTable.pageId)

    const result = new Map<string, PageHistoryContributorCounts>()
    for (const row of rows) {
      result.set(row.pageId, {
        editor: row.editor,
        mcp: row.mcp,
        all: row.all,
        total: { editor: row.totalEditor, mcp: row.totalMcp, all: row.totalAll }
      })
    }
    return result
  }

  /**
   * Answered as part of a page read rather than as a request of its own.
   *
   * Two narrow reads rather than one windowed query, both served by `pageHistory_pageId_idx`: a
   * `count(*) over ()` would fold them into one statement, but a window is computed over every
   * matching row before `LIMIT` applies — so a page with hundreds of versions would drag all of
   * their bodies through the sort to answer a question about two of them.
   *
   * Ordered `(versionDate DESC, id DESC)`, the same tie-break {@link keysetAfter} pages in, so two
   * versions written inside the same millisecond still order deterministically.
   *
   * Not site-scoped, unlike the reads around it: `pageId` is a uuid primary key and every caller has
   * already resolved the page within its site.
   */
  async revisionSummary(pageId: string): Promise<PageRevisionSummary> {
    const [totals, newest] = await Promise.all([
      CARDINAL.db
        .select({ total: sql<number>`count(*)::int` })
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, pageId)),
      CARDINAL.db
        .select({ content: pageHistoryTable.content, via: pageHistoryTable.via })
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, pageId))
        .orderBy(desc(pageHistoryTable.versionDate), desc(pageHistoryTable.id))
        .limit(2)
    ])
    // -> A page with no history at all is still on its first version, so the floor is 1, not 0
    const ordinal = Math.max(totals[0]?.total ?? 0, 1)
    const via = (newest[0]?.via ?? 'editor') as PageHistoryVia
    // -> Nothing before it to differ from: the clause is omitted, never sent as a zero
    if (newest.length < 2) {
      return { ordinal, via }
    }
    return {
      ordinal,
      via,
      // -> `content` is nullable, and a version that held no source contributes no lines
      changeCount: countChangedLines(newest[1]!.content ?? '', newest[0]!.content ?? '')
    }
  }

  async getVersion(
    siteId: string,
    pageId: string,
    versionId: string
  ): Promise<PageHistoryVersion | null> {
    const rows = await CARDINAL.db
      .select({
        ...entrySelection,
        content: pageHistoryTable.content,
        meta: pageHistoryTable.meta,
        authorId: usersTable.id,
        authorName: usersTable.name,
        authorEmail: usersTable.email
      })
      .from(pageHistoryTable)
      .leftJoin(usersTable, eq(usersTable.id, pageHistoryTable.authorId))
      .where(
        and(
          eq(pageHistoryTable.siteId, siteId),
          eq(pageHistoryTable.pageId, pageId),
          eq(pageHistoryTable.id, versionId)
        )
      )
      .limit(1)

    const row: any = rows[0]
    if (!row) {
      return null
    }
    const entry = toEntry(row)
    return {
      ...entry,
      content: row.content ?? '',
      meta: (row.meta ?? {}) as Record<string, any>,
      // -> The one place an author's email is disclosed: a diff names who wrote the side being
      //    compared, which the list view has no need for
      author: { ...entry.author, email: row.authorEmail ?? '' }
    }
  }

  /**
   * A path can be deleted more than once (deleted, recreated, deleted again), so this is not simply
   * "every `deleted` row": `DISTINCT ON (locale, path)` collapses that down to the most recent
   * deletion, and a live `pages` row at the same `(siteId, locale, path)` excludes it via
   * `NOT EXISTS`. A path therefore drops off this list the moment it stops being an actual gap, with
   * no flag to set or clear anywhere.
   *
   * Postgres requires a `DISTINCT ON`'s columns to lead its own `ORDER BY`, which rules out ordering
   * that collapse by `versionDate` — the one thing a keyset cursor pages against. Hence the derived
   * subquery, with the `(versionDate, id)` keyset ordering in the outer query over its rows.
   *
   * The `read:history` filter runs afterwards, in JS at the route: it is checked per row against a
   * page-rule tree, not a column value, so it cannot be pushed into this SQL. `nextCursor` is
   * computed before that filter runs — see {@link PageHistoryRecoverablePage}.
   */
  async listRecoverable(
    siteId: string,
    { limit = RECOVERABLE_LIST_DEFAULT_LIMIT, cursor }: { limit?: number; cursor?: string } = {}
  ): Promise<PageHistoryRecoverablePage> {
    const boundedLimit = Math.min(Math.max(1, limit), RECOVERABLE_LIST_MAX_LIMIT)

    const recoverable = CARDINAL.db
      .selectDistinctOn([pageHistoryTable.locale, pageHistoryTable.path], {
        ...entrySelection,
        meta: pageHistoryTable.meta,
        authorId: pageHistoryTable.authorId
      })
      .from(pageHistoryTable)
      .where(
        and(
          eq(pageHistoryTable.siteId, siteId),
          eq(pageHistoryTable.action, 'deleted'),
          notExists(
            CARDINAL.db
              .select({ exists: sql`1` })
              .from(pagesTable)
              .where(
                and(
                  eq(pagesTable.siteId, siteId),
                  eq(pagesTable.locale, pageHistoryTable.locale),
                  eq(pagesTable.path, pageHistoryTable.path)
                )
              )
          )
        )
      )
      .orderBy(pageHistoryTable.locale, pageHistoryTable.path, desc(pageHistoryTable.versionDate))
      .as('recoverable')

    const rows = await CARDINAL.db
      .select({
        id: recoverable.id,
        action: recoverable.action,
        via: recoverable.via,
        changedFields: recoverable.changedFields,
        reason: recoverable.reason,
        versionDate: recoverable.versionDate,
        locale: recoverable.locale,
        path: recoverable.path,
        title: recoverable.title,
        meta: recoverable.meta,
        authorId: usersTable.id,
        authorName: usersTable.name
      })
      .from(recoverable)
      .leftJoin(usersTable, eq(usersTable.id, recoverable.authorId))
      .where(keysetAfter(recoverable, cursor))
      .orderBy(desc(recoverable.versionDate), desc(recoverable.id))
      // -> One extra row, never returned, to tell whether a further page exists
      .limit(boundedLimit + 1)

    const hasMore = rows.length > boundedLimit
    const page = hasMore ? rows.slice(0, boundedLimit) : rows
    const last = page.at(-1)

    return {
      items: page.map((row: any) => {
        // -> Lifted out of the snapshot, not a live page row: the page is gone, and what a recovery
        //    offers back is what it was classified and tagged as when it went
        const meta = (row.meta ?? {}) as Record<string, any>
        return {
          ...toEntry(row),
          tags: (meta.tags ?? []) as string[],
          classification: (meta.classification ?? null) as string | null
        }
      }),
      nextCursor:
        hasMore && last ? encodeHistoryCursor({ versionDate: last.versionDate, id: last.id }) : null
    }
  }

  /**
   * Exposed separately so a caller can inspect a version before deciding to recover it: the route
   * checks `read:pages`/`read:source` against the version's OWN path — recovering into a writable
   * destination is not the same as being allowed to read what is being recovered — and `write:pages`
   * against the target path. `tags`/`classification` are lifted out of `meta` as named fields so
   * that source-side check can be narrowed by a TAG/TAGALL/CLASSIFICATION rule like any other.
   */
  async getDeletedVersion(
    siteId: string,
    versionId: string
  ): Promise<{
    path: string
    locale: string
    title: string
    content: string
    tags: string[]
    classification: string | null
    meta: Record<string, any>
  } | null> {
    const rows = await CARDINAL.db
      .select({
        path: pageHistoryTable.path,
        locale: pageHistoryTable.locale,
        title: pageHistoryTable.title,
        content: pageHistoryTable.content,
        meta: pageHistoryTable.meta
      })
      .from(pageHistoryTable)
      .where(
        and(
          eq(pageHistoryTable.siteId, siteId),
          eq(pageHistoryTable.id, versionId),
          eq(pageHistoryTable.action, 'deleted')
        )
      )
      .limit(1)

    const row: any = rows[0]
    if (!row) {
      return null
    }
    const meta = (row.meta ?? {}) as Record<string, any>
    return {
      path: row.path,
      locale: row.locale,
      title: row.title,
      content: row.content ?? '',
      tags: (meta.tags ?? []) as string[],
      classification: (meta.classification ?? null) as string | null,
      meta
    }
  }

  /**
   * Looked up by `id` rather than "the latest deletion at this path", so a caller acting on a
   * {@link listRecoverable} row recovers exactly the version it showed — not whatever happens to be
   * newest by the time the request lands.
   *
   * The reconstructed input goes through `createPage`, not a direct write: duplicate-path,
   * empty-title and empty-content checks belong to it already. `overrides` exists for the cases
   * those checks would reject unchanged — a path a newer page has since taken, or a locale the site
   * no longer has.
   *
   * The classification the page held when deleted is carried rather than left to `createPage`'s
   * fallback: a page classified `Restricted` and deleted must not come back `Public`. No `render` is
   * carried — a deleted version never stored the rendered HTML — so `createPage()` confirms up front
   * that this instance can render at all, then queues the re-render itself.
   */
  async recoverDeletedPage(
    siteId: string,
    versionId: string,
    actor: PageActor,
    overrides?: { path?: string; locale?: string }
  ): Promise<Page> {
    const row = await this.getDeletedVersion(siteId, versionId)
    if (!row) {
      throw new CustomError(
        'pageHistoryVersionNotFound',
        'No deleted version exists with this id.',
        404
      )
    }

    const meta = row.meta
    const config = (meta.config ?? {}) as Record<string, any>

    // -> `meta.password` is already a `bcrypt` verifier, so it is kept out of `input` below and
    //    written to the row afterwards: `createPage()` hashes its own `password` field, and hashing
    //    the hash would silently lock the recovered page behind a password nobody can type.
    const input: PageInput = {
      path: overrides?.path ?? row.path,
      locale: overrides?.locale ?? row.locale,
      title: row.title,
      editor: meta.editor,
      content: row.content ?? '',
      description: meta.description,
      icon: meta.icon,
      alias: meta.alias,
      // -> Still validated against the *destination* parent's floor -- `overrides.path` can move the
      //    page under a stricter branch -- so a recovery that can no longer honor the original level
      //    throws rather than silently reopening it
      classification: meta.classification,
      publishState: meta.publishState,
      publishStartDate: meta.publishStartDate ?? null,
      publishEndDate: meta.publishEndDate ?? null,
      isBrowsable: meta.isBrowsable,
      isSearchable: meta.isSearchable,
      relations: meta.relations ?? [],
      tags: meta.tags ?? [],
      allowComments: config.allowComments,
      allowContributions: config.allowContributions,
      showSidebar: config.showSidebar,
      showTags: config.showTags,
      showToc: config.showToc,
      tocDepth: config.tocDepth
    }

    // -> `origin` changes nothing about what is written -- it is the one bit of provenance
    //    `createPage()` cannot infer, and only picks `restored` over `created` on the lifecycle line
    const page = await CARDINAL.models.pages.createPage(siteId, input, actor, { origin: 'restore' })
    if (meta.password) {
      await CARDINAL.db
        .update(pagesTable)
        .set({ password: meta.password })
        .where(eq(pagesTable.id, page.id))
    }

    if (meta.password) {
      return (await CARDINAL.models.pages.getPage({ siteId, id: page.id })) as Page
    }
    return page
  }

  /**
   * A page's own row holds what it says now, so this changes nothing anybody reads — it shortens
   * timelines and takes away what a page can be rolled back to. A page whose every version predates
   * the cutoff keeps the page and loses its history entirely, `created` row included.
   *
   * What it does not spare is a page that no longer exists: its versions outlive it deliberately and
   * are all that is left of it, so purging past the day it was deleted is what finally discards it.
   * There is nothing to undo this with.
   *
   * Needs none of `core/maintenance.ts`'s HA handling: there is no per-instance copy of a history row
   * to fall out of step, so the next `SELECT` on any instance simply doesn't see the rows.
   */
  async purge(olderThan: PurgeTimeframe): Promise<number> {
    const interval = purgeTimeframes[olderThan]
    const result = await CARDINAL.db
      .delete(pageHistoryTable)
      // -> Bound as a parameter and cast rather than interpolated: the value is off a closed list,
      //    but a raw fragment built from a request is a habit worth not having
      .where(lt(pageHistoryTable.versionDate, sql`now() - ${interval}::interval`))
    const purged = result.rowCount ?? 0
    // -> Silent at `info` when there was nothing to purge: this runs on a schedule, and a daily line
    //    saying `0` is what trains an operator to stop reading the log
    if (purged > 0) {
      CARDINAL.logger.info('pages', 'purged old page versions', {
        versions: purged,
        olderThan: interval
      })
    } else {
      CARDINAL.logger.debug('pages', 'no page versions to purge', { olderThan: interval })
    }
    return purged
  }

  /**
   * Compared against the stored row rather than taken from the patch keys: the editor sends every
   * field on every save, which would otherwise record every field as changed on every version. Both
   * arguments are keyed as the page stores its columns.
   */
  changedFields(existing: Record<string, any>, patch: Record<string, any>): string[] {
    const changed: string[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !(key in existing) || NOT_REPORTED_AS_CHANGED.has(key)) {
        continue
      }
      /*
        Deep rather than `===`: tags, relations and the config blobs are arrays and objects, and
        comparing those by reference reports every save as a change to all of them.

        Not `JSON.stringify` either: postgres returns a `jsonb` column's keys in its own order — by
        length, then bytewise — which does not match the order the object was built in, so two
        identical objects serialise to two different strings.
      */
      if (!isEqual(existing[key], value)) {
        changed.push(key)
      }
    }
    return changed.sort()
  }
}

export const pageHistory = new PageHistory()
