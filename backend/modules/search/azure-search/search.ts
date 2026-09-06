import { AzureKeyCredential, SearchClient, SearchIndexClient } from '@azure/search-documents'
import { chunk } from 'es-toolkit/array'
import { search } from '../../../models/search.ts'
import { ExternalSearchModule } from '../externalBase.ts'
import {
  defaultPageSource,
  fillEmptyStringDefaults,
  filterVisible,
  HL_START,
  HL_STOP,
  localePageStream,
  normalizeMarkers,
  REBUILD_BATCH_SIZE,
  SCAN_CAP,
  toSearchPagesResult
} from '../shared.ts'
import type { SearchIndex } from '@azure/search-documents'
import type { RebuildPageSource } from '../shared.ts'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchOrderBy,
  SearchPagesParams,
  SearchPagesResult
} from '../../../models/search.ts'

/** This module's own key, i.e. the directory name of its `definition.yml`. */
const MODULE_KEY = 'azure-search'

/**
 * Name of the scoring profile every index is provisioned with, and set as the index's default so a
 * query needs no `scoringProfile` parameter to get the weighting below.
 */
const SCORING_PROFILE_NAME = 'wikiRelevancy'

/** Fields the main, unrestricted search matches and highlights against. */
const FULL_SEARCH_FIELDS = ['title', 'description', 'content']

/** Fields a password-protected page may still be found by — see `runProtectedSplitQuery` below. */
const PROTECTED_SEARCH_FIELDS = ['title', 'description']

/** `highlightFields` value: one fragment each from `content` and `description`, matching the `db`
 *  engine's `ts_headline` call (`MaxFragments=1`). */
const HIGHLIGHT_FIELDS = 'content-1,description-1'

/**
 * The subset of `SearchIndexClient` this module actually calls.
 *
 * Narrowed on purpose rather than importing the SDK's own type: it is what lets a test build a fake
 * client — an object with a `createOrUpdateIndex` that records calls and never makes a network
 * request — without pulling in `@azure/search-documents`' full (and largely irrelevant, for this
 * module) surface.
 */
export interface AzureSearchIndexClient {
  createOrUpdateIndex(index: SearchIndex): Promise<SearchIndex>
}

/** One row of a query response: a document plus its relevance score and any highlighted fragments. */
export interface AzureSearchRow {
  document: Record<string, any>
  score: number
  highlights?: Record<string, string[]>
}

/** The options this module ever sends to a query — a narrowed, testable slice of the SDK's own. */
export interface AzureSearchQueryOptions {
  filter?: string
  orderBy?: string[]
  top?: number
  skip?: number
  includeTotalCount?: boolean
  searchFields?: string[]
  select?: string[]
  highlightFields?: string
  highlightPreTag?: string
  highlightPostTag?: string
  queryType?: 'simple' | 'full'
}

/**
 * The subset of `SearchClient` this module actually calls — document CRUD plus querying.
 *
 * Same reasoning as `AzureSearchIndexClient` above: a fake implementation can record calls and hand
 * back canned rows with no network involved, and without fighting the real SDK's generic `TModel`
 * typing at every call site.
 */
export interface AzureSearchQueryClient {
  mergeOrUploadDocuments(documents: Record<string, any>[]): Promise<void>
  deleteDocuments(keyName: string, keyValues: string[]): Promise<void>
  search(
    searchText: string | undefined,
    options: AzureSearchQueryOptions
  ): Promise<{ count?: number; results: AsyncIterable<AzureSearchRow> }>
}

/** Builds the real SDK index-management client from a site's stored `serviceName`/`adminApiKey` config. */
function defaultClientFactory(config: Record<string, any>): AzureSearchIndexClient {
  const endpoint = `https://${config.serviceName}.search.windows.net`
  return new SearchIndexClient(endpoint, new AzureKeyCredential(config.adminApiKey))
}

/** Builds the real SDK document/query client from a site's stored config. */
function defaultSearchClientFactory(config: Record<string, any>): AzureSearchQueryClient {
  const endpoint = `https://${config.serviceName}.search.windows.net`
  const indexName = config.indexName
  const client = new SearchClient<Record<string, any>>(
    endpoint,
    indexName,
    new AzureKeyCredential(config.adminApiKey)
  )
  return {
    async mergeOrUploadDocuments(documents) {
      await client.mergeOrUploadDocuments(documents)
    },
    async deleteDocuments(keyName, keyValues) {
      await client.deleteDocuments(keyName, keyValues)
    },
    async search(searchText, options) {
      const result = await client.search(searchText, options as any)
      return {
        count: result.count,
        results: result.results as unknown as AsyncIterable<AzureSearchRow>
      }
    }
  }
}

/**
 * The index schema this module provisions, for a given index name.
 *
 * A pure function of the name — every other field is fixed — so `init()`'s idempotency is structural
 * rather than incidental: calling it twice builds the exact same `SearchIndex` object both times, and
 * handing the identical definition to `createOrUpdateIndex` twice is what makes a create-or-update
 * call safe to repeat on every boot rather than only the first one.
 *
 * Field set matches `SearchPagesParams`/`SearchResult`, not 2.5.x's narrower `id`/`path`/`locale`/
 * `title`/`description`/`content`: `tags`, `editor` and `publishState` are filterable/facetable from
 * the start so a caller gets the same filtering surface regardless of which engine a site has
 * selected; `icon` carries through what `SearchResult.icon` needs; `hasPassword` is what `query()`
 * uses to route a protected page into the title/description-only search (see `runQuery` below) —
 * postgres has the page row itself to check `password IS NULL` against, an external index does not.
 *
 * `path` is deliberately both `filterable` (a plain prefix filter, `startswith`) and `searchable` (so
 * `search.ismatch` — Azure's wildcard-capable filter function — can be used for a pattern containing
 * `*`). Every query that matches free text against the document explicitly lists its own
 * `searchFields` rather than relying on "every searchable field", specifically so `path` being
 * searchable never lets an unrelated free-text query match on it.
 *
 * Weighting matches 2.5.x's own scoring: title outranks description outranks body, expressed here as
 * a scoring profile's `textWeights` (4 / 3 / 1) rather than left to Azure's unweighted default (every
 * matched field contributing equally), so a page whose title matches still ranks above one that only
 * mentions the term in its body.
 */
export function buildIndexSchema(indexName: string): SearchIndex {
  return {
    name: indexName,
    fields: [
      { name: 'id', type: 'Edm.String', key: true, searchable: false, filterable: false },
      { name: 'siteId', type: 'Edm.String', filterable: true },
      { name: 'locale', type: 'Edm.String', filterable: true },
      { name: 'path', type: 'Edm.String', searchable: true, filterable: true },
      { name: 'title', type: 'Edm.String', searchable: true },
      { name: 'description', type: 'Edm.String', searchable: true },
      { name: 'content', type: 'Edm.String', searchable: true },
      { name: 'tags', type: 'Collection(Edm.String)', filterable: true, facetable: true },
      { name: 'editor', type: 'Edm.String', filterable: true },
      { name: 'publishState', type: 'Edm.String', filterable: true },
      { name: 'updatedAt', type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
      { name: 'icon', type: 'Edm.String', searchable: false, filterable: false },
      { name: 'hasPassword', type: 'Edm.Boolean', filterable: true },
      // -> OpenProject #1125: what `query()` checks a CLASSIFICATION rule against, populated at index
      //    time from `pages.classification` the same way `tags`/`editor`/`publishState` already are.
      { name: 'classification', type: 'Edm.String', searchable: false, filterable: false }
    ],
    scoringProfiles: [
      {
        name: SCORING_PROFILE_NAME,
        textWeights: { weights: { title: 4, description: 3, content: 1 } }
      }
    ],
    defaultScoringProfile: SCORING_PROFILE_NAME
  }
}

/** A page row turned into the document this module writes to the index. */
export function toIndexDocument(page: SearchIndexablePage): Record<string, any> {
  return {
    id: page.id,
    siteId: page.siteId,
    locale: page.locale,
    path: page.path,
    title: page.title,
    description: page.description ?? '',
    content: page.searchContent ?? '',
    tags: page.tags ?? [],
    editor: page.editor,
    publishState: page.publishState,
    icon: page.icon ?? '',
    hasPassword: page.password != null,
    classification: page.classification,
    // -> Same conversion `api/pages/write.ts` uses for a `Date` column headed into an ISO string: an exact
    //    instant, so millisecond precision (what the rest of the codebase emits) is enough.
    updatedAt: page.updatedAt.toTemporalInstant().toString({ smallestUnit: 'millisecond' })
  }
}

/** Escapes a literal for an OData string constant by doubling embedded single quotes. */
function escapeODataLiteral(value: string): string {
  return value.replaceAll("'", "''")
}

/** The delimiter `search.in()` splits its value list on — not a comma, so a value containing one is safe. */
const IN_DELIMITER = '|'

function eqFilter(field: string, value: string): string {
  return `${field} eq '${escapeODataLiteral(value)}'`
}

function inFilter(field: string, values: string[]): string {
  const list = values.map((v) => escapeODataLiteral(v)).join(IN_DELIMITER)
  return `search.in(${field}, '${list}', '${IN_DELIMITER}')`
}

/**
 * The `path` filter: a plain prefix — "browse this folder", what `SearchPagesParams.path` is for —
 * uses OData's own `startswith`, which needs no full-text query engine at all; a pattern the caller
 * marked as a wildcard match (containing `*`) uses `search.ismatch`, Azure's full-text filter
 * function, since only it understands Lucene wildcard syntax. Matches `p.path LIKE value%` in the `db`
 * engine for the common case.
 */
function pathFilter(path: string): string {
  const escaped = escapeODataLiteral(path)
  return path.includes('*')
    ? `search.ismatch('${escaped}', 'path', 'full', 'any')`
    : `startswith(path, '${escaped}')`
}

/** `publishState`/`publicOnly`/`includeDrafts` translated the same way the `db` engine's `query()` does. */
function publishStateFilters(
  publishState: string,
  publicOnly: boolean,
  includeDrafts: boolean
): string[] {
  const clauses: string[] = []
  if (publicOnly) {
    // -> Matches what a page view shows an anonymous reader, so search cannot surface a page that
    //    could not then be opened
    clauses.push(`publishState eq 'published'`)
  } else if (!includeDrafts) {
    clauses.push(`publishState ne 'draft'`)
  }
  if (publishState) {
    clauses.push(eqFilter('publishState', publishState))
  }
  return clauses
}

export interface AzureSearchFilterParams {
  siteId: string
  path?: string
  locales?: string[]
  tags?: string[]
  editor?: string
  publishState?: string
  publicOnly?: boolean
  includeDrafts?: boolean
  /** Route to the public or the protected half of the split query — see `runProtectedSplitQuery`. */
  hasPassword?: boolean
}

/**
 * The OData `$filter` expression for a query, built up as a set of `and`-joined conditions —
 * `locales`/`tags`/`editor`/`publishState` each contribute one when set, same shape as the `db`
 * engine's own `conditions` array. `tags` becomes `tags/any(t: search.in(t, ...))`: a document matches
 * if any of its tags is in the requested set, the collection-field equivalent of `p.tags @> ...` in
 * postgres (any-of, not all-of).
 */
export function buildFilter(params: AzureSearchFilterParams): string {
  const conditions = [eqFilter('siteId', params.siteId)]
  if (params.path) {
    conditions.push(pathFilter(params.path))
  }
  if (params.locales && params.locales.length > 0) {
    conditions.push(inFilter('locale', params.locales))
  }
  if (params.tags && params.tags.length > 0) {
    conditions.push(`tags/any(t: ${inFilter('t', params.tags)})`)
  }
  if (params.editor) {
    conditions.push(eqFilter('editor', params.editor))
  }
  conditions.push(
    ...publishStateFilters(
      params.publishState ?? '',
      params.publicOnly ?? false,
      params.includeDrafts ?? false
    )
  )
  if (params.hasPassword !== undefined) {
    conditions.push(`hasPassword eq ${params.hasPassword}`)
  }
  return conditions.join(' and ')
}

/**
 * `orderBy`/`orderByDirection` translated into an OData `$orderby` list.
 *
 * `relevancy` has no field of its own — it's `search.score()`, Azure's relevance function — which is
 * also what `db`'s `ts_rank` plays the same role for. Every other value is a plain field name already
 * shared with `SearchResult`.
 */
export function buildOrderBy(orderBy: SearchOrderBy, direction: 'asc' | 'desc'): string[] {
  const dir = direction === 'asc' ? 'asc' : 'desc'
  if (orderBy === 'relevancy') {
    return [`search.score() ${dir}`]
  }
  return [`${orderBy} ${dir}`]
}

/**
 * The first highlighted fragment found (`content` preferred over `description`), normalized to `<b>`
 * by the shared `normalizeMarkers` — which escapes it first, so the only markup that survives is the
 * emphasis Azure itself marked.
 */
function normalizeHighlight(highlights: Record<string, string[]> | undefined): string | null {
  return normalizeMarkers(highlights?.content?.[0] ?? highlights?.description?.[0])
}

/** Compares two rows the same way Azure's own `$orderby` would, for merging two already-sorted result sets. */
function compareRows(
  a: AzureSearchRow,
  b: AzureSearchRow,
  orderBy: SearchOrderBy,
  direction: 'asc' | 'desc'
): number {
  const factor = direction === 'asc' ? 1 : -1
  if (orderBy === 'relevancy') {
    return (a.score - b.score) * factor
  }
  const av = String(a.document[orderBy] ?? '')
  const bv = String(b.document[orderBy] ?? '')
  if (av === bv) {
    return 0
  }
  return (av < bv ? -1 : 1) * factor
}

/**
 * The `azure-search` search module: Azure AI Search as an external search engine.
 *
 * Task #553 provisioned the index (`init()`) and the SDK dependency. This task (#557) is the page
 * lifecycle — `created`/`updated`/`deleted`/`renamed` keep an Azure index in step with the database —
 * plus `query()`, the read side. `rebuild()` (task #564) is the bulk streaming path below.
 *
 * Takes both a client factory (index management) and a search-client factory (documents/queries)
 * rather than talking to the SDK directly, the same reason `dictionaryForLocale` in the `db` module
 * reads its config through an injected seam: it's what lets a test exercise every hook against a fake
 * client with no real Azure resource, network call, or credential involved — there is no local Azure
 * AI Search emulator (Feature #381).
 */
export class AzureSearchModule extends ExternalSearchModule {
  protected readonly engine = MODULE_KEY
  private readonly clientFactory: (config: Record<string, any>) => AzureSearchIndexClient
  private readonly searchClientFactory: (config: Record<string, any>) => AzureSearchQueryClient
  private readonly pageSource: RebuildPageSource
  /**
   * One client per site, each tagged with the config (as JSON) it was built from -- the same
   * `configKey` pattern `elasticsearch`/`algolia`'s `getClient()` already use -- so that changing
   * `serviceName`/`adminApiKey`/`indexName` in the admin area invalidates the cached client on the very
   * next call instead of silently keeping the old one until a process restart (OpenProject #922).
   */
  private readonly clients = new Map<
    string,
    { client: AzureSearchIndexClient; configKey: string }
  >()
  private readonly queryClients = new Map<
    string,
    { client: AzureSearchQueryClient; configKey: string }
  >()

  constructor(
    clientFactory: (config: Record<string, any>) => AzureSearchIndexClient = defaultClientFactory,
    searchClientFactory: (
      config: Record<string, any>
    ) => AzureSearchQueryClient = defaultSearchClientFactory,
    pageSource: RebuildPageSource = defaultPageSource()
  ) {
    super()
    this.clientFactory = clientFactory
    this.searchClientFactory = searchClientFactory
    this.pageSource = pageSource
  }

  private clientFor(siteId: string, config: Record<string, any>): AzureSearchIndexClient {
    const configKey = JSON.stringify(config)
    const cached = this.clients.get(siteId)
    if (cached && cached.configKey === configKey) {
      return cached.client
    }
    const client = this.clientFactory(config)
    this.clients.set(siteId, { client, configKey })
    return client
  }

  private queryClientFor(siteId: string, config: Record<string, any>): AzureSearchQueryClient {
    const configKey = JSON.stringify(config)
    const cached = this.queryClients.get(siteId)
    if (cached && cached.configKey === configKey) {
      return cached.client
    }
    const client = this.searchClientFactory(config)
    this.queryClients.set(siteId, { client, configKey })
    return client
  }

  /**
   * The config for one site's `azure-search` engine (`serviceName`/`adminApiKey`/`indexName`),
   * completed with this engine's own `definition.yml` defaults.
   *
   * Read through `models/search.ts`'s `getEngineConfig`, the same path `algolia` and `elasticsearch`
   * already used, rather than straight off `WIKI.sites`. This module used to read the raw stored
   * object instead, on the grounds that `getEngineConfig` needs `search.definitions` to have been
   * populated by `refreshFromDisk()` first — but `index.ts` does call `refreshFromDisk()` before
   * `initActiveEngines()`, and before any request can reach a hook here, so that precondition always
   * holds. Going through it is what lets `definition.yml` be the single place `indexName`'s default
   * is written down, instead of a `|| DEFAULT_INDEX_NAME` re-applied at each use site.
   *
   * `fillEmptyStringDefaults` is what keeps the *other* half of that `||`'s behaviour: a value the
   * operator cleared is stored as `''`, which `getEngineConfig`'s merge treats as a real value rather
   * than as unset, so without it a blanked `indexName` would reach Azure as an empty index name.
   */
  private configFor(siteId: string): Record<string, any> {
    return fillEmptyStringDefaults(search.getEngineConfig(siteId, MODULE_KEY), MODULE_KEY)
  }

  /**
   * Create the site's Azure AI Search index if it doesn't exist yet, or bring it in line with the
   * schema above if it does.
   *
   * `createOrUpdateIndex` is Azure's own idempotent primitive for this — a PUT keyed by index name —
   * so calling it with the same `SearchIndex` object on every boot is safe by construction rather than
   * requiring this method to first fetch and diff the existing index. It only becomes unsafe if the
   * schema is later changed incompatibly for an index that already holds documents (e.g. flipping
   * `filterable` on an existing field), which is a schema-authoring concern for whoever next edits
   * `buildIndexSchema`, not something `init()` itself needs to guard against.
   *
   * `incoming` is completed the same way `configFor()` completes what it reads, so a cleared
   * `indexName` provisions `wiki` rather than an unnamed index — see `fillEmptyStringDefaults`.
   */
  async init(siteId: string, incoming: Record<string, any>): Promise<void> {
    const config = fillEmptyStringDefaults(incoming, MODULE_KEY)
    const indexName = config.indexName
    const client = this.clientFor(siteId, config)
    await client.createOrUpdateIndex(buildIndexSchema(indexName))
    WIKI.logger.info('search', 'index provisioned', {
      engine: MODULE_KEY,
      index: indexName,
      site: siteId
    })
  }

  /**
   * Write (or overwrite) one page's document in the index.
   *
   * Never throws — see `ExternalSearchModule#neverThrows`: a page that saved correctly must not
   * report failure because its index entry could not be written. A later `rebuild()` puts a missed
   * write right.
   */
  protected async indexPage(page: SearchIndexablePage): Promise<void> {
    await this.neverThrows(
      async () => {
        const client = this.queryClientFor(page.siteId, this.configFor(page.siteId))
        await client.mergeOrUploadDocuments([toIndexDocument(page)])
      },
      'indexing a page failed',
      { page: page.id }
    )
  }

  /** Remove one page's document from the index. Never throws — same contract as `indexPage`. */
  protected async removePage(siteId: string, pageId: string): Promise<void> {
    await this.neverThrows(
      async () => {
        const client = this.queryClientFor(siteId, this.configFor(siteId))
        await client.deleteDocuments('id', [pageId])
      },
      'removing a page from the index failed',
      { page: pageId }
    )
  }

  /** Runs one search and drains its result iterator into a plain array. */
  private async runQuery(
    client: AzureSearchQueryClient,
    searchText: string | undefined,
    options: AzureSearchQueryOptions
  ): Promise<{ rows: AzureSearchRow[]; count: number }> {
    const response = await client.search(searchText, options)
    const rows: AzureSearchRow[] = []
    for await (const row of response.results) {
      rows.push(row)
    }
    return { rows, count: response.count ?? 0 }
  }

  /**
   * Every document id currently in the index for a site, paginated `id`-only (`select`) so a large
   * index is never pulled through in one request. `rebuild()`'s purge step (OpenProject #922) diffs
   * this against what it just re-uploaded to find what should no longer be there.
   */
  private async fetchAllIds(client: AzureSearchQueryClient, siteId: string): Promise<string[]> {
    const PAGE_SIZE = 1000
    const ids: string[] = []
    let skip = 0
    for (;;) {
      const { rows } = await this.runQuery(client, undefined, {
        filter: buildFilter({ siteId }),
        select: ['id'],
        top: PAGE_SIZE,
        skip,
        includeTotalCount: false
      })
      if (rows.length === 0) {
        break
      }
      ids.push(...rows.map((row) => row.document.id as string))
      skip += rows.length
      if (rows.length < PAGE_SIZE) {
        break
      }
    }
    return ids
  }

  /**
   * Full-text search over the pages of a site.
   *
   * The text query is optional: with only tags or filters this is a browse rather than a search —
   * `searchText` is left `undefined`, which Azure treats as "match every document" (`search=*`).
   *
   * `hideProtectedContent` is only meaningful with a query: `db`'s `query()` gates the same way
   * (`hideProtectedContent && hasQuery`), since with no query there is no body text to leak in the
   * first place.
   */
  async query(params: SearchPagesParams): Promise<SearchPagesResult> {
    const {
      siteId,
      query = '',
      path = '',
      locales = [],
      tags = [],
      editor = '',
      publishState = '',
      orderBy = 'relevancy',
      orderByDirection = 'desc',
      offset = 0,
      limit = 25,
      publicOnly = false,
      includeDrafts = false,
      hideProtectedContent = true,
      actor
    } = params

    const terms = query.trim()
    const hasQuery = terms.length > 0
    const searchText = hasQuery ? terms : undefined
    const client = this.queryClientFor(siteId, this.configFor(siteId))
    const azureOrderBy = buildOrderBy(orderBy, orderByDirection)
    const filterParams: AzureSearchFilterParams = {
      siteId,
      path,
      locales,
      tags,
      editor,
      publishState,
      publicOnly,
      includeDrafts
    }

    /*
      OpenProject #2156 (mirroring #2151's fix to db/search.ts): both branches now always scan a
      bounded window from the START of the result set (`SCAN_CAP`, `skip: 0`), never the caller's
      own `offset`/`limit` -- page-rule filtering happens after the query and needs a wider window
      to fill a page from once denied rows are dropped. `results` and `totalHits` are both then
      derived from `visible` alone, sliced/counted AFTER filtering rather than before.
    */
    let rows: AzureSearchRow[]

    if (hasQuery && hideProtectedContent) {
      rows = await this.runProtectedSplitQuery(
        client,
        searchText!,
        filterParams,
        azureOrderBy,
        orderBy,
        orderByDirection
      )
    } else {
      const result = await this.runQuery(client, searchText, {
        filter: buildFilter(filterParams),
        orderBy: azureOrderBy,
        top: SCAN_CAP,
        skip: 0,
        // -> No count needed: `totalHits` below is derived purely from rows that survived
        //    `checkAccess`, never from Azure's own pre-filter count.
        includeTotalCount: false,
        queryType: 'simple',
        searchFields: hasQuery ? FULL_SEARCH_FIELDS : undefined,
        highlightFields: hasQuery ? HIGHLIGHT_FIELDS : undefined,
        highlightPreTag: HL_START,
        highlightPostTag: HL_STOP
      })
      rows = result.rows
    }

    const visible = filterVisible(rows, actor, siteId, (row) => ({
      path: row.document.path as string,
      locale: row.document.locale as string,
      tags: (row.document.tags ?? []) as string[],
      classification: (row.document.classification as string | null) ?? null
    }))

    return toSearchPagesResult(rows, visible, {
      offset,
      limit,
      toResult: (row) => ({
        id: row.document.id as string,
        path: row.document.path as string,
        locale: row.document.locale as string,
        title: row.document.title as string,
        description: (row.document.description || null) as string | null,
        icon: (row.document.icon || null) as string | null,
        tags: (row.document.tags ?? []) as string[],
        updatedAt: row.document.updatedAt as string,
        relevancy: row.score,
        highlight: normalizeHighlight(row.highlights)
      })
    })
  }

  /**
   * The `hideProtectedContent` behavior: a protected page is findable by name, not by what it says.
   *
   * Two searches are issued and merged rather than one: the public half runs the ordinary full-text
   * query (`FULL_SEARCH_FIELDS`, including `content`) restricted to pages with no password; the
   * protected half is scoped with `searchFields: PROTECTED_SEARCH_FIELDS` to `title`/`description`
   * only and requests no highlights at all, so a protected page surfaces when the terms are in its
   * title or description — both of which it shows to everyone anyway — but never when they are only
   * in the text behind the password, and never comes back with an excerpt of that text either. This is
   * the same shape `ts_filter(p.ts, '{a,b}')` plus the headline's own `CASE WHEN p.password IS NULL`
   * give the `db` engine, split across two Azure queries because an external index has no per-row SQL
   * expression to fall back to.
   *
   * Each half is fetched `SCAN_CAP` deep (Azure's own ordering already puts the right rows first),
   * then the two already-ordered lists are merged with the same comparator Azure's own `$orderby`
   * would apply. Deliberately NOT sliced to the requested page here (OpenProject #2151/#2156): the
   * caller (`query()`) still has to run every merged row through `checkAccess()` first, so slicing
   * by the caller's raw `offset`/`limit` before that filtering ran was exactly the bug — a page-rule
   * DENY several rows into the merge used to still count toward, and could still occupy a slot in,
   * a page the caller asked for.
   */
  private async runProtectedSplitQuery(
    client: AzureSearchQueryClient,
    searchText: string,
    filterParams: AzureSearchFilterParams,
    azureOrderBy: string[],
    orderBy: SearchOrderBy,
    orderByDirection: 'asc' | 'desc'
  ): Promise<AzureSearchRow[]> {
    const [publicResult, protectedResult] = await Promise.all([
      this.runQuery(client, searchText, {
        filter: buildFilter({ ...filterParams, hasPassword: false }),
        orderBy: azureOrderBy,
        top: SCAN_CAP,
        skip: 0,
        // -> No count needed: the caller derives `totalHits` purely from rows that survived
        //    `checkAccess`, never from Azure's own pre-filter count.
        includeTotalCount: false,
        queryType: 'simple',
        searchFields: FULL_SEARCH_FIELDS,
        highlightFields: HIGHLIGHT_FIELDS,
        highlightPreTag: HL_START,
        highlightPostTag: HL_STOP
      }),
      this.runQuery(client, searchText, {
        filter: buildFilter({ ...filterParams, hasPassword: true }),
        orderBy: azureOrderBy,
        top: SCAN_CAP,
        skip: 0,
        includeTotalCount: false,
        queryType: 'simple',
        searchFields: PROTECTED_SEARCH_FIELDS
        // -> No `highlightFields`: a protected page never shows an excerpt, matching the `db` engine.
      })
    ])
    return [...publicResult.rows, ...protectedResult.rows].sort((a, b) =>
      compareRows(a, b, orderBy, orderByDirection)
    )
  }

  /**
   * Recompute the whole Azure AI Search index of a site from scratch, streaming every page of every
   * locale through `mergeOrUploadDocuments` rather than the `db` engine's single SQL `UPDATE` — there
   * is no equivalent single-statement primitive against an external index, and a whole site's pages
   * should never have to fit in memory at once to be reindexed.
   *
   * Indexes every page unconditionally, the same as `created`/`updated`/`renamed` above — not just
   * "published, non-private" pages the way 2.5.x's own `aws`/`azure` engines' `rebuild()` filtered
   * (`isPublished: true, isPrivate: false` in a since-removed `knex` query, recovered via `git log
   * --all` for reference). That filter predates this schema's `hasPassword`/`publishState` index
   * fields (task #557's design decision #1): this module already routes a protected or draft page's
   * visibility through those fields at *query* time (`buildFilter`, `runProtectedSplitQuery`), the same
   * way the `db` engine's own `rebuild()` reindexes every page and leaves `isSearchable` to query time.
   * Filtering here too would leave a draft or password-protected page permanently missing from the
   * index after any rebuild, even though an editor's `includeDrafts` search or a password page's
   * title/description are both meant to still find it — a regression `created`/`updated` do not have.
   *
   * Each locale's rows are paginated through `pageSource.pageBatch` (`REBUILD_BATCH_SIZE` at a time)
   * and every batch's documents are pushed through `mergeOrUploadDocuments` before the next page of
   * rows is read, so the working set stays one batch wide regardless of site size.
   *
   * Purges ghost documents afterwards (OpenProject #922): `mergeOrUploadDocuments` only ever upserts,
   * so a page deleted while this engine was unreachable -- the exact scenario `indexPage`'s own doc
   * comment names as what a later rebuild is supposed to put right -- stayed in the index forever.
   * Every id currently in the index for this site (`fetchAllIds`, a siteId-filtered query) that was not
   * just re-uploaded is stale and gets removed with `deleteDocuments`, itself chunked to
   * `REBUILD_BATCH_SIZE` per call the same way the upload loop above is -- a site whose deletions
   * outnumber Azure's own per-request action/payload limits would otherwise fail the single call this
   * used to make outright.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const locales = await this.pageSource.locales(siteId)
    WIKI.logger.debug('search', 'rebuilding the index', {
      engine: MODULE_KEY,
      site: siteId,
      locales: locales.length
    })
    const client = this.queryClientFor(siteId, this.configFor(siteId))
    const existingIds = await this.fetchAllIds(client, siteId)
    const uploadedIds = new Set<string>()
    const result: RebuildResult = { pages: 0, locales: [] }

    for (const locale of locales) {
      let localePages = 0
      for await (const batch of localePageStream(this.pageSource, siteId, locale)) {
        await client.mergeOrUploadDocuments(batch.map(toIndexDocument))
        for (const page of batch) {
          uploadedIds.add(page.id)
        }
        localePages += batch.length
      }

      result.pages += localePages
      result.locales.push({ locale, pages: localePages })
      WIKI.logger.debug('search', 'locale reindexed', {
        engine: MODULE_KEY,
        locale,
        pages: localePages
      })
    }

    const staleIds = existingIds.filter((id) => !uploadedIds.has(id))
    if (staleIds.length > 0) {
      for (const idBatch of chunk(staleIds, REBUILD_BATCH_SIZE)) {
        await client.deleteDocuments('id', idBatch)
      }
      WIKI.logger.info('search', 'purged stale documents', {
        engine: MODULE_KEY,
        site: siteId,
        documents: staleIds.length
      })
    }

    WIKI.logger.info('search', 'index rebuild completed', {
      engine: MODULE_KEY,
      site: siteId,
      pages: result.pages,
      locales: result.locales.length
    })
    return result
  }
}

export default new AzureSearchModule()
