import { algoliasearch } from 'algoliasearch'
import { search } from '../../../models/search.ts'
import { ExternalSearchModule } from '../externalBase.ts'
import {
  batchBySize,
  buildSearchDocument,
  filterVisible,
  MAX_INDEXING_BYTES,
  MAX_INDEXING_COUNT,
  pageStream,
  SCAN_CAP,
  toSearchPagesResult
} from '../shared.ts'
import type { Algoliasearch } from 'algoliasearch'
import type { SearchDocument } from '../shared.ts'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchPagesParams,
  SearchPagesResult
} from '../../../models/search.ts'

/** This module's own key, i.e. the directory name of its `definition.yml`. */
const MODULE_KEY = 'algolia'

/**
 * Algolia's documented per-object indexing limit, carried over unchanged from 2.5.x's
 * `server/modules/search/algolia/engine.js` (`git show 343d4db0:server/modules/search/algolia/engine.js`),
 * which is the reference this module's `rebuild()` batching reproduces. The per-batch caps it is used
 * alongside (`MAX_INDEXING_BYTES`/`MAX_INDEXING_COUNT`) are shared with the Elasticsearch module,
 * which ported the identical pair from its own 2.5.x engine — see `modules/search/shared.ts`.
 */
export const MAX_DOCUMENT_BYTES = 10 * 2 ** 10 // 10 KB

/**
 * An Algolia record, as written by `pageToDocument` and read back by `query()`: the document every
 * external engine writes, plus the two fields only Algolia needs — its own primary key, and the
 * materialized path prefixes `buildFilters()` needs because Algolia has no prefix filter.
 */
export interface AlgoliaPageDocument extends SearchDocument {
  objectID: string
  pathAncestors: string[]
}

/**
 * Every ancestor segment of a page's path, innermost first excluded, i.e. `a/b/c` -> `['a', 'a/b',
 * 'a/b/c']`.
 *
 * Algolia has no `LIKE 'prefix%'` equivalent — a `filters` clause only ever tests a facet for exact
 * equality — so a path *prefix* filter (what `SearchPagesParams.path` means everywhere else: "this
 * page or anything under it") needs the prefixes materialized at index time instead. Querying
 * `pathAncestors:"a/b"` then matches `a/b` itself and every page nested under it, the same set
 * `db/search.ts`'s `p.path LIKE 'a/b%'` matches.
 */
export function pathAncestors(pagePath: string): string[] {
  const segments = pagePath.split('/').filter((segment) => segment.length > 0)
  const ancestors: string[] = []
  for (let i = 0; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i + 1).join('/'))
  }
  return ancestors
}

/**
 * Escape a value embedded in an Algolia `filters` string: backslash first, so escaping the quote can't
 * be undone by the value itself containing a trailing backslash.
 */
function escapeFilterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/**
 * The `filters` string sent to Algolia for one `query()` call, folding in everything
 * `SearchPagesParams` says about *which* pages should come back — as opposed to the free-text `query`
 * itself, which travels separately.
 *
 * `isSearchable:true` is unconditional, the same way `db/search.ts`'s `query()` always adds
 * `p."isSearchable" = true` to its own `WHERE` regardless of what the caller passed: it isn't a
 * `SearchPagesParams` field, so there is nothing here to translate, it always applies.
 */
export function buildFilters(params: SearchPagesParams): string {
  const {
    siteId,
    path = '',
    locales = [],
    tags = [],
    editor = '',
    publishState = '',
    publicOnly = false,
    includeDrafts = false
  } = params

  // -> Unconditional and first, mirroring the Elasticsearch module's unconditional `term: { siteId }`
  //    filter (OpenProject #921): with two sites sharing an app/index -- exactly what the defaults
  //    produce (`indexName: wiki`) -- an unscoped query returned the other site's pages too.
  const clauses = [`siteId:"${escapeFilterValue(siteId)}"`, 'isSearchable:true']

  // -> Matches what a page view shows an anonymous reader, so search cannot surface a page that could
  //    not then be opened -- same reasoning as `db/search.ts`'s `publicOnly` branch.
  if (publicOnly) {
    clauses.push('publishState:"published"')
  } else if (!includeDrafts) {
    clauses.push('NOT publishState:"draft"')
  }
  // -> An explicit `publishState` filter is additional to, not a replacement for, the branch above --
  //    same as `db/search.ts`, which applies both as separate `AND`ed conditions.
  if (publishState) {
    clauses.push(`publishState:"${escapeFilterValue(publishState)}"`)
  }
  if (path) {
    clauses.push(`pathAncestors:"${escapeFilterValue(path)}"`)
  }
  if (locales.length > 0) {
    clauses.push(
      `(${locales.map((locale) => `locale:"${escapeFilterValue(locale)}"`).join(' OR ')})`
    )
  }
  // -> Every named tag must be present, mirroring `db/search.ts`'s `p.tags @> tags` containment check
  //    -- ANDed facet equalities rather than an OR group.
  for (const tag of tags) {
    clauses.push(`tags:"${escapeFilterValue(tag)}"`)
  }
  if (editor) {
    clauses.push(`editor:"${escapeFilterValue(editor)}"`)
  }

  return clauses.join(' AND ')
}

/**
 * A page row, as an Algolia record: the shared `buildSearchDocument` plus Algolia's own primary key
 * and the materialized path prefixes `buildFilters()` filters on.
 */
export function pageToDocument(page: SearchIndexablePage): AlgoliaPageDocument {
  return {
    objectID: page.id,
    pathAncestors: pathAncestors(page.path),
    ...buildSearchDocument(page)
  }
}

/** One page dropped from a batch by `batchDocuments()` for exceeding `MAX_DOCUMENT_BYTES` on its own. */
interface OversizedDocument {
  objectID: string
  path: string
  bytes: number
}

/** `batchDocuments()`'s return: the batches to send, plus what could not be. */
interface BatchDocumentsResult {
  batches: AlgoliaPageDocument[][]
  skipped: OversizedDocument[]
}

/**
 * Group an already-built list of Algolia documents into batches no larger than Algolia's documented
 * limits, based on 2.5.x's `processDocument`/`flushBuffer` buffering
 * (`server/modules/search/algolia/engine.js`, `git show 343d4db0:...`). The arithmetic itself is
 * `shared.ts`'s `batchBySize` — the Elasticsearch module ported the identical algorithm from its own
 * 2.5.x engine — and this wrapper is what names Algolia's own caps and shapes the diverted documents
 * into what `rebuild()`'s warning needs to say about each.
 *
 * A document that alone exceeds Algolia's per-object cap (`MAX_DOCUMENT_BYTES`) is diverted into
 * `skipped` rather than included in any batch — no batch boundary could make it fit, and Algolia's
 * `saveObjects` would reject the whole batch it rode in on. This is a deliberate departure from
 * 2.5.x's own `processDocument`, which threw in this situation (`throw new Error(...)`, same file):
 * thrown from inside `rebuild()`'s loop, that failed the ENTIRE rebuild over one oversized page,
 * silently losing every other, correctly-sized page already read for that batch and every page still
 * unread behind it — with nothing admin-visible beyond "the rebuild job failed" (OpenProject #830,
 * upstream discussion #3675: an oversized page failed indexing, and nothing said why). `rebuild()`
 * logs one `WIKI.logger.warn` per skipped page and keeps going, so a single oversized page costs that
 * page's own findability, not the rest of the site's.
 */
export function batchDocuments(docs: AlgoliaPageDocument[]): BatchDocumentsResult {
  const { batches, oversized } = batchBySize(docs, {
    sizeOf: (doc) => Buffer.byteLength(JSON.stringify(doc)),
    maxBytes: MAX_INDEXING_BYTES,
    maxCount: MAX_INDEXING_COUNT,
    maxItemBytes: MAX_DOCUMENT_BYTES
  })
  return {
    batches,
    skipped: oversized.map(({ item, bytes }) => ({
      objectID: item.objectID,
      path: item.path,
      bytes
    }))
  }
}

/** One site's live Algolia client, plus the index it was built for. */
interface SiteClient {
  client: Algoliasearch
  indexName: string
  /** `appId:apiKey:indexName` this client was built from, so a config change invalidates it. */
  configKey: string
}

/**
 * The `algolia` search module: pages pushed to, and queried from, a hosted Algolia index rather than
 * this database.
 *
 * Unlike `db/search.ts`, this module keeps per-site state (`clients`): a `SearchModule` is loaded once
 * (`models/search.ts`'s `ensureModule()`) and may serve several sites, each with its own Algolia app
 * and index.
 *
 * `getClient()` builds and caches that state lazily, keyed by the config actually in effect, rather
 * than relying only on `init()` having run first: `models/search.ts`'s `selectEngine()` and
 * `initActiveEngines()` do call `init()` now (OpenProject #920), but every hook below still resolves
 * its own client through `getClient()` independently, so this module keeps working the same way even
 * for a client built before either of those existed, or if `init()` itself ever fails.
 *
 * `created`/`updated`/`deleted`/`renamed` come from `ExternalSearchModule` — they forward to
 * `indexPage`/`removePage` below and are identical across all four external engines. That includes
 * `renamed`'s "a move is an ordinary re-index of the same `objectID`" reasoning, which used to be
 * spelled out here and is now in the base class's own doc comment.
 */
export class AlgoliaSearchModule extends ExternalSearchModule {
  private clients = new Map<string, SiteClient>()

  /**
   * Build a real Algolia client. Its own method only so a test can override it on an instance (`(mod
   * as any).createClient = () => fakeClient`) without a live Algolia account or a mocked import.
   */
  private createClient(appId: string, apiKey: string): Algoliasearch {
    return algoliasearch(appId, apiKey)
  }

  private async setSettings(client: Algoliasearch, indexName: string): Promise<void> {
    await client.setSettings({
      indexName,
      indexSettings: {
        searchableAttributes: ['title', 'description', 'content'],
        // -> Unlike 2.5.x, which indexed none of these as facets: `tags`/`locale`/`editor`/
        //    `publishState` are what `buildFilters()` needs to turn a `SearchPagesParams` field into
        //    an Algolia `filters` facet equality, and `pathAncestors`/`isSearchable` are what it needs
        //    for the `path` prefix filter and the always-on searchability gate. `siteId` (OpenProject
        //    #921) is what scopes every query -- and `rebuild()`'s purge -- to one site's own records
        //    when two sites share an index, which a plain `filters` equality on an unfaceted attribute
        //    Algolia would otherwise reject.
        attributesForFaceting: [
          'tags',
          'locale',
          'editor',
          'publishState',
          'isSearchable',
          'pathAncestors',
          'siteId'
        ]
      }
    })
  }

  /** Build (or reuse) the Algolia client for a site, from whatever config is currently stored for it. */
  private async getClient(siteId: string): Promise<SiteClient> {
    const config = search.getEngineConfig(siteId, MODULE_KEY)
    const configKey = `${config.appId}:${config.apiKey}:${config.indexName}`
    const cached = this.clients.get(siteId)
    if (cached && cached.configKey === configKey) {
      return cached
    }
    const client = this.createClient(config.appId, config.apiKey)
    const indexName = config.indexName
    await this.setSettings(client, indexName)
    const entry: SiteClient = { client, indexName, configKey }
    this.clients.set(siteId, entry)
    return entry
  }

  /**
   * Push the index configuration (`searchableAttributes`, facets) for a site as soon as it is
   * (re)configured, and cache the client `query`/`created`/etc. reuse afterwards -- see the class doc
   * comment for why every other hook does not strictly depend on this having been called first.
   */
  async init(siteId: string, config: Record<string, any>): Promise<void> {
    const client = this.createClient(config.appId, config.apiKey)
    const indexName = config.indexName
    await this.setSettings(client, indexName)
    this.clients.set(siteId, {
      client,
      indexName,
      configKey: `${config.appId}:${config.apiKey}:${config.indexName}`
    })
  }

  /**
   * Never throws — see `ExternalSearchModule#neverThrows`: a page that saved correctly must not
   * report failure because Algolia could not be reached.
   */
  protected async indexPage(page: SearchIndexablePage): Promise<void> {
    await this.neverThrows(
      async () => {
        const { client, indexName } = await this.getClient(page.siteId)
        await client.saveObject({ indexName, body: pageToDocument(page) })
      },
      (message) => `(SEARCH/ALGOLIA) Failed to index page ${page.id}: ${message}`
    )
  }

  protected async removePage(siteId: string, pageId: string): Promise<void> {
    await this.neverThrows(
      async () => {
        const { client, indexName } = await this.getClient(siteId)
        await client.deleteObject({ indexName, objectID: pageId })
      },
      (message) => `(SEARCH/ALGOLIA) Failed to remove page ${pageId} from the index: ${message}`
    )
  }

  async query(params: SearchPagesParams): Promise<SearchPagesResult> {
    const { siteId, query = '', offset = 0, limit = 25, actor } = params
    const { client, indexName } = await this.getClient(siteId)

    /*
      OpenProject #2156 (mirroring #2151's fix to db/search.ts): fetches a bounded window from the
      START of the result set (`offset: 0, length: SCAN_CAP`), not the caller's own `offset`/
      `limit`, since page-rule filtering happens after the query and needs a wider window to fill a
      page from once denied hits are dropped. `results` and `totalHits` are both then derived from
      `visible` alone -- see `db/search.ts#query()`'s own comment for the full reasoning.
    */
    const response = await client.searchSingleIndex<AlgoliaPageDocument>({
      indexName,
      searchParams: {
        query,
        filters: buildFilters(params),
        offset: 0,
        length: SCAN_CAP
      }
    })
    const hits = response.hits ?? []

    // -> Each hit is paired with its ORIGINAL position in `hits` before filtering, so relevancy
    //    (below) still reflects Algolia's own overall ordering after a denied hit is dropped and
    //    after the caller's own page is sliced out of the filtered set.
    const scanned = hits.map((hit, originalIndex) => ({ hit, originalIndex }))
    const visible = filterVisible(scanned, actor, siteId, ({ hit }) => ({
      path: hit.path,
      locale: hit.locale,
      tags: hit.tags ?? [],
      classification: hit.classification ?? null
    }))

    return toSearchPagesResult(scanned, visible, {
      offset,
      limit,
      toResult: ({ hit, originalIndex }) => ({
        id: hit.objectID,
        path: hit.path,
        locale: hit.locale,
        title: hit.title,
        description: hit.description || null,
        icon: hit.icon ?? null,
        tags: hit.tags ?? [],
        updatedAt: hit.updatedAt,
        // -> Algolia orders hits by its own relevance model already; this only preserves that relative
        //    order as a number, since `SearchResult.relevancy` is not optional. There is no equivalent
        //    of `db/search.ts`'s `ts_rank` score to report here.
        relevancy: hits.length - originalIndex,
        // -> 2.5.x parity: its `query()` returned no excerpt either. Adding one would mean Algolia
        //    snippets (`attributesToSnippet`), which is a real feature but out of this module's scope --
        //    and every protected page's `content` is never indexed in the first place (`pageToDocument`),
        //    so there would be nothing to snippet from for those regardless.
        highlight: null
      })
    })
  }

  /**
   * Recompute the whole Algolia index of a site from the pages currently in the database.
   *
   * Streamed in pages of `PAGE_SIZE` rows via keyset pagination on `id` (`WIKI.db` queries, replacing
   * 2.5.x's `WIKI.models.knex(...).stream()`), each page immediately regrouped into
   * Algolia-size-limited batches by `batchDocuments()` and sent with `client.batch()` -- so the whole
   * table is never held in memory at once, the same property the old knex stream had.
   *
   * Purges only this site's records first (`deleteBy` on the `siteId` facet), not the whole index
   * (OpenProject #921): with two sites sharing an app/index -- exactly what the defaults produce
   * (`indexName: wiki`) -- the previous unconditional `clearObjects` permanently deleted every other
   * site's records on the very first rebuild. Mirrors the Elasticsearch module's own siteId-scoped
   * `deleteByQuery` before its own re-add loop.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const PAGE_SIZE = 500
    const { client, indexName } = await this.getClient(siteId)

    WIKI.logger.info('(SEARCH/ALGOLIA) Rebuilding index...')
    await client.deleteBy({
      indexName,
      deleteByParams: { filters: `siteId:"${escapeFilterValue(siteId)}"` }
    })

    const pageCounts: Record<string, number> = {}
    let total = 0
    const skippedTotal: OversizedDocument[] = []

    for await (const rows of pageStream(siteId, { pageSize: PAGE_SIZE })) {
      const docs = rows.map((row) => pageToDocument(row))
      const { batches, skipped } = batchDocuments(docs)
      for (const doc of skipped) {
        WIKI.logger.warn(
          `(SEARCH/ALGOLIA) Skipping page "${doc.path}" (${doc.bytes} bytes): exceeds Algolia's ${MAX_DOCUMENT_BYTES}-byte object size limit and was not indexed.`
        )
      }
      skippedTotal.push(...skipped)
      for (const batch of batches) {
        await client.batch({
          indexName,
          batchWriteParams: {
            requests: batch.map((body) => ({
              action: 'addObject' as const,
              body: body as unknown as Record<string, unknown>
            }))
          }
        })
        total += batch.length
      }
      const skippedIds = new Set(skipped.map((doc) => doc.objectID))
      for (const row of rows) {
        if (skippedIds.has(row.id)) {
          continue
        }
        pageCounts[row.locale] = (pageCounts[row.locale] ?? 0) + 1
      }
    }

    if (skippedTotal.length > 0) {
      WIKI.logger.warn(
        `(SEARCH/ALGOLIA) Rebuild finished with ${skippedTotal.length} page(s) skipped for exceeding Algolia's object size limit -- see the warnings above for which.`
      )
    }
    WIKI.logger.info(`(SEARCH/ALGOLIA) Indexed ${total} page(s) [ OK ]`)
    return {
      pages: total,
      // -> `dictionary` has no Algolia equivalent -- there is no text search dictionary to report --
      //    but `RebuildResult` requires the field, so it is marked not applicable rather than left to
      //    look like a real dictionary name.
      locales: Object.entries(pageCounts).map(([locale, pages]) => ({
        locale,
        dictionary: 'n/a',
        pages
      })),
      ...(skippedTotal.length > 0
        ? {
            warnings: skippedTotal.map(
              (doc) =>
                `Page "${doc.path}" (${doc.bytes} bytes) exceeds Algolia's ${MAX_DOCUMENT_BYTES}-byte object size limit and was not indexed.`
            )
          }
        : {})
    }
  }
}

export default new AlgoliaSearchModule()
