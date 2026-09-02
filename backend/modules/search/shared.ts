import { and, asc, eq, gt } from 'drizzle-orm'
import { pages as pagesTable } from '../../db/schema.ts'
import type { SQL } from 'drizzle-orm'
import type { SearchIndexablePage } from '../../models/search.ts'

/**
 * Helpers every `modules/search/*` engine shares.
 *
 * These used to be copied into each engine, on the doctrine that "each engine module stays
 * self-contained" (`azure-search/search.ts` and `aws-cloudsearch/search.ts` both said so above their
 * own `escapeHtml`) — which produced three byte-identical `escapeHtml` bodies, two byte-identical
 * `RebuildPageSource`/`defaultPageSource` pairs, and two copies each of several near-identical
 * result-shaping helpers, every one of which had to be re-read and re-reasoned-about on any change.
 * Self-containment is worth having between an engine and a *vendor* — nothing here reaches for one —
 * but not between an engine and the shared vocabulary (`SearchIndexablePage`, `SearchPagesResult`)
 * every one of them already imports from `models/search.ts`.
 *
 * Everything in here is either pure or reads only `WIKI.db`/`WIKI.models`, which is what lets the
 * `db` engine — the one engine that stays on the bare `SearchModule` interface rather than extending
 * `externalBase.ts`'s `ExternalSearchModule` — import from it too.
 */

/**
 * The four characters that could turn page text into markup, escaped before any highlight marker is
 * turned into a real `<b>` tag.
 *
 * A single quote is deliberately not one of them: nothing here ever interpolates an excerpt into a
 * single-quoted attribute, and every engine's copy of this behaved the same way.
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
 * default (`<em>`/`</em>` for both Azure AI Search and CloudSearch, nothing at all for postgres).
 *
 * Control characters, because the excerpt is page text that may itself contain anything: it is HTML
 * escaped before these are turned into tags, so a page whose text reads `<script>` cannot come back
 * as markup. Anything that could occur in real text — a literal `<em>`, say — would defeat that.
 */
export const HL_START = '\u0002'
export const HL_STOP = '\u0003'

/**
 * One highlighted fragment, as a `SearchResult.highlight`: escaped first, so the only markup that
 * survives is the emphasis the search backend itself marked.
 *
 * `null` for an absent or empty fragment, which is what every caller wants for a row the backend
 * highlighted nothing in.
 */
export function normalizeMarkers(fragment: string | null | undefined): string | null {
  if (!fragment) {
    return null
  }
  return escapeHtml(fragment).replaceAll(HL_START, '<b>').replaceAll(HL_STOP, '</b>')
}

/**
 * Where a bulk-indexing `rebuild()` reads pages from — narrowed to what it needs, so a test can hand
 * it a fake that returns fixed pages with no real postgres involved, rather than requiring a live
 * database for logic that is really about pagination and per-locale counting.
 */
export interface RebuildPageSource {
  /** Every distinct locale a site currently has at least one page in, in a stable order. */
  locales(siteId: string): Promise<string[]>
  /**
   * One page of a site's rows for one locale, ordered by `id` so repeated calls with an increasing
   * `offset` walk the whole set exactly once each, with no gaps or duplicates.
   */
  pageBatch(
    siteId: string,
    locale: string,
    offset: number,
    limit: number
  ): Promise<SearchIndexablePage[]>
}

/** Rows read from postgres, and documents sent per bulk-upload call, in one `rebuild()` step. */
export const REBUILD_BATCH_SIZE = 500

/**
 * The real, database-backed `RebuildPageSource`.
 *
 * Paginated rather than one `SELECT *`, the same reason a `rebuild()` streams through its bulk
 * indexing client instead of building one giant document array: a site's full page set should never
 * have to fit in memory at once, and an external index's own bulk endpoint has request-size limits of
 * its own that a `REBUILD_BATCH_SIZE`-sized chunk comfortably stays under.
 */
export function defaultPageSource(): RebuildPageSource {
  return {
    async locales(siteId) {
      const rows = await WIKI.db
        .selectDistinct({ locale: pagesTable.locale })
        .from(pagesTable)
        .where(eq(pagesTable.siteId, siteId))
        .orderBy(pagesTable.locale)
      return rows.map((r) => r.locale)
    },
    async pageBatch(siteId, locale, offset, limit) {
      return WIKI.db
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
 * Ceiling on how many of an external engine's own matches `query()` scans before deriving
 * `totalHits` and the requested page from what survives `checkAccess()` (OpenProject #2156,
 * mirroring `db/search.ts`'s own `OVERFETCH_HARD_CAP`).
 *
 * Bounded rather than unbounded, since page-rule filtering cannot be expressed as an Algolia
 * `filters` clause, an Elasticsearch filter clause, an OData `$filter` or a CloudSearch
 * `filterQuery` — it has to run per-hit in this process, so something has to bound how many hits
 * one request can be made to pull through. All four external engines scanned exactly this far
 * already, each with its own copy of the constant.
 */
export const SCAN_CAP = 500

/**
 * Batching limits for a bulk re-index call, carried over unchanged from 2.5.x's own Algolia and
 * Elasticsearch engines (`server/modules/search/{algolia,elasticsearch}/engine.js`), which declared
 * the identical pair separately. A soft cap of `MAX_INDEXING_COUNT` documents per batch and a hard
 * cap of `MAX_INDEXING_BYTES` serialized bytes, the latter already discounting the enclosing `[`/`]`
 * of the JSON array the documents are sent as.
 *
 * Neither is a per-*document* cap: Algolia has one (`algolia/search.ts`'s own `MAX_DOCUMENT_BYTES`)
 * and CloudSearch has one, but they are different sizes with different consequences, so each engine
 * declares its own and passes it as `batchBySize`'s `maxItemBytes`.
 */
export const MAX_INDEXING_BYTES = 10 * 2 ** 20 - Buffer.byteLength('[') - Buffer.byteLength(']') // 10 MB
export const MAX_INDEXING_COUNT = 1000

/** The `,` that joins two documents once they are serialized into one JSON array. */
const COMMA_BYTES = Buffer.byteLength(',')

/** One item `batchBySize` could not place in any batch, with the size that ruled it out. */
export interface OversizedItem<T> {
  item: T
  bytes: number
}

export interface BatchBySizeOptions<T> {
  /** The item's serialized size, e.g. `Buffer.byteLength(JSON.stringify(doc))`. */
  sizeOf: (item: T) => number
  /** A batch is closed before its serialized size would reach this. */
  maxBytes: number
  /** A batch is closed once it holds this many items. */
  maxCount: number
  /**
   * An item at least this large can never fit in any batch, so it is diverted into `oversized`
   * instead of riding in one the endpoint would then reject whole. Omit it for an endpoint with no
   * per-document limit of its own (Elasticsearch's bulk API, bounded by the HTTP body size only).
   */
  maxItemBytes?: number
  /** Bytes two adjacent items cost once serialized together. Defaults to the one-byte `,`. */
  separatorBytes?: number
}

/**
 * Group a flat list into batches no larger than a bulk endpoint's documented limits.
 *
 * Pure and synchronous on purpose: keeping the size arithmetic separate from anything that awaits a
 * network call is what lets it be exercised directly, with plain arrays, rather than through a live
 * or faked vendor client — the reasoning both `algolia`'s `batchDocuments` and `elasticsearch`'s
 * `batchOperations` gave for being their own function before they became two copies of this one.
 *
 * An item diverted into `oversized` is not a failure of this function: no batch boundary could make
 * it fit, and the caller decides what to do about it. Algolia's own caller logs one warning per
 * skipped page and keeps going, deliberately unlike 2.5.x's `processDocument`, which threw and so
 * failed an entire rebuild over one oversized page (OpenProject #830).
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
 * A page row, as the document an external index stores for it.
 *
 * `content` is omitted entirely for a password-protected page, rather than sent and relied on to
 * stay hidden by a query-time flag: an external index is a third party, and once a value has been
 * transmitted to it, a bug in a later `hideProtectedContent` check can no longer un-send it. Leaving
 * `content` out means such a page is only ever findable by its title or description — exactly the
 * set `db/search.ts`'s `ts_filter(p.ts, '{a,b}')` restricts a protected page to — without an engine
 * depending on that restriction being re-checked correctly on every read.
 *
 * `siteId` is not one of `SearchPagesParams`' own filters — it isn't a search *option* the way
 * `editor` is — but every document carries it, and every query and rebuild is scoped to it: 2.5.x
 * had no concept of more than one site sharing an index, this repo does, and an index cannot tell
 * two sites' pages apart without it (OpenProject #921).
 *
 * `classification` is what `query()` checks a CLASSIFICATION page rule against (OpenProject #1125),
 * populated at index time the same way `tags`/`editor`/`publishState` already are.
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
  isSearchable: boolean
  classification: string
  updatedAt: string
  content?: string
}

/** A page row, as a `SearchDocument`. */
export function buildSearchDocument(page: SearchIndexablePage): SearchDocument {
  // -> Same conversion `api/pages.ts` uses for a `Date` column headed into an ISO string: an exact
  //    instant, so millisecond precision (what the rest of the codebase emits) is enough.
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
    isSearchable: page.isSearchable,
    classification: page.classification,
    updatedAt,
    ...(page.password ? {} : { content: page.searchContent ?? '' })
  }
}

/**
 * A site's pages, one window at a time, walked by keyset pagination on `id`.
 *
 * The shape `algolia` and `elasticsearch` both use to feed `rebuild()` (`WIKI.db` queries replacing
 * 2.5.x's `WIKI.models.knex(...).stream()`), previously written out in full in each of them — the
 * same column list, the same `cursor`/`gt(id, cursor)` condition, the same two termination checks.
 *
 * A generator rather than a callback so the consumer's own work stays *between* two reads: the next
 * window is only queried once the caller asks for it, which is what keeps a rebuild's working set
 * one batch wide however large the site is — the property the old knex stream had, and the one
 * `elasticsearch/search.test.ts`'s "never reads the next page of rows while a batch upload is still
 * in flight" pins.
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
    const rows = await WIKI.db
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
 * One locale's pages of one site, one batch at a time, through an injected `RebuildPageSource`.
 *
 * The shape `azure-search` and `aws-cloudsearch` both use: unlike `pageStream` above they rebuild
 * locale by locale (each reports its own `RebuildResult.locales` entry and its own progress line as
 * it goes), and they read through a `RebuildPageSource` rather than `WIKI.db` directly so a test can
 * exercise the pagination and per-locale counting with no real postgres — see that interface's own
 * doc comment.
 *
 * A generator for the same reason `pageStream` is one: the next batch is only read once the caller
 * has finished uploading the previous one.
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
