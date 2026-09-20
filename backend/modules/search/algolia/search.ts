import { algoliasearch } from 'algoliasearch'
import { search } from '../../../models/search.ts'
import { ExternalSearchModule } from '../externalBase.ts'
import {
  batchBySize,
  buildSearchDocument,
  fillEmptyStringDefaults,
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

const MODULE_KEY = 'algolia'

/** Algolia's own documented per-object limit, not a cap chosen here. */
export const MAX_DOCUMENT_BYTES = 10 * 2 ** 10

export interface AlgoliaPageDocument extends SearchDocument {
  objectID: string
  pathAncestors: string[]
}

/**
 * Algolia has no `LIKE 'prefix%'` equivalent — a `filters` clause only tests a facet for exact
 * equality — so the path prefixes `SearchPagesParams.path` means ("this page or anything under it")
 * have to be materialized at index time. `a/b/c` yields `['a', 'a/b', 'a/b/c']`, so querying
 * `pathAncestors:"a/b"` matches `a/b` itself and everything nested under it.
 */
export function pathAncestors(pagePath: string): string[] {
  const segments = pagePath.split('/').filter((segment) => segment.length > 0)
  const ancestors: string[] = []
  for (let i = 0; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i + 1).join('/'))
  }
  return ancestors
}

/** Backslash first: escaping the quote first would let a trailing backslash in the value undo it. */
function escapeFilterValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function facet(attribute: string, value: string): string {
  return `${attribute}:"${escapeFilterValue(value)}"`
}

function anyOf(attribute: string, values: string[]): string {
  const terms = values.map((value) => facet(attribute, value))
  return terms.length === 1 ? terms[0]! : `(${terms.join(' OR ')})`
}

export function buildFilters(params: SearchPagesParams): string {
  const {
    siteId,
    path = [],
    excludePath = [],
    locales = [],
    excludeLocales = [],
    tags = [],
    tagsMatch = 'all',
    excludeTags = [],
    editor = [],
    excludeEditor = [],
    publishState = [],
    excludePublishState = [],
    creatorId = [],
    excludeCreatorId = [],
    authorId = [],
    excludeAuthorId = [],
    publicOnly = false,
    includeDrafts = false
  } = params

  // -> Unconditional: two sites can share one app/index -- exactly what the defaults produce
  //    (`indexName: wiki`) -- so an unscoped query returns the other site's pages too.
  const clauses = [`siteId:"${escapeFilterValue(siteId)}"`, 'isSearchable:true']

  // -> Search must not surface a page an anonymous reader could not then open.
  if (publicOnly) {
    clauses.push('publishState:"published"')
  } else if (!includeDrafts) {
    clauses.push('NOT publishState:"draft"')
  }
  // -> Additional to the branch above, not a replacement for it: both are `AND`ed.
  if (publishState.length > 0) {
    clauses.push(anyOf('publishState', publishState))
  }
  if (path.length > 0) {
    clauses.push(anyOf('pathAncestors', path))
  }
  if (locales.length > 0) {
    clauses.push(anyOf('locale', locales))
  }
  if (tagsMatch === 'any' && tags.length > 0) {
    clauses.push(anyOf('tags', tags))
  } else {
    for (const tag of tags) {
      clauses.push(facet('tags', tag))
    }
  }
  if (editor.length > 0) {
    clauses.push(anyOf('editor', editor))
  }
  if (creatorId.length > 0) {
    clauses.push(anyOf('creatorId', creatorId))
  }
  if (authorId.length > 0) {
    clauses.push(anyOf('authorId', authorId))
  }
  const excluded: [string, string[]][] = [
    ['publishState', excludePublishState],
    ['pathAncestors', excludePath],
    ['locale', excludeLocales],
    ['tags', excludeTags],
    ['editor', excludeEditor],
    ['creatorId', excludeCreatorId],
    ['authorId', excludeAuthorId]
  ]
  for (const [attribute, values] of excluded) {
    for (const value of values) {
      clauses.push(`NOT ${facet(attribute, value)}`)
    }
  }

  return clauses.join(' AND ')
}

export function pageToDocument(page: SearchIndexablePage): AlgoliaPageDocument {
  return {
    objectID: page.id,
    pathAncestors: pathAncestors(page.path),
    ...buildSearchDocument(page)
  }
}

interface OversizedDocument {
  objectID: string
  path: string
  bytes: number
}

interface BatchDocumentsResult {
  batches: AlgoliaPageDocument[][]
  skipped: OversizedDocument[]
}

/**
 * A document that alone exceeds `MAX_DOCUMENT_BYTES` is diverted into `skipped` rather than put in a
 * batch: no batch boundary could make it fit, and Algolia would reject the whole batch it rode in
 * on. `rebuild()` warns per skipped page and carries on rather than throwing, so one oversized page
 * costs its own findability instead of failing the entire rebuild.
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

interface SiteClient {
  client: Algoliasearch
  indexName: string
  /** `appId:apiKey:indexName`, so a config change invalidates the cached client. */
  configKey: string
}

/**
 * One `SearchModule` instance is loaded for every site, each with its own Algolia app and index, so
 * unlike `db/search.ts` this module keeps per-site state. Every hook resolves its client through
 * `getClient()`, keyed by the config in effect, rather than depending on `init()` having run first —
 * a missed or failed `init()` then costs nothing beyond re-pushing the index settings.
 */
export class AlgoliaSearchModule extends ExternalSearchModule {
  protected readonly engine = MODULE_KEY
  private clients = new Map<string, SiteClient>()

  /** Its own method only so a test can override it on the instance, with no live Algolia account. */
  private createClient(appId: string, apiKey: string): Algoliasearch {
    return algoliasearch(appId, apiKey)
  }

  private async setSettings(client: Algoliasearch, indexName: string): Promise<void> {
    await client.setSettings({
      indexName,
      indexSettings: {
        searchableAttributes: ['title', 'description', 'content'],
        // -> Every attribute `buildFilters()` (and `rebuild()`'s purge) tests must be listed here:
        //    Algolia rejects a `filters` equality on an unfaceted attribute.
        attributesForFaceting: [
          'tags',
          'locale',
          'editor',
          'publishState',
          'creatorId',
          'authorId',
          'isSearchable',
          'pathAncestors',
          'siteId'
        ]
      }
    })
  }

  private async getClient(siteId: string): Promise<SiteClient> {
    const config = fillEmptyStringDefaults(search.getEngineConfig(siteId, MODULE_KEY), MODULE_KEY)
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

  async init(siteId: string, incoming: Record<string, any>): Promise<void> {
    const config = fillEmptyStringDefaults(incoming, MODULE_KEY)
    const client = this.createClient(config.appId, config.apiKey)
    const indexName = config.indexName
    await this.setSettings(client, indexName)
    this.clients.set(siteId, {
      client,
      indexName,
      configKey: `${config.appId}:${config.apiKey}:${config.indexName}`
    })
  }

  protected async indexPage(page: SearchIndexablePage): Promise<void> {
    await this.neverThrows(
      async () => {
        const { client, indexName } = await this.getClient(page.siteId)
        await client.saveObject({ indexName, body: pageToDocument(page) })
      },
      'indexing a page failed',
      { page: page.id }
    )
  }

  protected async removePage(siteId: string, pageId: string): Promise<void> {
    await this.neverThrows(
      async () => {
        const { client, indexName } = await this.getClient(siteId)
        await client.deleteObject({ indexName, objectID: pageId })
      },
      'removing a page from the index failed',
      { page: pageId }
    )
  }

  async query(params: SearchPagesParams): Promise<SearchPagesResult> {
    const { siteId, query = '', offset = 0, limit = 25, actor } = params
    const { client, indexName } = await this.getClient(siteId)

    /*
      A bounded window from the START of the result set, not the caller's own `offset`/`limit`:
      page-rule filtering happens after the query and needs a wider window to fill a page from once
      denied hits are dropped. `results` and `totalHits` are both derived from `visible` alone.
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

    // -> Pairs each hit with its position BEFORE filtering, so `relevancy` below still reflects
    //    Algolia's own overall ordering once denied hits are dropped and the page is sliced out.
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
        // -> Algolia exposes no score of its own, so this only preserves its ordering as a number;
        //    `SearchResult.relevancy` is not optional.
        relevancy: hits.length - originalIndex,
        // -> No excerpt: that would mean Algolia snippets (`attributesToSnippet`), and a protected
        //    page's `content` is never indexed to snippet from anyway.
        highlight: null
      })
    })
  }

  /**
   * Purges only this site's records (`deleteBy` on the `siteId` facet), never the whole index: two
   * sites can share an app/index — exactly what the defaults produce (`indexName: wiki`) — so a
   * `clearObjects` would permanently delete the other site's records. Streamed page by page so the
   * whole table is never held in memory at once.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const PAGE_SIZE = 500
    const { client, indexName } = await this.getClient(siteId)

    CARDINAL.logger.debug('search', 'rebuilding the index', { engine: MODULE_KEY, site: siteId })
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
        CARDINAL.logger.warn('search', 'page skipped, over the object size limit', {
          engine: MODULE_KEY,
          path: doc.path,
          bytes: doc.bytes,
          limit: MAX_DOCUMENT_BYTES
        })
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
      CARDINAL.logger.warn('search', 'rebuild finished with pages skipped for size', {
        engine: MODULE_KEY,
        skipped: skippedTotal.length
      })
    }
    CARDINAL.logger.info('search', 'index rebuild completed', {
      engine: MODULE_KEY,
      site: siteId,
      pages: total
    })
    return {
      pages: total,
      // -> `RebuildResult` requires `dictionary` and Algolia has no text-search dictionary to
      //    report, so `n/a` rather than something that reads as a real one.
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
