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

/** The default page size for {@link PageHistory.list}, and its hard cap. */
const HISTORY_LIST_DEFAULT_LIMIT = 50
const HISTORY_LIST_MAX_LIMIT = 200

/**
 * The kinds of change a history row records.
 *
 * `created` and `deleted` are the two ends of a page's life; `moved` is a change of path or title,
 * which is worth telling apart from an ordinary edit because it is what breaks links; `updated` is
 * everything else, content and metadata alike.
 */
export const pageHistoryActions = ['created', 'updated', 'moved', 'deleted'] as const

export type PageHistoryAction = (typeof pageHistoryActions)[number]

/**
 * What actually made a change: someone using the standard editor (the REST API a browser saves
 * through), or an MCP tool call acting on their behalf (OpenProject #1119 -- "did Dylan write this, or
 * did an agent acting as Dylan write this"). Kept alongside `action` rather than folded into it: this
 * is a second, orthogonal axis (what changed vs. what wrote it), and every existing `action` value is
 * still possible either way.
 */
export const pageHistoryVia = ['editor', 'mcp'] as const

export type PageHistoryVia = (typeof pageHistoryVia)[number]

/**
 * How far back the admin area's purge can be told to keep, and the interval each answer means.
 *
 * The values are postgres intervals rather than a duration computed here, so that the cutoff is
 * measured against the same clock the rows were written by: `versionDate` takes the column default,
 * which is `now()`, and a timestamp column carries no offset to reconcile a date computed in this
 * process against. It also gets the calendar arithmetic for free — a month is a month, whichever one
 * it lands in.
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
 * The page fields a version carries beyond the ones with columns of their own.
 *
 * Taken straight off the stored row, so a field added to a page is captured here without this list
 * being touched. The exclusions are either derived from the content (`render`, `toc`, `searchContent`,
 * `ts`), fixed for the page's whole life (`id`, `siteId`, `creatorId`, `createdAt`), or bookkeeping
 * that says nothing about the version (`hash`, `updatedAt`, `authorId`, `historyData`,
 * `isSearchableComputed`).
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
 * Fields a change is never reported as having touched.
 *
 * Either derived from the content (a render moves whenever the source does, and saying so twice tells
 * a reader nothing) or bookkeeping that moves on every save regardless.
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

/** Who a version is attributed to. Null once that account is gone; the version stays. */
export type PageHistoryAuthor = {
  id: string | null
  name: string
  email: string
}

/** A version as a timeline shows it: what happened, when, and to whom — but not the source. */
export type PageHistoryEntry = {
  id: string
  action: string
  /** `editor` or `mcp` -- see `pageHistoryVia`'s own doc comment. */
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

/** A version in full, source included. */
export type PageHistoryVersion = PageHistoryEntry & {
  content: string
  meta: Record<string, any>
}

/**
 * A row of {@link PageHistory.listRecoverable} — deliberately NOT `PageHistoryEntry`, in two ways
 * (OpenProject #2168): it carries `tags`/`classification` so the route can narrow the per-row
 * `read:history` check with the same TAG/TAGALL/CLASSIFICATION rules any other read of the page
 * would apply, not just a bare path/locale match; and its `author` carries no `email` at all, which
 * `PageHistoryEntry.author` normally does for an ordinary (still-live-page) history timeline where
 * `read:history` on the page already gates it. This listing exists precisely so a caller who does
 * NOT hold `read:pages` at the deleted path can still discover that something recoverable is there
 * -- handing back the deleting/creating author's email address on every row would leak PII to a
 * reader `read:history` was never meant to give it to.
 */
export type RecoverablePageEntry = Omit<PageHistoryEntry, 'author'> & {
  tags: string[]
  classification: string | null
  author: Omit<PageHistoryAuthor, 'email'>
}

/**
 * Who a version is attributed to, as {@link PageHistory.list} reports it -- name only.
 *
 * `list()` is what a page's whole timeline is read through, potentially hundreds of rows at once
 * (see {@link PageHistory.list}'s own doc comment), and nothing on the frontend reads an author's
 * address off it (`PageHistoryOverlay.vue` reads only `.author.name`) -- so the email a `getVersion()`
 * or `listRecoverable()` row still carries is left out of this one's projection entirely, rather than
 * fetched and thrown away.
 */
export type PageHistoryListAuthor = Omit<PageHistoryAuthor, 'email'>

/** A version as {@link PageHistory.list} reports it -- {@link PageHistoryEntry} minus the author's email. */
export type PageHistoryListEntry = Omit<PageHistoryEntry, 'author'> & {
  author: PageHistoryListAuthor
}

/** One page of {@link PageHistory.list}'s keyset-paginated results. */
export type PageHistoryPage = {
  /** Newest first, same ordering as the unpaginated list used to return. */
  items: PageHistoryListEntry[]
  /** Pass back as `cursor` to fetch the next page. Null once there is nothing older left. */
  nextCursor: string | null
}

/**
 * One page of {@link PageHistory.listRecoverable}'s keyset-paginated results.
 *
 * `nextCursor` is derived strictly from where the underlying `versionDate`/`id` keyset scan actually
 * stopped, BEFORE the route's per-row `read:history` filter runs -- so `items` can come back shorter
 * than the requested `limit` (some rows filtered out) while `nextCursor` still correctly says there is
 * more to page through. A caller decides whether it has reached the end by `nextCursor === null`, never
 * by `items.length < limit`.
 */
export type PageHistoryRecoverablePage = {
  items: RecoverablePageEntry[]
  nextCursor: string | null
}

/** The default page size for {@link PageHistory.listRecoverable}, and its hard cap. */
const RECOVERABLE_LIST_DEFAULT_LIMIT = 50
const RECOVERABLE_LIST_MAX_LIMIT = 200

/** The parts of a cursor: the last row's `versionDate` and `id`, in the same order the query sorts by. */
type HistoryCursor = {
  versionDate: Date
  id: string
}

/**
 * Turn a page's last row into an opaque cursor a caller can hand back for the next page.
 *
 * Encodes `versionDate` (millisecond precision -- what postgres actually stores, so a round trip
 * through this never disagrees with the row it came from) and `id` together, since the query orders
 * by both: several versions can share one `versionDate` on a page saved twice in the same
 * millisecond, and `id` is what keeps their relative order stable across pages. Shared by
 * {@link PageHistory.list} and {@link PageHistory.listRecoverable} -- both keyset-paginate the same
 * `(versionDate, id)` shape, just over different underlying scans.
 */
function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${cursor.versionDate.getTime()}|${cursor.id}`, 'utf8').toString('base64url')
}

/**
 * The inverse of {@link encodeHistoryCursor}.
 *
 * @throws {CustomError} `pageHistoryInvalidCursor` (400) if `raw` does not decode to a well-formed
 *         cursor -- a tampered or truncated value, not a case the caller can otherwise trigger by
 *         paging normally.
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

/**
 * The nine columns every history read starts from: what happened, when, through what, and where the
 * page was at the time. `list`, `getVersion` and `listRecoverable`'s inner scan each spread this and
 * add only what is theirs — the source and the author's email for a diff, the `meta` blob a
 * recoverable entry lifts tags and classification out of.
 */
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
 * An {@link entrySelection} row plus its joined author, as an entry.
 *
 * The defaulting is the part worth having in one place: a null `changedFields` reads as no fields, a
 * null `reason` as no reason, and a null author id as an account that is gone — the version outlives
 * it, see that column's own note — rather than any of the three surfacing as `null`/`undefined` in an
 * API response.
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
      // -> Null once the account is gone: the version outlives it, see the column's own note
      id: row.authorId ?? null,
      name: row.authorName ?? ''
    }
  }
}

/**
 * The keyset predicate for "strictly after this cursor" in the `(versionDate DESC, id DESC)` order
 * both paged reads scan in, or `undefined` for the first page.
 *
 * Takes the columns rather than assuming `pageHistoryTable`: `listRecoverable` pages over its own
 * `DISTINCT ON` subquery, whose columns are the subquery's, not the table's.
 *
 * @throws {CustomError} `pageHistoryInvalidCursor` (400), from {@link decodeHistoryCursor}
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
 * Unique-contributor counts for one page, split by `via` (OpenProject #1141's edit-volume node
 * sizing) -- `editor`/`mcp` are `pageHistory.via`'s own two buckets, and `all` is the union across
 * both, precomputed here rather than left for a caller to add `editor + mcp` together: a
 * contributor who edited through both would then be double-counted, since they are one person
 * appearing in both buckets, not two.
 */
export type PageHistoryContributorCounts = {
  editor: number
  mcp: number
  all: number
  /** Raw history-row counts (not `distinct authorId`) for the same `via` split, OpenProject #1269's
   *  counterpart to the unique counts above -- for the frontend's Unique/Total sizing toggle
   *  (#1270). Unlike `all` above, this is NOT filtered to `authorId IS NOT NULL`: a since-deleted
   *  account's edits are still real rows against the page, they just aren't attributable to a
   *  distinct person any more -- see `contributorCountsForGraph()`'s own doc comment. */
  total: {
    editor: number
    mcp: number
    all: number
  }
}

/**
 * Where a page stands in its own history, for the metadata rail's Revision section (OpenProject
 * #2651): which version this is, and how much the change that produced it moved.
 *
 * `changeCount` is ABSENT rather than zero when there is nothing to compare against — a page whose
 * only version is its creation, or one with no history at all. The two are rendered differently
 * (`rev 1` alone, versus a `· 0 changes` clause that can never legitimately occur), so the shape has
 * to keep absence distinguishable from a real zero all the way out to the response.
 */
export type PageRevisionSummary = {
  /** 1-based, `count(*)` of this page's history rows -- and 1, not 0, for a page with none. */
  ordinal: number
  /** Lines added plus lines removed between the newest version and the one before it. */
  changeCount?: number
}

/**
 * Lines added plus lines removed going from `before` to `after` — what the rail calls "M changes".
 *
 * Counted off a line diff rather than off `changedFields`: the editor sends every field on every
 * save, so that column reports one changed field for a typical content edit whether a comma moved
 * or the page was rewritten, which says nothing about the size of the change.
 *
 * A line that was edited rather than added or removed appears in both halves of the diff — once
 * removed, once added — and is counted twice, deliberately: this is a count of changed diff lines,
 * the number a unified diff would show, not of distinct source lines touched.
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

/**
 * Page history model
 *
 * Records a version of a page every time one changes, and reads those versions back for the history
 * view — which lists them and diffs any two against each other. Restoring one, and recovering a page
 * that was deleted, are still to come.
 */
class PageHistory {
  /**
   * Record what a page looks like now, as a new version.
   *
   * The snapshot is read from the stored row rather than taken from the caller, so that what is
   * recorded is what was actually saved — not what the caller believed it was saving. For a deletion
   * that means this has to be called BEFORE the row goes.
   *
   * A failure here is logged and swallowed: history is a record of what happened, and losing an entry
   * is not a reason to fail the edit that was the point of the request.
   *
   * @param authorId Who made the change. Kept on the row until that account is deleted, at which
   *                 point the version survives with no author rather than blocking the deletion.
   * @param via What actually made the change -- `editor` (the default; every REST-API-driven save,
   *            which is every caller except the MCP write tools) or `mcp`. See `pageHistoryVia`'s own
   *            doc comment.
   * @param changedFields Which fields the change touched. Empty for a creation or a deletion, where
   *                      the whole page is the change.
   * @param reason Why, in the author's words, when the site asks for one.
   * @param versionDate When to date this version, in place of `now()`. Only ever supplied by
   *                     `createPage()` (`backend/models/pages.ts`, passed `PageInput.updatedAt`),
   *                     backdating the one `record()` call it makes to a source page's real
   *                     last-modified time instead of stamping it with import time — see upstream
   *                     requarks/wiki#4631, the bug this exists to not repeat. Every other caller
   *                     (`updatePage`/`movePage`/`deletePage`/restore) omits it and keeps the
   *                     unchanged `now()` behavior.
   * @returns The version's ID, or null when nothing was recorded
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
      const rows = await WIKI.db.select().from(pagesTable).where(eq(pagesTable.id, pageId)).limit(1)
      const page = rows[0]
      if (!page) {
        WIKI.logger.warn('pages', 'cannot record page history, the page is not there', {
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

      const inserted = await WIKI.db
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

      // -> A new version changes `contributorCountsForGraph`'s edit-volume figures for this page --
      //    the cached graph bundle (`helpers/graphCache.ts`) has to drop, not just `models/pages.ts`'s
      //    own writes above.
      invalidateGraphCache(siteId)

      return inserted[0]?.id ?? null
    } catch (err: any) {
      WIKI.logger.warn('pages', 'recording the page history failed', { page: pageId, error: err })
      return null
    }
  }

  /**
   * A page's versions, newest first — the order a timeline reads in, one page of it at a time.
   *
   * The newest row is the page as it stands: it was written after the change that produced the state
   * the page is in now. No content here; a list of forty versions has no business carrying forty
   * copies of the page.
   *
   * Paginated by keyset on `(versionDate, id)` rather than `OFFSET` -- a page edited daily for a
   * couple of years carries hundreds of versions, and `OFFSET` degrades exactly there, doing more
   * work for every page further in rather than the constant-time seek a keyset cursor gets from the
   * `(pageId, versionDate)` index. `cursor`, when given, is the opaque token a previous call's
   * `nextCursor` returned; omitted, this starts from the newest version.
   *
   * @param options.limit Rows per page. Defaults to {@link HISTORY_LIST_DEFAULT_LIMIT}, capped at
   *                       {@link HISTORY_LIST_MAX_LIMIT}; a value outside `[1, max]` is clamped rather
   *                       than rejected.
   * @param options.cursor Opaque cursor from a previous call's `nextCursor`. Omitted or null starts
   *                        from the newest version.
   * @throws {CustomError} `pageHistoryInvalidCursor` (400) if `cursor` does not decode -- see
   *         {@link decodeHistoryCursor}.
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
    const rows = await WIKI.db
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
      // -> One extra row, never returned, just to know whether a next page exists without a second
      //    (count) query
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
   * Unique-contributor counts per page across a whole site, for the knowledge graph's edit-volume
   * node sizing (OpenProject #1141).
   *
   * `authorId IS NOT NULL` is filtered out of every count rather than counted as a synthetic
   * "deleted user" contributor, per the feature's own scope decision: a since-deleted account's
   * edits still count toward `pageHistory` rows existing, just not toward how many distinct people
   * they came from.
   *
   * One aggregate query, not three (OpenProject #2269): every figure below is a `FILTER`-qualified
   * aggregate over a single `GROUP BY pageId` pass, rather than a separate `GROUP BY pageId, via`
   * query for the per-`via` split plus a second `GROUP BY pageId` alone for the site-wide-distinct
   * `all` figure plus a third for the unfiltered row-count `total`. `COUNT(DISTINCT authorId)`
   * already excludes `NULL` on its own — standard SQL aggregate semantics, not something a `WHERE
   * authorId IS NOT NULL` needs to do first — so `editor`/`mcp`/`all` need no such filter, while
   * `total.*` deliberately counts every row regardless of `authorId`: a since-deleted account's
   * edits are still real rows against the page, they just aren't attributable to a distinct person
   * any more.
   *
   * @returns A map keyed by `pageId`. A page with no history at all (should not happen in practice --
   *          every page gets a `created` row -- but not a case worth throwing over) is simply absent;
   *          callers default a missing entry to all-zero.
   */
  async contributorCountsForGraph(
    siteId: string
  ): Promise<Map<string, PageHistoryContributorCounts>> {
    const isEditor = sql`${pageHistoryTable.via} = 'editor'`
    const isMcp = sql`${pageHistoryTable.via} = 'mcp'`

    const rows = await WIKI.db
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
   * Where a page stands in its own history: the `rev N · M changes` the page metadata rail draws
   * (OpenProject #2651), answered as part of a page read rather than as a request of its own.
   *
   * Two narrow reads rather than one windowed query, both served by `pageHistory_pageId_idx`: a
   * `count(*)` for the ordinal, and the two newest versions' sources for the diff. A single
   * `count(*) over ()` would fold them into one statement, but a window is computed over every
   * matching row before `LIMIT` applies — so a page with hundreds of versions would drag all of
   * their bodies through the sort to answer a question about two of them.
   *
   * Ordered `(versionDate DESC, id DESC)`, the same tie-break {@link keysetAfter} pages in, so two
   * versions written inside the same millisecond still order deterministically.
   *
   * Not site-scoped, unlike the reads around it: `pageId` is a uuid primary key, and every caller
   * has already resolved the page within its site before it has an id to pass, so a `siteId`
   * predicate here could only narrow a set of one.
   */
  async revisionSummary(pageId: string): Promise<PageRevisionSummary> {
    const [totals, newest] = await Promise.all([
      WIKI.db
        .select({ total: sql<number>`count(*)::int` })
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, pageId)),
      WIKI.db
        .select({ content: pageHistoryTable.content })
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, pageId))
        .orderBy(desc(pageHistoryTable.versionDate), desc(pageHistoryTable.id))
        .limit(2)
    ])
    // -> A page with no history at all is still on its first version, so the floor is 1, not 0
    const ordinal = Math.max(totals[0]?.total ?? 0, 1)
    // -> Nothing before it to differ from: the clause is omitted, never sent as a zero
    if (newest.length < 2) {
      return { ordinal }
    }
    return {
      ordinal,
      // -> `content` is nullable, and a version that held no source contributes no lines
      changeCount: countChangedLines(newest[1]!.content ?? '', newest[0]!.content ?? '')
    }
  }

  /**
   * One version, with the source it held — the side of a diff.
   *
   * @returns The version, or null when this page has no such version
   */
  async getVersion(
    siteId: string,
    pageId: string,
    versionId: string
  ): Promise<PageHistoryVersion | null> {
    const rows = await WIKI.db
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
   * Every deletion a site could still recover from — one row per path, newest first, paginated.
   *
   * A path can be deleted more than once (deleted, recreated, deleted again), so this is not simply
   * "every `deleted` row": the inner query is `DISTINCT ON (locale, path)`, newest `versionDate`
   * first, which collapses that history down to the most recent deletion. And a path that was
   * recovered, or reused by an unrelated new page, is not something to offer recovery into — a live
   * `pages` row at the same `(siteId, locale, path)` excludes it via `NOT EXISTS`. Between the two, a
   * path drops off this list the moment it stops being an actual gap, with no flag to set or clear
   * anywhere.
   *
   * Postgres requires a `DISTINCT ON`'s columns to lead its own `ORDER BY`, which rules out ordering
   * that inner collapse itself by `versionDate` — the one thing a keyset cursor needs to page against.
   * So the collapse happens in a derived subquery (still ordered `locale, path, versionDate desc`, to
   * keep the newest version per path), and this method's own `versionDate`/`id` keyset ordering and
   * pagination run in the outer query over that subquery's already-collapsed rows — the same
   * `versionDate` keyset shape `list()`'s own pagination uses (OpenProject #1859), just one query
   * deeper.
   *
   * Returns `RecoverablePageEntry` rows, not `PageHistoryEntry` (OpenProject #2168): `tags`/
   * `classification` ride along -- lifted out of `meta` the same way `getDeletedVersion` does -- so
   * the route can narrow its per-row `read:history` check with a TAG/TAGALL/CLASSIFICATION rule
   * instead of the bare `{ path, locale }` ref it used to build, and `author.email` is dropped: unlike
   * a single page's own history view (gated by `read:history` at that ONE page), this listing spans
   * every deleted path on the site in one sweep, and handing back every deleter's email address across
   * the whole site is a wider exposure than the entry needs to serve its purpose.
   *
   * The `read:history` permission filter runs afterwards, in JS, at the route
   * (`GET .../pages/deleted`) — it cannot be pushed into this SQL because it is checked per row
   * against a page-rule tree, not a column value. `nextCursor` is computed from where this method's
   * own scan stopped, before that filter runs, so a caller paging via `nextCursor` never mistakes a
   * page shortened by the permission filter for the actual end of the list — see
   * {@link PageHistoryRecoverablePage}'s own doc comment.
   */
  async listRecoverable(
    siteId: string,
    { limit = RECOVERABLE_LIST_DEFAULT_LIMIT, cursor }: { limit?: number; cursor?: string } = {}
  ): Promise<PageHistoryRecoverablePage> {
    const boundedLimit = Math.min(Math.max(1, limit), RECOVERABLE_LIST_MAX_LIMIT)

    const recoverable = WIKI.db
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
            WIKI.db
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

    const rows = await WIKI.db
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
      // -> One extra row, never returned, just to tell whether a further page exists
      .limit(boundedLimit + 1)

    const hasMore = rows.length > boundedLimit
    const page = hasMore ? rows.slice(0, boundedLimit) : rows
    const last = page.at(-1)

    return {
      items: page.map((row: any) => {
        // -> Lifted out of the snapshot rather than read off a live page row: the page is gone, and
        //    what a recovery offers back is what it was classified and tagged as when it went
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
   * One deleted version by id, in full — the row {@link recoverDeletedPage} rebuilds a page from.
   *
   * Exposed separately from `recoverDeletedPage` so a caller can inspect a version — its path and
   * locale, most usefully — before deciding whether to actually recover it. The REST route asks this
   * first, to check `read:pages`/`read:source` against the version's OWN path (OpenProject #2168 --
   * recovering into a writable destination is not the same as being allowed to read what is being
   * recovered) and `write:pages` against the *target* path ahead of the write, and to answer 404
   * cleanly for an id that names no recoverable version. `tags`/`classification` are the version's
   * own, as stored on the deletion, so that source-side check can be narrowed by a TAG/TAGALL/
   * CLASSIFICATION rule the same way any other page-permission check is.
   *
   * `tags`/`classification` are pulled out of `meta` alongside the always-present fields, so a caller
   * can build a full `RulePageRef` without reaching into `meta` itself — the same reasoning
   * `recoverDeletedPage` below already applies to `tags` when rebuilding the page.
   *
   * @returns The version, or null when no `deleted` version exists at this id for this site.
   */
  async getDeletedVersion(
    siteId: string,
    versionId: string
  ): Promise<{
    path: string
    locale: string
    title: string
    content: string
    /**
     * The version's own tags/classification (OpenProject #2168), lifted out of `meta` as named fields
     * rather than left for the caller to reach in for -- neither is `EXCLUDED_FROM_META`, so both
     * already travel with every version; this is what `api/pages/history.ts`'s recover route checks
     * `read:pages`/`read:source` against at the SOURCE path, before its existing `write:pages` check
     * against the destination.
     */
    tags: string[]
    classification: string | null
    meta: Record<string, any>
  } | null> {
    const rows = await WIKI.db
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
   * Bring a deleted page back, as a new page built from one specific deleted version.
   *
   * Looked up by `id` rather than "the latest deletion at this path", so a caller acting on a
   * {@link listRecoverable} row recovers exactly the version it showed — not whatever happens to be
   * newest by the time the request lands.
   *
   * The reconstructed input is driven through {@link WIKI.models.pages.createPage}, not written
   * directly: duplicate-path, empty-title and empty-content checks all belong to `createPage` already,
   * and re-deciding them here would be a second copy of the same rules to keep in sync. `overrides`
   * exists for exactly the cases that check would reject unchanged — a path a newer page has since
   * taken, or a locale the site no longer has — so a caller can steer the recreated page around the
   * conflict instead of recovery being an all-or-nothing retry of the exact same input.
   *
   * Carries the classification the page held when it was deleted (OpenProject #1672), rather than
   * letting `createPage` fall back to the destination's floor or the instance default -- a page
   * classified `Restricted` and deleted must not come back `Public`. `input` below carries no
   * `render` -- a deleted version's row never stored the rendered HTML (only `EXCLUDED_FROM_META`
   * fields are derived, and `render`/`toc`/`searchContent` are among them) -- so `createPage()` itself
   * (OpenProject #1716) confirms up front that this instance can render the page at all, then queues
   * the re-render once the row exists; there is nothing left for this method to do after the call
   * (OpenProject #1723).
   *
   * @throws If no `deleted` version exists at this id for this site, or (via `createPage()`'s own
   *   up-front check) if nothing here could ever render the recovered page.
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

    // -> `meta.password`, when present, is already a `bcrypt` verifier (OpenProject #2232) copied
    //    verbatim off the deleted row's own `password` column -- not a plaintext to hash again. It is
    //    deliberately left out of `input` below: `createPage()`'s `password` field is a fresh
    //    plaintext that it hashes itself, and feeding it an already-hashed value would hash the hash,
    //    silently locking the recovered page behind a password nobody can ever type. It is written
    //    straight to the new row's `password` column instead, once the id exists to write it to.
    const input: PageInput = {
      path: overrides?.path ?? row.path,
      locale: overrides?.locale ?? row.locale,
      title: row.title,
      editor: meta.editor,
      content: row.content ?? '',
      description: meta.description,
      icon: meta.icon,
      alias: meta.alias,
      // -> The level the page held when it was deleted (OpenProject #1672). `resolveCreateClassification`
      //    still validates it against the *destination* parent's floor -- `overrides.path` can move the
      //    page under a stricter branch -- so a recovery that can no longer honor the original level
      //    throws `classificationInvalid`/`classificationBelowFloor` instead of silently reopening it.
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

    // -> `origin: 'restore'` changes nothing about what is written -- it is the one bit of provenance
    //    `createPage()` cannot infer, and it only decides whether the lifecycle line reads `restored`
    //    or `created` (OpenProject #2674).
    const page = await WIKI.models.pages.createPage(siteId, input, actor, { origin: 'restore' })
    if (meta.password) {
      await WIKI.db
        .update(pagesTable)
        .set({ password: meta.password })
        .where(eq(pagesTable.id, page.id))
    }

    if (meta.password) {
      return (await WIKI.models.pages.getPage({ siteId, id: page.id })) as Page
    }
    return page
  }

  /**
   * Drop every version older than a timeframe, across every site.
   *
   * Content versioning is the only thing this touches: a page's own row holds what it says now, so
   * purging changes nothing anybody reads — it shortens timelines and takes away what a page can be
   * rolled back to. A page whose every version is older than the cutoff keeps the page and loses its
   * history entirely, which includes the `created` row saying when it appeared.
   *
   * What it does not spare is a page that no longer exists. Its versions outlive it deliberately (see
   * `db/schema.ts`), and they are all that is left of it — so purging past the day it was deleted is
   * what finally discards it. Reclaiming that space is the point of this; there is nothing to undo it
   * with.
   *
   * Needs none of `core/maintenance.ts`'s HA handling: there is no per-instance copy of a history row
   * to fall out of step, so a plain `DELETE` is the whole of it — the next `SELECT` on any instance
   * simply doesn't see the rows any more. Verified against a real two-instance setup for task 589.
   *
   * @param olderThan How far back to keep, as one of {@link purgeTimeframes}
   * @returns How many versions were dropped
   */
  async purge(olderThan: PurgeTimeframe): Promise<number> {
    const interval = purgeTimeframes[olderThan]
    const result = await WIKI.db
      .delete(pageHistoryTable)
      // -> The interval is bound as a parameter and cast, rather than interpolated: the value is off
      //    a closed list, but a raw fragment built from a request is a habit worth not having
      .where(lt(pageHistoryTable.versionDate, sql`now() - ${interval}::interval`))
    const purged = result.rowCount ?? 0
    // -> Silent at `info` when there was nothing to purge: this runs on a schedule, and a line an
    //    operator reads every day saying `0` is what trains them to stop reading the log.
    if (purged > 0) {
      WIKI.logger.info('pages', 'purged old page versions', {
        versions: purged,
        olderThan: interval
      })
    } else {
      WIKI.logger.debug('pages', 'no page versions to purge', { olderThan: interval })
    }
    return purged
  }

  /**
   * Which of a page's fields a patch actually changes.
   *
   * Compared against the stored row rather than taken from the patch keys: a client that sends every
   * field on every save — which is what the editor does — would otherwise record every field as
   * changed on every version, and the point of this is to say what was touched.
   *
   * Fields derived from the content, and the bookkeeping that moves on every save, are left out: a
   * render changing alongside its source is not a second thing that happened.
   *
   * @param existing The page row as it stands
   * @param patch The fields being written, keyed as the page stores them
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

        Not `JSON.stringify` either, which was the same bug one level down. Postgres stores a `jsonb`
        column with its keys in its own order — by length, then bytewise — so `config` came back as
        `showToc, showTags, tocDepth, …` while `buildConfig` produces them in its own fixed order.
        Two identical objects, two different strings, and `config` was therefore reported as changed
        on every single save.
      */
      if (!isEqual(existing[key], value)) {
        changed.push(key)
      }
    }
    return changed.sort()
  }
}

export const pageHistory = new PageHistory()
