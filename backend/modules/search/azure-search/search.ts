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

/** Must match the directory name of this module's `definition.yml`. */
const MODULE_KEY = 'azure-search'

/** Set as each index's default scoring profile, so a query needs no `scoringProfile` parameter. */
const SCORING_PROFILE_NAME = 'wikiRelevancy'

const FULL_SEARCH_FIELDS = ['title', 'description', 'content']

const PROTECTED_SEARCH_FIELDS = ['title', 'description']

/** One fragment each, matching the `db` engine's `ts_headline` (`MaxFragments=1`). */
const HIGHLIGHT_FIELDS = 'content-1,description-1'

/**
 * Narrowed to what this module calls rather than importing the SDK's own type: a test can implement
 * it with a fake that records calls, without pulling in `@azure/search-documents`' full surface.
 */
export interface AzureSearchIndexClient {
  createOrUpdateIndex(index: SearchIndex): Promise<SearchIndex>
}

export interface AzureSearchRow {
  document: Record<string, any>
  score: number
  highlights?: Record<string, string[]>
}

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

/** Narrowed like `AzureSearchIndexClient`, and to keep the SDK's generic `TModel` off call sites. */
export interface AzureSearchQueryClient {
  mergeOrUploadDocuments(documents: Record<string, any>[]): Promise<void>
  deleteDocuments(keyName: string, keyValues: string[]): Promise<void>
  search(
    searchText: string | undefined,
    options: AzureSearchQueryOptions
  ): Promise<{ count?: number; results: AsyncIterable<AzureSearchRow> }>
}

function defaultClientFactory(config: Record<string, any>): AzureSearchIndexClient {
  const endpoint = `https://${config.serviceName}.search.windows.net`
  return new SearchIndexClient(endpoint, new AzureKeyCredential(config.adminApiKey))
}

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
 * `hasPassword` is indexed because an external engine has no page row to check `password IS NULL`
 * against; `runProtectedSplitQuery` filters on it instead.
 *
 * `path` is both `filterable` (a plain `startswith` prefix) and `searchable` (so `search.ismatch`
 * can handle a `*` wildcard) — which is why every free-text query lists its own `searchFields`
 * rather than relying on "every searchable field", or it would start matching on `path` too.
 *
 * The scoring profile is set because Azure's default weights every matched field equally, so a
 * title match would not otherwise outrank a passing mention in the body.
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
    // -> `toString()` defaults to nanosecond precision; the rest of the codebase emits milliseconds.
    updatedAt: page.updatedAt.toTemporalInstant().toString({ smallestUnit: 'millisecond' })
  }
}

function escapeODataLiteral(value: string): string {
  return value.replaceAll("'", "''")
}

/** `search.in()`'s list delimiter: not a comma, so a value containing one stays safe. */
const IN_DELIMITER = '|'

function eqFilter(field: string, value: string): string {
  return `${field} eq '${escapeODataLiteral(value)}'`
}

function inFilter(field: string, values: string[]): string {
  const list = values.map((v) => escapeODataLiteral(v)).join(IN_DELIMITER)
  return `search.in(${field}, '${list}', '${IN_DELIMITER}')`
}

/**
 * A plain prefix uses OData's own `startswith`; a pattern containing `*` needs `search.ismatch`,
 * the only filter function that understands Lucene wildcard syntax.
 */
function pathFilter(path: string): string {
  const escaped = escapeODataLiteral(path)
  return path.includes('*')
    ? `search.ismatch('${escaped}', 'path', 'full', 'any')`
    : `startswith(path, '${escaped}')`
}

function publishStateFilters(
  publishState: string,
  publicOnly: boolean,
  includeDrafts: boolean
): string[] {
  const clauses: string[] = []
  if (publicOnly) {
    // -> Search must not surface a page an anonymous reader could not then open
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
  hasPassword?: boolean
}

/** `tags` matches any-of, not all-of: a document qualifies if any of its tags is in the set. */
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

export function buildOrderBy(orderBy: SearchOrderBy, direction: 'asc' | 'desc'): string[] {
  const dir = direction === 'asc' ? 'asc' : 'desc'
  if (orderBy === 'relevancy') {
    return [`search.score() ${dir}`]
  }
  return [`${orderBy} ${dir}`]
}

function normalizeHighlight(highlights: Record<string, string[]> | undefined): string | null {
  return normalizeMarkers(highlights?.content?.[0] ?? highlights?.description?.[0])
}

/** Mirrors Azure's own `$orderby`, so two already-sorted result sets merge in the right order. */
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
 * Both clients come in through factories rather than being built against the SDK directly: there is
 * no local Azure AI Search emulator, so a fake is the only way a test can exercise these hooks
 * without a real Azure resource, network call or credential.
 */
export class AzureSearchModule extends ExternalSearchModule {
  protected readonly engine = MODULE_KEY
  private readonly clientFactory: (config: Record<string, any>) => AzureSearchIndexClient
  private readonly searchClientFactory: (config: Record<string, any>) => AzureSearchQueryClient
  private readonly pageSource: RebuildPageSource
  /**
   * Tagged with the config (as JSON) it was built from, so editing `serviceName`/`adminApiKey`/
   * `indexName` invalidates the cached client on the next call rather than at the next restart.
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
   * `fillEmptyStringDefaults` covers what `getEngineConfig`'s merge cannot: a field the operator
   * cleared is stored as `''`, which the merge treats as a real value, so a blanked `indexName`
   * would otherwise reach Azure as an empty index name.
   */
  private configFor(siteId: string): Record<string, any> {
    return fillEmptyStringDefaults(search.getEngineConfig(siteId, MODULE_KEY), MODULE_KEY)
  }

  /**
   * `createOrUpdateIndex` is a PUT keyed by index name, so re-provisioning on every boot is safe by
   * construction and needs no fetch-and-diff here. It only stops being safe if `buildIndexSchema`
   * is later changed incompatibly for an index that already holds documents — flipping `filterable`
   * on an existing field, say.
   */
  async init(siteId: string, incoming: Record<string, any>): Promise<void> {
    const config = fillEmptyStringDefaults(incoming, MODULE_KEY)
    const indexName = config.indexName
    const client = this.clientFor(siteId, config)
    await client.createOrUpdateIndex(buildIndexSchema(indexName))
    CARDINAL.logger.info('search', 'index provisioned', {
      engine: MODULE_KEY,
      index: indexName,
      site: siteId
    })
  }

  /**
   * Never throws (`ExternalSearchModule#neverThrows`): a page that saved correctly must not report
   * failure because its index entry could not be written. A later `rebuild()` repairs a missed write.
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

  /** Never throws — same contract as `indexPage`. */
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

  /** Paginated and `id`-only, so a large index is never pulled through in one request. */
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
   * An absent `searchText` is Azure's "match every document" (`search=*`), which is what turns a
   * tags-or-filters-only call into a browse. `hideProtectedContent` only matters alongside a query:
   * with no query there is no body text to leak.
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
      Both branches scan a bounded window from the START of the result set (`SCAN_CAP`, `skip: 0`),
      never the caller's own `offset`/`limit`: page-rule filtering happens after the query, so the
      requested page has to be sliced out of what survived it rather than out of what Azure returned.
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
        // -> `totalHits` is derived from rows that survived `checkAccess`, never Azure's own count
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
   * A protected page is findable by name, not by what it says: the public half runs the ordinary
   * full-text query, the protected half is scoped to `title`/`description` and asks for no
   * highlights, so terms only in the text behind the password neither match nor come back as an
   * excerpt. Two queries rather than one because an external index has no per-row SQL expression to
   * branch on the way `db`'s headline `CASE WHEN p.password IS NULL` does.
   *
   * Merged but deliberately not sliced to the requested page: the caller still drops every row
   * `checkAccess()` denies, so slicing here would let a denied row occupy a slot in that page.
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
        // -> No `highlightFields`: a protected page never returns an excerpt
      })
    ])
    return [...publicResult.rows, ...protectedResult.rows].sort((a, b) =>
      compareRows(a, b, orderBy, orderByDirection)
    )
  }

  /**
   * Streams every locale a batch at a time rather than doing the `db` engine's single SQL `UPDATE`:
   * there is no equivalent primitive against an external index, and a whole site's pages must not
   * have to fit in memory at once to be reindexed.
   *
   * Indexes every page unconditionally, drafts and password-protected ones included. Their
   * visibility is decided at query time from the `hasPassword`/`publishState` index fields, so
   * filtering here would instead leave them permanently missing after a rebuild, unfindable even to
   * an editor searching with `includeDrafts`.
   *
   * `mergeOrUploadDocuments` only ever upserts, so a page deleted while this engine was unreachable
   * would stay indexed forever; anything in the index that was not just re-uploaded is deleted
   * afterwards, chunked because Azure caps the actions and payload size of a single request.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const locales = await this.pageSource.locales(siteId)
    CARDINAL.logger.debug('search', 'rebuilding the index', {
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
      CARDINAL.logger.debug('search', 'locale reindexed', {
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
      CARDINAL.logger.info('search', 'purged stale documents', {
        engine: MODULE_KEY,
        site: siteId,
        documents: staleIds.length
      })
    }

    CARDINAL.logger.info('search', 'index rebuild completed', {
      engine: MODULE_KEY,
      site: siteId,
      pages: result.pages,
      locales: result.locales.length
    })
    return result
  }
}

export default new AzureSearchModule()
