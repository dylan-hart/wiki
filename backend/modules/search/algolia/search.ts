import { algoliasearch } from 'algoliasearch'
import { and, asc, eq, gt } from 'drizzle-orm'
import { pages as pagesTable } from '../../../db/schema.ts'
import { search } from '../../../models/search.ts'
import type { Algoliasearch } from 'algoliasearch'
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
const MODULE_KEY = 'algolia'

/**
 * Algolia's documented per-object and per-batch indexing limits, carried over unchanged from 2.5.x's
 * `server/modules/search/algolia/engine.js` (`git show 343d4db0:server/modules/search/algolia/engine.js`),
 * which is the reference this module's `rebuild()` batching reproduces.
 */
export const MAX_DOCUMENT_BYTES = 10 * 2 ** 10 // 10 KB
export const MAX_INDEXING_BYTES = 10 * 2 ** 20 - Buffer.byteLength('[') - Buffer.byteLength(']') // 10 MB
export const MAX_INDEXING_COUNT = 1000
const COMMA_BYTES = Buffer.byteLength(',')

/** An Algolia record, as written by `pageToDocument` and read back by `query()`. */
export interface AlgoliaPageDocument {
  objectID: string
  siteId: string
  locale: string
  path: string
  pathAncestors: string[]
  title: string
  description: string
  icon: string | null
  tags: string[]
  editor: string
  publishState: string
  isSearchable: boolean
  updatedAt: string
  /** Absent for a password-protected page — see `pageToDocument`'s doc comment for why. */
  content?: string
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
    path = '',
    locales = [],
    tags = [],
    editor = '',
    publishState = '',
    publicOnly = false,
    includeDrafts = false
  } = params

  const clauses = ['isSearchable:true']

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
 * A page row, as an Algolia record.
 *
 * `content` is omitted entirely for a password-protected page, rather than sent and relied on to stay
 * hidden by a query-time flag: Algolia is a third party, and once a value has been transmitted to it,
 * a bug in a later `hideProtectedContent` check can no longer un-send it. Leaving `content` out means
 * such a page is only ever findable by its title or description -- which is exactly the set
 * `db/search.ts`'s `ts_filter(p.ts, '{a,b}')` restricts a protected page to -- without this module ever
 * depending on that restriction being re-checked correctly on every read.
 */
export function pageToDocument(page: SearchIndexablePage): AlgoliaPageDocument {
  const updatedAt =
    page.updatedAt instanceof Date
      ? page.updatedAt.toISOString()
      : (page.updatedAt as unknown as string)
  return {
    objectID: page.id,
    siteId: page.siteId,
    locale: page.locale,
    path: page.path,
    pathAncestors: pathAncestors(page.path),
    title: page.title,
    description: page.description ?? '',
    icon: page.icon ?? null,
    tags: page.tags ?? [],
    editor: page.editor,
    publishState: page.publishState,
    isSearchable: page.isSearchable,
    updatedAt,
    ...(page.password ? {} : { content: page.searchContent ?? '' })
  }
}

/**
 * Group an already-built list of Algolia documents into batches no larger than Algolia's documented
 * limits, exactly reproducing 2.5.x's `processDocument`/`flushBuffer` buffering
 * (`server/modules/search/algolia/engine.js`, `git show 343d4db0:...`): a soft cap of
 * `MAX_INDEXING_COUNT` objects per batch, a hard cap of `MAX_INDEXING_BYTES` serialized bytes per
 * batch (accounting for the `,` joining each object once stringified into a JSON array), and a
 * per-object hard cap of `MAX_DOCUMENT_BYTES`.
 *
 * Pure and synchronous on purpose: `rebuild()` is the only caller, and keeping the size arithmetic
 * separate from anything that awaits a network call is what lets it be exercised directly, with plain
 * arrays, rather than through a live or faked Algolia client.
 *
 * @throws When a single document already exceeds `MAX_DOCUMENT_BYTES` on its own -- no batch boundary
 *   can fix that, so 2.5.x's `processDocument` threw here too rather than silently dropping the object.
 */
export function batchDocuments(docs: AlgoliaPageDocument[]): AlgoliaPageDocument[][] {
  const batches: AlgoliaPageDocument[][] = []
  let current: AlgoliaPageDocument[] = []
  let bytes = 0

  for (const doc of docs) {
    const docBytes = Buffer.byteLength(JSON.stringify(doc))
    if (docBytes >= MAX_DOCUMENT_BYTES) {
      throw new Error(
        `Page "${doc.path}" (${docBytes} bytes) exceeds the maximum object size Algolia allows (${MAX_DOCUMENT_BYTES} bytes).`
      )
    }
    if (current.length > 0 && docBytes + COMMA_BYTES + bytes >= MAX_INDEXING_BYTES) {
      batches.push(current)
      current = []
      bytes = 0
    }
    if (current.length > 0) {
      bytes += COMMA_BYTES
    }
    bytes += docBytes
    current.push(doc)
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
 * than relying only on `init()` having run first: `init()` exists so the fields task #549's
 * `SearchModule` interface mandates (e.g. `searchableAttributes`) are pushed to Algolia as soon as an
 * operator selects and configures this engine, but nothing in `models/search.ts`'s current call graph
 * invokes it before the first `query`/`created`/etc. call -- `getActiveEngine()` only resolves and
 * returns the module, and `selectEngine()` only persists config. Every hook below therefore resolves
 * its own client through `getClient()`, the same way it would if `init()` had never run, so this
 * module works correctly regardless of whether that wiring is added later.
 */
export class AlgoliaSearchModule implements SearchModule {
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
        //    for the `path` prefix filter and the always-on searchability gate.
        attributesForFaceting: [
          'tags',
          'locale',
          'editor',
          'publishState',
          'isSearchable',
          'pathAncestors'
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
    const indexName = config.indexName || 'wiki'
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
    const indexName = config.indexName || 'wiki'
    await this.setSettings(client, indexName)
    this.clients.set(siteId, {
      client,
      indexName,
      configKey: `${config.appId}:${config.apiKey}:${config.indexName}`
    })
  }

  async created(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page)
  }

  async updated(page: SearchIndexablePage): Promise<void> {
    await this.indexPage(page)
  }

  /**
   * Never throws: a page that saved correctly must not report failure because Algolia could not be
   * reached -- same reasoning, and same try/catch shape, as `db/search.ts`'s `indexPage`.
   */
  private async indexPage(page: SearchIndexablePage): Promise<void> {
    try {
      const { client, indexName } = await this.getClient(page.siteId)
      await client.saveObject({ indexName, body: pageToDocument(page) })
    } catch (err: any) {
      WIKI.logger.warn(`(SEARCH/ALGOLIA) Failed to index page ${page.id}: ${err.message}`)
    }
  }

  async deleted(siteId: string, pageId: string): Promise<void> {
    try {
      const { client, indexName } = await this.getClient(siteId)
      await client.deleteObject({ indexName, objectID: pageId })
    } catch (err: any) {
      WIKI.logger.warn(
        `(SEARCH/ALGOLIA) Failed to remove page ${pageId} from the index: ${err.message}`
      )
    }
  }

  /**
   * Unlike 2.5.x -- which derived an object's `objectID` from a hash of its path and locale, so a
   * rename had to `deleteObject` the old id and `addObject` a new one -- this schema's `pages.id` is a
   * stable UUID a move never touches (`models/pages.ts`'s `movePage` updates the row in place). A
   * rename is therefore an ordinary update of the same Algolia object via `saveObject`, which keeps the
   * page continuously findable instead of briefly missing between a delete and an add.
   */
  async renamed(_siteId: string, page: SearchIndexablePage, _previousPath: string): Promise<void> {
    await this.indexPage(page)
  }

  async query(params: SearchPagesParams): Promise<SearchPagesResult> {
    const { siteId, query = '', offset = 0, limit = 25, actor } = params
    const { client, indexName } = await this.getClient(siteId)

    const response = await client.searchSingleIndex<AlgoliaPageDocument>({
      indexName,
      searchParams: {
        query,
        filters: buildFilters(params),
        offset,
        length: limit
      }
    })
    const hits = response.hits ?? []

    /*
      Algolia has no server-side permission model of its own, so a result it returns has to be
      filtered the same way `db/search.ts` filters its own rows: per-row, against the actor's page
      rules, since which rule applies can depend on a regular expression or a page's tags that no
      Algolia `filters` clause could express.
    */
    const visible = actor
      ? hits.filter((hit) =>
          WIKI.models.groups.checkAccess(actor, 'read:pages', {
            path: hit.path,
            locale: hit.locale,
            siteId,
            tags: hit.tags ?? []
          })
        )
      : hits

    const results: SearchResult[] = visible.map((hit, index) => ({
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
      relevancy: hits.length - index,
      // -> 2.5.x parity: its `query()` returned no excerpt either. Adding one would mean Algolia
      //    snippets (`attributesToSnippet`), which is a real feature but out of this module's scope --
      //    and every protected page's `content` is never indexed in the first place (`pageToDocument`),
      //    so there would be nothing to snippet from for those regardless.
      highlight: null
    }))

    return {
      results,
      // -> Same reasoning as `db/search.ts`: Algolia's `nbHits` counts every match, including ones a
      //    rule just removed from this page, so it is adjusted by exactly what filtering dropped from
      //    this page rather than reported as-is.
      totalHits: Math.max(0, (response.nbHits ?? 0) - hits.length + visible.length),
      // -> No "did you mean" here: Algolia's own typo-tolerance already retries a query internally,
      //    which is a different mechanism from `db`'s pg_trgm-based post-hoc suggestion and not
      //    something this module surfaces as a distinct suggestion string.
      suggestion: null
    }
  }

  /**
   * Recompute the whole Algolia index of a site from the pages currently in the database.
   *
   * Streamed in pages of `PAGE_SIZE` rows via keyset pagination on `id` (`WIKI.db` queries, replacing
   * 2.5.x's `WIKI.models.knex(...).stream()`), each page immediately regrouped into
   * Algolia-size-limited batches by `batchDocuments()` and sent with `client.batch()` -- so the whole
   * table is never held in memory at once, the same property the old knex stream had.
   */
  async rebuild(siteId: string): Promise<RebuildResult> {
    const PAGE_SIZE = 500
    const { client, indexName } = await this.getClient(siteId)

    WIKI.logger.info('(SEARCH/ALGOLIA) Rebuilding index...')
    await client.clearObjects({ indexName })

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

      const docs = rows.map((row) => pageToDocument(row as unknown as SearchIndexablePage))
      for (const batch of batchDocuments(docs)) {
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
      for (const row of rows) {
        pageCounts[row.locale] = (pageCounts[row.locale] ?? 0) + 1
      }

      cursor = rows[rows.length - 1]!.id
      if (rows.length < PAGE_SIZE) {
        break
      }
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
      }))
    }
  }
}

export default new AlgoliaSearchModule()
