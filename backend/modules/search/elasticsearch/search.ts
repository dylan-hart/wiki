import fs from 'node:fs'
import { Client } from '@elastic/elasticsearch'
import { and, asc, eq, gt } from 'drizzle-orm'
import { pages as pagesTable } from '../../../db/schema.ts'
import { search } from '../../../models/search.ts'
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls'
import type { SQL } from 'drizzle-orm'
import type {
  RebuildResult,
  SearchIndexablePage,
  SearchModule,
  SearchPagesParams,
  SearchPagesResult,
  SearchResult
} from '../../../models/search.ts'

/** This module's own key, i.e. the directory name of its `definition.yml`. */
const MODULE_KEY = 'elasticsearch'

/**
 * Batching limits for `rebuild()`'s `client.bulk` calls, carried over unchanged from 2.5.x's
 * `server/modules/search/elasticsearch/engine.js` (`git show main:server/modules/search/elasticsearch/engine.js`,
 * the last version of that file, on the 2.x line this fork's history never merged from — see
 * `docs/variances.md`). Unlike its Algolia sibling, 2.5.x's Elasticsearch engine has no per-document
 * byte cap: Elasticsearch's bulk API is bounded by the overall HTTP body size, not a fixed per-object
 * limit the way Algolia's API is, so only the batch-level caps are ported.
 */
export const MAX_INDEXING_BYTES = 10 * 2 ** 20 - Buffer.byteLength('[') - Buffer.byteLength(']') // 10 MB
export const MAX_INDEXING_COUNT = 1000
const COMMA_BYTES = Buffer.byteLength(',')

/**
 * Ceiling on how many of Elasticsearch's own matches `query()` scans before deriving `totalHits`
 * and the requested page from what survives `checkAccess()` (OpenProject #2156, mirroring
 * `db/search.ts`'s own `SCAN_CAP` — see that module's `query()` for the full reasoning). Bounded
 * rather than unbounded, since page-rule filtering cannot be expressed as an Elasticsearch query
 * clause and has to run per-hit in this process.
 */
const SCAN_CAP = 500

/** An Elasticsearch document, as written by `pageToDocument` and read back by `query()`. */
export interface ElasticsearchPageDocument {
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
  /** Classification level id (OpenProject #1079) — what `query()` checks a CLASSIFICATION rule against. */
  classification: string
  updatedAt: string
  /** Absent for a password-protected page — same reasoning as the Algolia module's `pageToDocument`:
   *  a value once sent to an external service can't be un-sent by a later query-time bug. */
  content?: string
}

/** One `rebuild()` bulk operation: the page id (the document's Elasticsearch `_id`) plus its body. */
export interface BulkOperation {
  id: string
  document: ElasticsearchPageDocument
}

/**
 * The mapping every index this module manages is created with.
 *
 * `title`/`description`/`content`/`tags` are 2.5.x's original text fields (boosted at query time
 * instead of in the mapping — 2.5.x's own 8.x branch already dropped mapping-time `boost`, since
 * Elasticsearch removed it; this module targets one current major, so there was never a mapping-time
 * boost to carry over). `locale` was already a `keyword` in 2.5.x. `path`, `editor`, `publishState`
 * are new beyond 2.5.x: `path` stays `text` so a prefix filter can use `match_phrase_prefix`, while
 * `editor` and `publishState` are `keyword` so they support exact-match filtering the way
 * `db/search.ts`'s `editor`/`publishState` equality filters do. `siteId` is not one of this repo's
 * `SearchPagesParams` filters — it isn't a search *option* the way `editor` is — but every document
 * still carries it as a `keyword`, and every query and rebuild below is scoped to it: 2.5.x had no
 * concept of more than one site sharing an index, and this repo does, so an index can't tell two
 * sites' pages apart without it.
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
    // -> OpenProject #1125: what `query()` checks a CLASSIFICATION rule against, populated at index
    //    time from `pages.classification` the same way `tags`/`editor`/`publishState` already are.
    classification: { type: 'keyword' },
    updatedAt: { type: 'date' }
  }
} as const

/**
 * The TLS options passed to the Elasticsearch client, ported directly from 2.5.x's `getTlsOptions`
 * (`server/modules/search/elasticsearch/engine.js`, `git show main:...`): reject an unverifiable
 * certificate unless told not to, and trust an operator-supplied CA certificate file only when
 * verification is on. Faithful port, not a fix — a `tlsCertPath` given alongside
 * `verifyTLSCertificate: false` is loaded by neither this nor 2.5.x's version, the same as it always
 * was.
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
 * `sniffInterval` in milliseconds, the unit `@elastic/elasticsearch`'s client option actually expects
 * (OpenProject #923) -- `definition.yml` documents and the admin area collects the value in *seconds*
 * ("Interval in seconds to check for an updated list of nodes..."), so the stored config value has to
 * be multiplied here rather than passed straight through. `0` (or anything not positive) still means
 * "disabled", matching the definition's own "0 disables it" and the SDK's own `false` sentinel for that.
 *
 * Its own exported function -- like `getTlsOptions` above -- so the conversion is a plain unit test
 * rather than something only checkable by inspecting a constructed `Client`'s internal transport state.
 */
export function toSniffIntervalMs(sniffInterval: unknown): number | false {
  return typeof sniffInterval === 'number' && sniffInterval > 0 ? sniffInterval * 1000 : false
}

/**
 * A page row, as an Elasticsearch document. See `INDEX_MAPPINGS`'s doc comment for why `siteId`
 * travels on every document despite not being one of `SearchPagesParams`' own filters.
 */
export function pageToDocument(page: SearchIndexablePage): ElasticsearchPageDocument {
  const updatedAt =
    page.updatedAt instanceof Date
      ? page.updatedAt.toISOString()
      : (page.updatedAt as unknown as string)
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
 * The `query` DSL object for one `query()` call: a `simple_query_string` over the boosted text fields
 * (or `match_all` with no search terms, so a browse of nothing but filters still returns something) as
 * `must`, plus everything `SearchPagesParams` says about *which* pages should come back as `filter`
 * clauses — mirroring `db/search.ts`'s `WHERE` and the Algolia module's `buildFilters()`.
 *
 * `isSearchable` and `siteId` are unconditional, the same way `db/search.ts` always adds
 * `p."isSearchable" = true` and scopes to `p."siteId"` regardless of what the caller passed.
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

  // -> Matches what a page view shows an anonymous reader, so search cannot surface a page that could
  //    not then be opened -- same reasoning as `db/search.ts`'s `publicOnly` branch.
  if (publicOnly) {
    filter.push({ term: { publishState: 'published' } })
  } else if (!includeDrafts) {
    filter.push({ bool: { must_not: [{ term: { publishState: 'draft' } }] } })
  }
  // -> An explicit `publishState` filter is additional to, not a replacement for, the branch above --
  //    same as `db/search.ts`, which applies both as separate ANDed conditions.
  if (publishState) {
    filter.push({ term: { publishState } })
  }
  if (path) {
    filter.push({ match_phrase_prefix: { path } })
  }
  if (locales.length > 0) {
    filter.push({ terms: { locale: locales } })
  }
  // -> Every named tag must be present, mirroring `db/search.ts`'s `p.tags @> tags` containment check
  //    -- ANDed clauses rather than an OR group.
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
 * Group a flat list of `(id, document)` pairs into batches no larger than Elasticsearch's bulk
 * batching limits (`MAX_INDEXING_BYTES`, `MAX_INDEXING_COUNT`), exactly reproducing 2.5.x's
 * `processDocument`/`flushBuffer` buffering. Pure and synchronous on purpose, the same reasoning as
 * the Algolia module's `batchDocuments`: `rebuild()` is the only caller, and keeping the size
 * arithmetic separate from anything that awaits a network call is what lets it be exercised directly.
 */
export function batchOperations(ops: BulkOperation[]): BulkOperation[][] {
  const batches: BulkOperation[][] = []
  let current: BulkOperation[] = []
  let bytes = 0

  for (const op of ops) {
    const opBytes = Buffer.byteLength(JSON.stringify(op.document))
    if (current.length > 0 && opBytes + COMMA_BYTES + bytes >= MAX_INDEXING_BYTES) {
      batches.push(current)
      current = []
      bytes = 0
    }
    if (current.length > 0) {
      bytes += COMMA_BYTES
    }
    bytes += opBytes
    current.push(op)
    if (current.length >= MAX_INDEXING_COUNT) {
      batches.push(current)
      current = []
      bytes = 0
    }
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}

/** One site's live Elasticsearch client, plus the index it was built for. */
interface SiteClient {
  client: Client
  indexName: string
  /** The engine config this client was built from (as JSON), so a config change invalidates it. */
  configKey: string
}

/**
 * The `elasticsearch` search module: pages pushed to, and queried from, an Elasticsearch index rather
 * than this database.
 *
 * Ported from 2.5.x's `server/modules/search/elasticsearch/engine.js`, with one deliberate
 * simplification: 2.5.x's `apiVersion` selector (`6.x` / `7.x` / `8.x`, each loading a differently
 * pinned `elasticsearchN` package) is dropped entirely in favor of targeting the single current
 * `@elastic/elasticsearch` major (9.x). This branch's CLAUDE.md rules out legacy fallbacks and
 * deprecated aliases on principle, and three parallel client majors behind a switch is exactly that --
 * dead weight for versions of a self-hosted dependency an operator installing this feature today has
 * no reason to still be running. Recorded in `docs/variances.md`.
 *
 * State (`clients`) and lazy per-site resolution follow the Algolia module's `AlgoliaSearchModule`
 * exactly, for the same reason: `models/search.ts`'s `selectEngine()`/`initActiveEngines()` do call
 * `init()` now (OpenProject #920, see that module's class doc comment), but every hook here still
 * resolves its own client through `getClient()` independently rather than depending on `init()` having
 * run first.
 */
export class ElasticsearchSearchModule implements SearchModule {
  private clients = new Map<string, SiteClient>()

  /**
   * Build a real Elasticsearch client. Its own method only so a test can override it on an instance
   * (`(mod as any).createClient = () => fakeClient`) without a live cluster.
   */
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

  /** Create the index if it does not already exist yet, with this module's mapping and analyzer. */
  private async ensureIndex(client: Client, indexName: string, analyzer: string): Promise<void> {
    const exists = await client.indices.exists({ index: indexName })
    if (exists) {
      return
    }
    WIKI.logger.info(`(SEARCH/ELASTICSEARCH) Creating index ${indexName}...`)
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

  /** Build (or reuse) the Elasticsearch client for a site, from whatever config is currently stored. */
  private async getClient(siteId: string): Promise<SiteClient> {
    const config = search.getEngineConfig(siteId, MODULE_KEY)
    const configKey = JSON.stringify(config)
    const cached = this.clients.get(siteId)
    if (cached && cached.configKey === configKey) {
      return cached
    }
    const client = this.createClient(config)
    const indexName = config.indexName || 'wiki'
    await this.ensureIndex(client, indexName, config.analyzer || 'standard')
    const entry: SiteClient = { client, indexName, configKey }
    this.clients.set(siteId, entry)
    return entry
  }

  /**
   * Connect and ensure the index exists for a site as soon as it is (re)configured, and cache the
   * client `query`/`created`/etc. reuse afterwards -- see the class doc comment for why every other
   * hook does not strictly depend on this having been called first.
   */
  async init(siteId: string, config: Record<string, any>): Promise<void> {
    const client = this.createClient(config)
    const indexName = config.indexName || 'wiki'
    await this.ensureIndex(client, indexName, config.analyzer || 'standard')
    this.clients.set(siteId, { client, indexName, configKey: JSON.stringify(config) })
  }

  async created(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page)
  }

  async updated(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page)
  }

  /**
   * Never throws: a page that saved correctly must not report failure because Elasticsearch could not
   * be reached -- same reasoning, and same try/catch shape, as `db/search.ts` and the Algolia module.
   */
  private async indexPage(page: SearchIndexablePage): Promise<void> {
    try {
      const { client, indexName } = await this.getClient(page.siteId)
      await client.index({
        index: indexName,
        id: page.id,
        document: pageToDocument(page),
        refresh: true
      })
    } catch (err: any) {
      WIKI.logger.warn(`(SEARCH/ELASTICSEARCH) Failed to index page ${page.id}: ${err.message}`)
    }
  }

  async deleted(siteId: string, pageId: string): Promise<void> {
    try {
      const { client, indexName } = await this.getClient(siteId)
      await client.delete({ index: indexName, id: pageId, refresh: true })
    } catch (err: any) {
      WIKI.logger.warn(
        `(SEARCH/ELASTICSEARCH) Failed to remove page ${pageId} from the index: ${err.message}`
      )
    }
  }

  /**
   * Unlike 2.5.x -- which derived a document's `_id` from a hash of its path and locale, so a rename
   * had to `delete` the old id and `index` a new one -- this schema's `pages.id` is a stable UUID a
   * move never touches (`models/pages.ts`'s `movePage` updates the row in place). A rename is
   * therefore an ordinary re-index of the same document via `client.index`, same as `created`/
   * `updated` -- the identical reasoning already recorded for the Algolia module's `renamed()` in
   * `docs/variances.md`. A locale change is rewritten by the same reindex, which is why this module
   * needs no `previousLocale` of its own either.
   */
  async renamed(_siteId: string, page: SearchIndexablePage, _previousPath: string): Promise<void> {
    await this.indexPage(page)
  }

  async query(params: SearchPagesParams): Promise<SearchPagesResult> {
    const { siteId, offset = 0, limit = 25, actor } = params
    const { client, indexName } = await this.getClient(siteId)

    /*
      OpenProject #2156 (mirroring #2151's fix to db/search.ts): fetches a bounded window from the
      START of the result set (`from: 0, size: SCAN_CAP`), not the caller's own `offset`/`size`,
      since page-rule filtering happens after the query and needs a wider window to fill a page
      from once denied hits are dropped. `results` and `totalHits` are both then derived from
      `visible` alone -- see `db/search.ts#query()`'s own comment for the full reasoning; this is
      the same fix, ported to Elasticsearch's `from`/`size` pagination.
    */
    const response = await client.search<ElasticsearchPageDocument>({
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

    /*
      Elasticsearch has no application-aware permission model of its own, so a hit it returns has to be
      filtered the same way `db/search.ts` filters its own rows: per-row, against the actor's page
      rules, since which rule applies can depend on a regular expression or a page's tags that no
      Elasticsearch filter clause could express.
    */
    const visible = actor
      ? hits.filter((hit) =>
          WIKI.models.groups.checkAccess(actor, 'read:pages', {
            path: hit._source!.path,
            locale: hit._source!.locale,
            siteId,
            tags: hit._source!.tags ?? [],
            // -> Indexed at write time by `pageToDocument` (OpenProject #1125) -- a document written
            //    before this field existed has none, which falls back to the same fail-closed `null`
            //    treatment `helpers/pageRules.ts` documents for a genuinely unknown classification. A
            //    full reindex (`rebuild()`) backfills every existing document with its real value.
            classification: hit._source!.classification ?? null
          })
        )
      : hits

    const results: SearchResult[] = visible.slice(offset, offset + limit).map((hit) => {
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
        // -> 2.5.x parity: its `query()` returned no excerpt either. A protected page's `content` is
        //    never indexed in the first place (`pageToDocument`), so there is nothing to highlight from
        //    for those regardless.
        highlight: null
      }
    })

    return {
      results,
      // -> OpenProject #2151/#2156: derived from `visible` alone -- never a count Elasticsearch
      //    reported before filtering, and therefore never able to exceed what the actor can
      //    actually read. Exact whenever the true match count is within SCAN_CAP; a floor beyond
      //    that (see the `query()` comment above), never an overcount.
      totalHits: visible.length,
      // -> No "did you mean" here: Elasticsearch's own fuzzy-suggestion features (a "suggest"
      //    context or a completion suggester) need dedicated index-side setup this module does not
      //    configure, unlike `db`'s pg_trgm similarity which needs nothing beyond the extension.
      suggestion: null
    }
  }

  /**
   * Recompute a site's Elasticsearch documents from the pages currently in the database.
   *
   * Scoped to `siteId` throughout -- a `delete_by_query` on the `siteId` filter rather than 2.5.x's
   * `indices.delete` + recreate, since (per `INDEX_MAPPINGS`'s doc comment) more than one site can
   * share an index here, and 2.5.x's version, with no such concept, could get away with dropping the
   * whole index. Recorded in `docs/variances.md`.
   *
   * Streamed in pages of `PAGE_SIZE` rows via keyset pagination on `id` (`WIKI.db` queries, replacing
   * 2.5.x's `WIKI.models.knex(...).stream()`), each page immediately regrouped into size-limited
   * batches by `batchOperations()` and sent with `client.bulk()` -- so the whole table is never held in
   * memory at once, the same property the old knex stream had.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const PAGE_SIZE = 500
    const { client, indexName } = await this.getClient(siteId)

    WIKI.logger.info('(SEARCH/ELASTICSEARCH) Rebuilding index...')
    await client.deleteByQuery({
      index: indexName,
      query: { term: { siteId } },
      conflicts: 'proceed',
      refresh: true
    })

    const pageCounts: Record<string, number> = {}
    let total = 0
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
        .limit(PAGE_SIZE)

      if (rows.length === 0) {
        break
      }

      const ops = rows.map((row) => ({
        id: row.id,
        document: pageToDocument(row as unknown as SearchIndexablePage)
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

      cursor = rows[rows.length - 1]!.id
      if (rows.length < PAGE_SIZE) {
        break
      }
    }

    WIKI.logger.info(`(SEARCH/ELASTICSEARCH) Indexed ${total} page(s) [ OK ]`)
    return {
      pages: total,
      // -> `dictionary` has no Elasticsearch equivalent -- there is no text search dictionary to
      //    report -- but `RebuildResult` requires the field, so it is marked not applicable rather than
      //    left to look like a real dictionary name.
      locales: Object.entries(pageCounts).map(([locale, pages]) => ({
        locale,
        dictionary: 'n/a',
        pages
      }))
    }
  }
}

export default new ElasticsearchSearchModule()
