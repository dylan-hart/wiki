import fs from 'node:fs'
import { Client } from '@elastic/elasticsearch'
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
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls'
import type { SearchDocument } from '../shared.ts'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchPagesParams,
  SearchPagesResult
} from '../../../models/search.ts'

/** Must match the directory name holding this module's `definition.yml`. */
const MODULE_KEY = 'elasticsearch'

/**
 * Elasticsearch's bulk API is bounded by the overall HTTP body size rather than a fixed per-object
 * limit, so unlike the Algolia module there is no per-document byte cap alongside the batch limits.
 */
export interface BulkOperation {
  id: string
  document: SearchDocument
}

/**
 * Text fields are boosted at query time, not here — Elasticsearch removed mapping-time `boost`.
 * `path` stays `text` so a prefix filter can use `match_phrase_prefix`, while `editor` and
 * `publishState` are `keyword` so they support exact-match filtering. `siteId` is not a
 * `SearchPagesParams` filter, but every document carries it and every query and rebuild is scoped to
 * it: more than one site can share an index, which is otherwise indistinguishable from one site's.
 */
const INDEX_MAPPINGS = {
  properties: {
    siteId: { type: 'keyword' },
    title: { type: 'text' },
    description: { type: 'text' },
    content: { type: 'text' },
    tags: { type: 'text' },
    path: { type: 'text' },
    locale: { type: 'keyword' },
    editor: { type: 'keyword' },
    publishState: { type: 'keyword' },
    icon: { type: 'keyword' },
    isSearchable: { type: 'boolean' },
    classification: { type: 'keyword' },
    updatedAt: { type: 'date' }
  }
} as const

/**
 * An operator-supplied CA file is deliberately ignored when `verifyTLSCertificate` is off: with
 * verification disabled there is nothing for it to verify against.
 */
export function getTlsOptions(config: Record<string, any>): TlsConnectionOptions {
  if (!config.tlsCertPath) {
    return { rejectUnauthorized: config.verifyTLSCertificate }
  }
  const ca: Buffer[] = []
  if (config.verifyTLSCertificate) {
    ca.push(fs.readFileSync(config.tlsCertPath))
  }
  return { rejectUnauthorized: config.verifyTLSCertificate, ca }
}

/**
 * `definition.yml` documents and the admin area collects this in *seconds*, while the client option
 * expects milliseconds. Anything not positive means disabled, which the SDK spells as `false`.
 */
export function toSniffIntervalMs(sniffInterval: unknown): number | false {
  return typeof sniffInterval === 'number' && sniffInterval > 0 ? sniffInterval * 1000 : false
}

/**
 * No search terms falls back to `match_all`, so a browse of nothing but filters still returns rows.
 */
export function buildEsQuery(params: SearchPagesParams): Record<string, any> {
  const {
    siteId,
    query = '',
    path = '',
    locales = [],
    tags = [],
    editor = '',
    publishState = '',
    publicOnly = false,
    includeDrafts = false
  } = params
  const terms = query.trim()

  const filter: Record<string, any>[] = [{ term: { siteId } }, { term: { isSearchable: true } }]

  // -> Matches what a page view shows an anonymous reader, so search cannot surface a page that
  //    could not then be opened.
  if (publicOnly) {
    filter.push({ term: { publishState: 'published' } })
  } else if (!includeDrafts) {
    filter.push({ bool: { must_not: [{ term: { publishState: 'draft' } }] } })
  }
  // -> Additional to the branch above, not a replacement: both apply as separate ANDed conditions.
  if (publishState) {
    filter.push({ term: { publishState } })
  }
  if (path) {
    filter.push({ match_phrase_prefix: { path } })
  }
  if (locales.length > 0) {
    filter.push({ terms: { locale: locales } })
  }
  // -> ANDed clauses rather than an OR group: every named tag must be present.
  for (const tag of tags) {
    filter.push({ match: { tags: tag } })
  }
  if (editor) {
    filter.push({ term: { editor } })
  }

  const must =
    terms.length > 0
      ? [
          {
            simple_query_string: {
              query: terms,
              fields: ['title^10', 'description^3', 'tags^8', 'content'],
              default_operator: 'and'
            }
          }
        ]
      : [{ match_all: {} }]

  return { bool: { must, filter } }
}

/**
 * A batch is sized by its documents alone — the `{ index: { _index, _id } }` action line each one
 * rides with in the bulk body is not counted against `MAX_INDEXING_BYTES`.
 */
export function batchOperations(ops: BulkOperation[]): BulkOperation[][] {
  return batchBySize(ops, {
    sizeOf: (op) => Buffer.byteLength(JSON.stringify(op.document)),
    maxBytes: MAX_INDEXING_BYTES,
    maxCount: MAX_INDEXING_COUNT
  }).batches
}

interface SiteClient {
  client: Client
  indexName: string
  configKey: string
}

/**
 * Targets one current `@elastic/elasticsearch` major rather than carrying an `apiVersion` selector
 * over several pinned client packages: legacy fallbacks are ruled out here on principle.
 *
 * Every hook resolves its own client through `getClient()` rather than depending on `init()` having
 * run first.
 */
export class ElasticsearchSearchModule extends ExternalSearchModule {
  protected readonly engine = MODULE_KEY
  private clients = new Map<string, SiteClient>()

  /** Its own method so a test can override it on an instance rather than need a live cluster. */
  private createClient(config: Record<string, any>): Client {
    const hosts = `${config.hosts ?? ''}`
      .split(',')
      .map((host: string) => host.trim())
      .filter((host: string) => host.length > 0)
    return new Client({
      nodes: hosts,
      tls: getTlsOptions(config),
      sniffOnStart: !!config.sniffOnStart,
      sniffInterval: toSniffIntervalMs(config.sniffInterval),
      name: 'wiki-js'
    })
  }

  private async ensureIndex(client: Client, indexName: string, analyzer: string): Promise<void> {
    const exists = await client.indices.exists({ index: indexName })
    if (exists) {
      return
    }
    CARDINAL.logger.info('search', 'creating the index', {
      engine: MODULE_KEY,
      index: indexName
    })
    await client.indices.create({
      index: indexName,
      mappings: INDEX_MAPPINGS as any,
      settings: {
        analysis: {
          analyzer: { default: { type: analyzer as any } }
        }
      }
    })
  }

  private async getClient(siteId: string): Promise<SiteClient> {
    const config = fillEmptyStringDefaults(search.getEngineConfig(siteId, MODULE_KEY), MODULE_KEY)
    const configKey = JSON.stringify(config)
    const cached = this.clients.get(siteId)
    if (cached && cached.configKey === configKey) {
      return cached
    }
    const client = this.createClient(config)
    const indexName = config.indexName
    await this.ensureIndex(client, indexName, config.analyzer)
    const entry: SiteClient = { client, indexName, configKey }
    this.clients.set(siteId, entry)
    return entry
  }

  async init(siteId: string, incoming: Record<string, any>): Promise<void> {
    const config = fillEmptyStringDefaults(incoming, MODULE_KEY)
    const client = this.createClient(config)
    const indexName = config.indexName
    await this.ensureIndex(client, indexName, config.analyzer)
    this.clients.set(siteId, { client, indexName, configKey: JSON.stringify(config) })
  }

  protected async indexPage(page: SearchIndexablePage): Promise<void> {
    await this.neverThrows(
      async () => {
        const { client, indexName } = await this.getClient(page.siteId)
        await client.index({
          index: indexName,
          id: page.id,
          document: buildSearchDocument(page),
          refresh: true
        })
      },
      'indexing a page failed',
      { page: page.id }
    )
  }

  protected async removePage(siteId: string, pageId: string): Promise<void> {
    await this.neverThrows(
      async () => {
        const { client, indexName } = await this.getClient(siteId)
        await client.delete({ index: indexName, id: pageId, refresh: true })
      },
      'removing a page from the index failed',
      { page: pageId }
    )
  }

  async query(params: SearchPagesParams): Promise<SearchPagesResult> {
    const { siteId, offset = 0, limit = 25, actor } = params
    const { client, indexName } = await this.getClient(siteId)

    /*
      A bounded window from the START of the result set, not the caller's own `offset`/`size`: page
      rule filtering happens after the query and needs a wider window to fill a page from once
      denied hits are dropped. `results` and `totalHits` both derive from `visible` alone.
    */
    const response = await client.search<SearchDocument>({
      index: indexName,
      from: 0,
      size: SCAN_CAP,
      query: buildEsQuery(params) as any,
      _source: [
        'title',
        'description',
        'path',
        'locale',
        'tags',
        'icon',
        'classification',
        'updatedAt'
      ]
    })
    const hits = (response.hits?.hits ?? []).filter((hit) => hit._source)

    const visible = filterVisible(hits, actor, siteId, (hit) => ({
      path: hit._source!.path,
      locale: hit._source!.locale,
      tags: hit._source!.tags ?? [],
      classification: hit._source!.classification ?? null
    }))

    return toSearchPagesResult(hits, visible, {
      offset,
      limit,
      toResult: (hit) => {
        const source = hit._source!
        return {
          id: hit._id!,
          path: source.path,
          locale: source.locale,
          title: source.title,
          description: source.description || null,
          icon: source.icon ?? null,
          tags: source.tags ?? [],
          updatedAt: source.updatedAt,
          relevancy: hit._score ?? 0,
          highlight: null
        }
      }
    })
  }

  /**
   * Clears by `delete_by_query` on `siteId` rather than dropping and recreating the index, since
   * more than one site can share one. Rows are streamed and bulk-sent a page at a time, so the whole
   * table is never held in memory.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const PAGE_SIZE = 500
    const { client, indexName } = await this.getClient(siteId)

    CARDINAL.logger.debug('search', 'rebuilding the index', { engine: MODULE_KEY, site: siteId })
    await client.deleteByQuery({
      index: indexName,
      query: { term: { siteId } },
      conflicts: 'proceed',
      refresh: true
    })

    const pageCounts: Record<string, number> = {}
    let total = 0

    for await (const rows of pageStream(siteId, { pageSize: PAGE_SIZE })) {
      const ops = rows.map((row) => ({
        id: row.id,
        document: buildSearchDocument(row)
      }))
      for (const batch of batchOperations(ops)) {
        await client.bulk({
          index: indexName,
          operations: batch.flatMap(({ id, document }) => [
            { index: { _index: indexName, _id: id } },
            document
          ]),
          refresh: true
        })
        total += batch.length
      }
      for (const row of rows) {
        pageCounts[row.locale] = (pageCounts[row.locale] ?? 0) + 1
      }
    }

    CARDINAL.logger.info('search', 'index rebuild completed', {
      engine: MODULE_KEY,
      site: siteId,
      pages: total
    })
    return {
      pages: total,
      // -> No text search dictionary exists here, but `RebuildResult` requires the field.
      locales: Object.entries(pageCounts).map(([locale, pages]) => ({
        locale,
        dictionary: 'n/a',
        pages
      }))
    }
  }
}

export default new ElasticsearchSearchModule()
