import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { pages as pagesTable } from '../../db/schema.ts'
import { escapeLikePattern } from '../../helpers/common.ts'
import { search } from '../../models/search.ts'
import type { SQL } from 'drizzle-orm'
import type { AccessActor } from '../../models/groups.ts'
import type {
  SearchFilters,
  SearchIndexablePage,
  SearchPagesResult,
  SearchResult
} from '../../models/search.ts'

/**
 * Helpers every `modules/search/*` engine shares.
 *
 * Nothing here reaches for a vendor SDK, and everything is either pure or reads only
 * `CARDINAL.db`/`CARDINAL.models` — which is what lets the `db` engine, the one that stays on the
 * bare `SearchModule` interface rather than extending `ExternalSearchModule`, import from it too.
 */

/**
 * A single quote is deliberately not escaped: nothing here interpolates an excerpt into a
 * single-quoted attribute.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Markers an engine asks its backend to wrap a matched term in, in place of that backend's own
 * default. Control characters because the excerpt is page text that may contain anything: it is
 * escaped before these become tags, and anything that could occur in real text — a literal `<em>`,
 * say — would defeat that escaping.
 */
export const HL_START = '\u0002'
export const HL_STOP = '\u0003'

export function normalizeMarkers(fragment: string | null | undefined): string | null {
  if (!fragment) {
    return null
  }
  return escapeHtml(fragment).replaceAll(HL_START, '<b>').replaceAll(HL_STOP, '</b>')
}

/**
 * Narrowed to what a bulk-indexing `rebuild()` needs, so a test can drive the pagination and
 * per-locale counting with a fake rather than a live database.
 */
export interface RebuildPageSource {
  locales(siteId: string): Promise<string[]>
  /**
   * Ordered stably, so repeated calls with an increasing `offset` walk the whole set exactly once
   * each, with no gaps or duplicates.
   */
  pageBatch(
    siteId: string,
    locale: string,
    offset: number,
    limit: number
  ): Promise<SearchIndexablePage[]>
}

export const REBUILD_BATCH_SIZE = 500

/**
 * Paginated rather than one `SELECT *`: a site's full page set should never have to fit in memory at
 * once, and a bulk endpoint has request-size limits a batch this size stays comfortably under.
 */
export function defaultPageSource(): RebuildPageSource {
  return {
    async locales(siteId) {
      const rows = await CARDINAL.db
        .selectDistinct({ locale: pagesTable.locale })
        .from(pagesTable)
        .where(eq(pagesTable.siteId, siteId))
        .orderBy(pagesTable.locale)
      return rows.map((r) => r.locale)
    },
    async pageBatch(siteId, locale, offset, limit) {
      return CARDINAL.db
        .select()
        .from(pagesTable)
        .where(and(eq(pagesTable.siteId, siteId), eq(pagesTable.locale, locale)))
        .orderBy(asc(pagesTable.id))
        .limit(limit)
        .offset(offset)
    }
  }
}

/**
 * How many of an external engine's own matches `query()` scans before deriving `totalHits` and the
 * requested page from what survives `checkAccess()`. Bounded because page-rule filtering cannot be
 * expressed in any engine's own filter language — it runs per-hit in this process, so something has
 * to cap how many hits one request can be made to pull through.
 */
export const SCAN_CAP = 500

/**
 * Per bulk re-index call: a soft cap of `MAX_INDEXING_COUNT` documents and a hard cap of
 * `MAX_INDEXING_BYTES` serialized bytes, the latter already discounting the enclosing `[`/`]` of the
 * JSON array the documents are sent as. Neither is a per-*document* cap — an engine whose endpoint
 * has one declares it itself and passes it as `batchBySize`'s `maxItemBytes`.
 */
export const MAX_INDEXING_BYTES = 10 * 2 ** 20 - Buffer.byteLength('[') - Buffer.byteLength(']')
export const MAX_INDEXING_COUNT = 1000

const COMMA_BYTES = Buffer.byteLength(',')

export interface OversizedItem<T> {
  item: T
  bytes: number
}

export interface BatchBySizeOptions<T> {
  sizeOf: (item: T) => number
  /** A batch is closed before its serialized size would reach this. */
  maxBytes: number
  maxCount: number
  /**
   * An item at least this large is diverted into `oversized` rather than riding in a batch the
   * endpoint would then reject whole. Omit it for an endpoint with no per-document limit of its own.
   */
  maxItemBytes?: number
  separatorBytes?: number
}

/**
 * An item diverted into `oversized` is not a failure: no batch boundary could make it fit, so it is
 * left to the caller to decide what to do about it.
 */
export function batchBySize<T>(
  items: T[],
  { sizeOf, maxBytes, maxCount, maxItemBytes, separatorBytes = COMMA_BYTES }: BatchBySizeOptions<T>
): { batches: T[][]; oversized: OversizedItem<T>[] } {
  const batches: T[][] = []
  const oversized: OversizedItem<T>[] = []
  let current: T[] = []
  let bytes = 0

  for (const item of items) {
    const itemBytes = sizeOf(item)
    if (maxItemBytes !== undefined && itemBytes >= maxItemBytes) {
      oversized.push({ item, bytes: itemBytes })
      continue
    }
    if (current.length > 0 && itemBytes + separatorBytes + bytes >= maxBytes) {
      batches.push(current)
      current = []
      bytes = 0
    }
    if (current.length > 0) {
      bytes += separatorBytes
    }
    bytes += itemBytes
    current.push(item)
    if (current.length >= maxCount) {
      batches.push(current)
      current = []
      bytes = 0
    }
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return { batches, oversized }
}

/**
 * `content` is omitted entirely for a password-protected page, rather than sent and relied on to
 * stay hidden by a query-time flag: an external index is a third party, and once a value has been
 * transmitted to it, a bug in a later check can no longer un-send it. Such a page is therefore only
 * findable by its title or description.
 *
 * `siteId` is not one of `SearchPagesParams`' own filters, but every document carries it and every
 * query and rebuild is scoped to it: more than one site can share an index, and an index cannot tell
 * two sites' pages apart without it.
 */
export interface SearchDocument {
  siteId: string
  locale: string
  path: string
  title: string
  description: string
  icon: string | null
  tags: string[]
  editor: string
  publishState: string
  creatorId: string
  authorId: string
  isSearchable: boolean
  classification: string
  updatedAt: string
  content?: string
}

export function buildSearchDocument(page: SearchIndexablePage): SearchDocument {
  // -> Millisecond precision, not `Instant`'s nanosecond default, as everywhere else here.
  const updatedAt = page.updatedAt.toTemporalInstant().toString({ smallestUnit: 'millisecond' })
  return {
    siteId: page.siteId,
    locale: page.locale,
    path: page.path,
    title: page.title,
    description: page.description ?? '',
    icon: page.icon ?? null,
    tags: page.tags ?? [],
    editor: page.editor,
    publishState: page.publishState,
    creatorId: page.creatorId,
    authorId: page.authorId,
    isSearchable: page.isSearchable,
    classification: page.classification,
    updatedAt,
    ...(page.password ? {} : { content: page.searchContent ?? '' })
  }
}

/**
 * A site's pages, one window at a time, walked by keyset pagination on `id`.
 *
 * A generator rather than a callback so the consumer's own work stays *between* two reads: the next
 * window is only queried once the caller asks for it, which keeps a rebuild's working set one batch
 * wide however large the site is.
 *
 * The columns are named explicitly rather than taken as `select()`: this is the exact set
 * `buildSearchDocument` reads, so a column added to `pages` never silently starts travelling to a
 * third-party index.
 */
export async function* pageStream(
  siteId: string,
  { pageSize = REBUILD_BATCH_SIZE }: { pageSize?: number } = {}
): AsyncGenerator<SearchIndexablePage[]> {
  let cursor: string | null = null
  for (;;) {
    const condition: SQL = cursor
      ? and(eq(pagesTable.siteId, siteId), gt(pagesTable.id, cursor))!
      : eq(pagesTable.siteId, siteId)
    const rows = await CARDINAL.db
      .select({
        id: pagesTable.id,
        siteId: pagesTable.siteId,
        locale: pagesTable.locale,
        path: pagesTable.path,
        title: pagesTable.title,
        description: pagesTable.description,
        icon: pagesTable.icon,
        tags: pagesTable.tags,
        editor: pagesTable.editor,
        publishState: pagesTable.publishState,
        creatorId: pagesTable.creatorId,
        authorId: pagesTable.authorId,
        isSearchable: pagesTable.isSearchable,
        classification: pagesTable.classification,
        password: pagesTable.password,
        searchContent: pagesTable.searchContent,
        updatedAt: pagesTable.updatedAt
      })
      .from(pagesTable)
      .where(condition)
      .orderBy(asc(pagesTable.id))
      .limit(pageSize)

    if (rows.length === 0) {
      return
    }
    yield rows as unknown as SearchIndexablePage[]
    if (rows.length < pageSize) {
      return
    }
    cursor = rows[rows.length - 1]!.id
  }
}

/**
 * One locale's pages of one site, one batch at a time, through an injected `RebuildPageSource` —
 * what an engine reporting a per-locale `RebuildResult` entry needs, where `pageStream` walks a
 * whole site at once. Lazy for the same reason `pageStream` is: the next batch is only read once the
 * caller has finished uploading the previous one.
 */
export async function* localePageStream(
  source: RebuildPageSource,
  siteId: string,
  locale: string,
  { batchSize = REBUILD_BATCH_SIZE }: { batchSize?: number } = {}
): AsyncGenerator<SearchIndexablePage[]> {
  let offset = 0
  for (;;) {
    const batch = await source.pageBatch(siteId, locale, offset, batchSize)
    if (batch.length > 0) {
      yield batch
      offset += batch.length
    }
    if (batch.length !== batchSize) {
      return
    }
  }
}

/**
 * The parts of a row a `read:pages` page rule is decided against. Each engine reads them out of its
 * own document shape, which is why `filterVisible` takes a mapper rather than a fixed row type.
 */
export interface VisibilityRef {
  path: string
  locale: string
  tags: string[]
  /**
   * `null` for a document indexed without one, which falls through to the same fail-closed treatment
   * `helpers/pageRules.ts` gives a genuinely unknown classification. A `rebuild()` backfills it.
   */
  classification: string | null
}

/**
 * Applied to the rows rather than folded into the engine's own query, in every engine: which rule
 * covers a page can depend on a regular expression or on that page's tags, and no engine's filter
 * language — nor a SQL `WHERE` — can express that. Search must not be a way around page permissions:
 * a title and an excerpt are content too.
 *
 * No actor means an internal caller, or one trusted to have filtered already; nothing is checked.
 */
export function filterVisible<T>(
  rows: T[],
  actor: AccessActor | undefined,
  siteId: string,
  toRef: (row: T) => VisibilityRef
): T[] {
  if (!actor) {
    return rows
  }
  return rows.filter((row) => {
    const { path, locale, tags, classification } = toRef(row)
    return CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
      path,
      locale,
      siteId,
      tags,
      classification
    })
  })
}

/**
 * `results` and `totalHits` are both derived from `visible` ALONE. Slicing the caller's
 * `offset`/`limit` out of the scanned rows before filtering lets a page-rule DENY both occupy a slot
 * on the page the caller asked for and count toward the total it was told about, so
 * `?query=<phrase>&limit=1` could confirm a phrase existed inside a page the caller cannot open. A
 * count that can only ever be a floor closes that.
 *
 * `totalHits` is therefore exact whenever the true match count fits inside `SCAN_CAP`, and a floor
 * beyond it — never an overcount.
 *
 * `suggestion` is always `null` here: no external engine surfaces a "did you mean" of its own, which
 * is why the `db` engine builds its own tail rather than calling this.
 */
export function toSearchPagesResult<T>(
  scanned: T[],
  visible: T[],
  { offset, limit, toResult }: { offset: number; limit: number; toResult: (row: T) => SearchResult }
): SearchPagesResult {
  return {
    results: visible.slice(offset, offset + limit).map(toResult),
    totalHits: visible.length,
    totalHitsApproximate: scanned.length !== visible.length,
    suggestion: null
  }
}

/**
 * `helpers/moduleRegistry.ts#mergeModuleConfig` substitutes a prop's default only when the stored
 * value is `undefined`, and an emptied text field is stored as `''`, not removed — so without this a
 * cleared index name would reach the vendor client as `''` and target an unnamed index.
 *
 * Deliberately here rather than in `mergeModuleConfig`: that merge is shared by every module kind,
 * and "empty means unset" is not true for all of them — a blank credential is a blank credential.
 * Marking the props `required` instead would change what the admin area is willing to save, which is
 * a different decision from what a client falls back to at connect time.
 *
 * Only a prop whose own declared default is a non-empty string is filled, so a `sensitive` credential
 * stays empty rather than acquiring a value it never had. Non-string values are untouched: a number
 * stored as `0` is a real setting.
 */
export function fillEmptyStringDefaults(
  config: Record<string, any>,
  key: string
): Record<string, any> {
  const props = search.getDefinition(key)?.props ?? {}
  const filled: Record<string, any> = { ...config }
  for (const [prop, declaration] of Object.entries(props)) {
    if (
      filled[prop] === '' &&
      typeof declaration.default === 'string' &&
      declaration.default !== ''
    ) {
      filled[prop] = declaration.default
    }
  }
  return filled
}

function nonEmpty(values?: string[]): values is string[] {
  return Array.isArray(values) && values.length > 0
}

/** Conditions over the aliased `pages p` table, shared by the `db` engine and semantic search. */
export function buildSqlFilterConditions(filters: SearchFilters): SQL[] {
  const conditions: SQL[] = []
  const { path, excludePath, locales, excludeLocales, tags, excludeTags } = filters
  const { editor, excludeEditor, publishState, excludePublishState } = filters
  const { creatorId, excludeCreatorId, authorId, excludeAuthorId } = filters
  const prefix = (value: string) => `${escapeLikePattern(value)}%`

  if (nonEmpty(path)) {
    conditions.push(
      sql`(${sql.join(
        path.map((v) => sql`p.path LIKE ${prefix(v)}`),
        sql` OR `
      )})`
    )
  }
  if (nonEmpty(excludePath)) {
    for (const value of excludePath) {
      conditions.push(sql`p.path NOT LIKE ${prefix(value)}`)
    }
  }
  if (nonEmpty(locales)) {
    conditions.push(sql`p.locale = ANY(${sql.param(locales)}::text[])`)
  }
  if (nonEmpty(excludeLocales)) {
    conditions.push(sql`p.locale <> ALL(${sql.param(excludeLocales)}::text[])`)
  }
  if (nonEmpty(tags)) {
    conditions.push(sql`p.tags @> ${sql.param(tags)}::text[]`)
  }
  if (nonEmpty(excludeTags)) {
    conditions.push(sql`NOT (p.tags && ${sql.param(excludeTags)}::text[])`)
  }
  if (nonEmpty(editor)) {
    conditions.push(sql`p.editor = ANY(${sql.param(editor)}::text[])`)
  }
  if (nonEmpty(excludeEditor)) {
    conditions.push(sql`p.editor <> ALL(${sql.param(excludeEditor)}::text[])`)
  }
  if (nonEmpty(publishState)) {
    conditions.push(sql`p."publishState"::text = ANY(${sql.param(publishState)}::text[])`)
  }
  if (nonEmpty(excludePublishState)) {
    conditions.push(sql`p."publishState"::text <> ALL(${sql.param(excludePublishState)}::text[])`)
  }
  for (const [column, include, exclude] of [
    [sql`p."creatorId"`, creatorId, excludeCreatorId],
    [sql`p."authorId"`, authorId, excludeAuthorId]
  ] as const) {
    if (nonEmpty(include)) {
      conditions.push(sql`${column} = ANY(${sql.param(include)}::uuid[])`)
    }
    if (nonEmpty(exclude)) {
      conditions.push(sql`${column} <> ALL(${sql.param(exclude)}::uuid[])`)
    }
  }
  return conditions
}
