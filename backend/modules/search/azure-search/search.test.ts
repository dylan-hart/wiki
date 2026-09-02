import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mock } from 'node:test'
import { ensureTemporal } from '../../../test/temporal.ts'
import { createSilentLogger, installTestWiki } from '../../../test/mocks.ts'
import { makeIndexablePage, makeRebuildPageSource } from '../../../test/builders.ts'
import { search } from '../../../models/search.ts'
import {
  AzureSearchModule,
  buildFilter,
  buildIndexSchema,
  buildOrderBy,
  toIndexDocument,
  type AzureSearchIndexClient,
  type AzureSearchQueryClient,
  type AzureSearchRow
} from './search.ts'
import { REBUILD_BATCH_SIZE } from '../shared.ts'
import defaultAzureSearchModule from './search.ts'
import type { SearchIndex } from '@azure/search-documents'

/**
 * `toIndexDocument` calls `Date.prototype.toTemporalInstant()` to build the document's `updatedAt`
 * field.
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
 * v25.9.0, which doesn't expose it yet (same environment gap `core/scheduler.test.ts` stubs around).
 */
const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

before(() => ensureTemporal())

/**
 * `init()` is task #553's scope — the SDK dependency, `definition.yml`, and idempotent index
 * provisioning. The page-lifecycle hooks, `query()` translation helpers and the split-query merge are
 * task #557's. Neither talks to the network: there is no local Azure AI Search emulator (see Feature
 * #381's description), so every suite here builds a fake client that records what it was called with
 * and resolves/returns canned data, the same way a real one would.
 *
 * A stub `WIKI.logger` is required because several hooks log — the same reason `test/mocks.ts` exists
 * for model-layer tests, just inlined here rather than imported, since this suite needs nothing else
 * off the `WIKI` global besides `sites` (per-site engine config), `SERVERPATH` (so
 * `search.refreshFromDisk()` below can read this engine's own `definition.yml`) and
 * `models.groups.checkAccess` (page-permission filtering in `query()`).
 */
installTestWiki({
  SERVERPATH: backendDir,
  // -> Not the silent default: several tests assert on what the module logged.
  logger: { ...createSilentLogger(), info: mock.fn(), warn: mock.fn() },
  sites: {
    'site-1': {
      config: {
        search: {
          engines: {
            'azure-search': { serviceName: 'demo', adminApiKey: 'key', indexName: 'wiki' }
          }
        }
      }
    }
  },
  models: {
    groups: {
      checkAccess: () => true
    }
  }
})

/**
 * `configFor()` resolves this engine's config through `search.getEngineConfig`, which completes it
 * with the props declared in `definition.yml` — so the definitions have to be loaded off disk first,
 * exactly as `index.ts` does (`refreshFromDisk()` before `initActiveEngines()`). The `algolia` and
 * `elasticsearch` suites load them the same way.
 *
 * Registered here rather than beside the `ensureTemporal()` hook above, and this is load-bearing: a
 * root-level `before()` in `node:test` runs before the top-level statements that FOLLOW it, so a hook
 * declared above the `WIKI` assignment would run with no `WIKI.SERVERPATH` to read from.
 */
before(() => search.refreshFromDisk())

function fakeClient(): AzureSearchIndexClient & { calls: SearchIndex[] } {
  const calls: SearchIndex[] = []
  return {
    calls,
    async createOrUpdateIndex(index: SearchIndex) {
      calls.push(index)
      return index
    }
  }
}

interface FakeSearchCall {
  searchText: string | undefined
  options: Record<string, any>
}

/**
 * A fake `AzureSearchQueryClient`. `search()` is scripted per call via `results` (a queue, drained in
 * FIFO order) so a test exercising the protected-content split can hand back a different row set to
 * each of the two queries `runProtectedSplitQuery` issues.
 */
function fakeQueryClient(
  results: { count?: number; rows: AzureSearchRow[] }[] = [{ count: 0, rows: [] }]
): AzureSearchQueryClient & {
  merged: Record<string, any>[]
  deleted: { keyName: string; keyValues: string[] }[]
  searches: FakeSearchCall[]
} {
  const queue = [...results]
  const merged: Record<string, any>[] = []
  const deleted: { keyName: string; keyValues: string[] }[] = []
  const searches: FakeSearchCall[] = []
  return {
    merged,
    deleted,
    searches,
    async mergeOrUploadDocuments(documents) {
      merged.push(...documents)
    },
    async deleteDocuments(keyName, keyValues) {
      deleted.push({ keyName, keyValues })
    },
    async search(searchText, options) {
      searches.push({ searchText, options })
      const next = queue.shift() ?? { count: 0, rows: [] }
      return {
        count: next.count,
        results: (async function* () {
          for (const row of next.rows) {
            yield row
          }
        })()
      }
    }
  }
}

/** The 28-field superset lives in `test/builders.ts` — this engine reads the widest set of them. */
const page = makeIndexablePage

describe('azure-search module: buildIndexSchema', () => {
  const schema = buildIndexSchema('wiki')

  test('declares one field per name, with no duplicates', () => {
    const names = schema.fields.map((f) => f.name)
    assert.equal(new Set(names).size, names.length)
    assert.deepEqual(names.sort(), [
      'classification',
      'content',
      'description',
      'editor',
      'hasPassword',
      'icon',
      'id',
      'locale',
      'path',
      'publishState',
      'siteId',
      'tags',
      'title',
      'updatedAt'
    ])
  })

  test('path is both filterable (startswith) and searchable (search.ismatch)', () => {
    const field = schema.fields.find((f) => f.name === 'path')!
    assert.equal((field as any).filterable, true)
    assert.equal((field as any).searchable, true)
  })

  test('hasPassword is a filterable boolean, for routing the protected-content split query', () => {
    const field = schema.fields.find((f) => f.name === 'hasPassword')!
    assert.equal(field.type, 'Edm.Boolean')
    assert.equal((field as any).filterable, true)
  })

  test('id is the searchable, filterable-off key field', () => {
    const id = schema.fields.find((f) => f.name === 'id')!
    assert.equal((id as any).key, true)
    assert.equal((id as any).searchable, false)
  })

  test('siteId, locale and path are filterable', () => {
    for (const name of ['siteId', 'locale', 'path']) {
      const field = schema.fields.find((f) => f.name === name)!
      assert.equal((field as any).filterable, true, `${name} should be filterable`)
    }
  })

  test('title, description and content are searchable', () => {
    for (const name of ['title', 'description', 'content']) {
      const field = schema.fields.find((f) => f.name === name)!
      assert.equal((field as any).searchable, true, `${name} should be searchable`)
    }
  })

  test('tags is a filterable, facetable string collection', () => {
    const tags = schema.fields.find((f) => f.name === 'tags')!
    assert.equal(tags.type, 'Collection(Edm.String)')
    assert.equal((tags as any).filterable, true)
    assert.equal((tags as any).facetable, true)
  })

  test('editor and publishState are filterable', () => {
    for (const name of ['editor', 'publishState']) {
      const field = schema.fields.find((f) => f.name === name)!
      assert.equal((field as any).filterable, true, `${name} should be filterable`)
    }
  })

  test('updatedAt is a filterable, sortable date', () => {
    const updatedAt = schema.fields.find((f) => f.name === 'updatedAt')!
    assert.equal(updatedAt.type, 'Edm.DateTimeOffset')
    assert.equal((updatedAt as any).filterable, true)
    assert.equal((updatedAt as any).sortable, true)
  })

  test("weights title above description above content, matching 2.5.x's 4/3/1 scoring", () => {
    assert.equal(schema.scoringProfiles?.length, 1)
    const profile = schema.scoringProfiles![0]!
    assert.equal(profile.textWeights?.weights.title, 4)
    assert.equal(profile.textWeights?.weights.description, 3)
    assert.equal(profile.textWeights?.weights.content, 1)
    assert.equal(schema.defaultScoringProfile, profile.name)
  })

  test('is a pure function of the index name: same name in, identical schema out', () => {
    assert.deepEqual(buildIndexSchema('wiki'), buildIndexSchema('wiki'))
  })
})

describe('azure-search module: init()', () => {
  test('provisions the index through createOrUpdateIndex', async () => {
    const client = fakeClient()
    const azureSearch = new AzureSearchModule(() => client)

    await azureSearch.init('site-1', { serviceName: 'demo', adminApiKey: 'key', indexName: 'wiki' })

    assert.equal(client.calls.length, 1)
    assert.equal(client.calls[0]!.name, 'wiki')
  })

  test('an index name the operator CLEARED still provisions "wiki", not an unnamed index', async () => {
    // -> `getEngineConfig`'s merge only substitutes a declared default for `undefined`, and an
    //    emptied text field is stored as `''` — so the module completes empty strings itself
    //    (`shared.ts#fillEmptyStringDefaults`). This is what the per-engine `|| DEFAULT_INDEX_NAME`
    //    used to cover, and dropping it without this would have sent Azure an empty index name.
    const client = fakeClient()
    const azureSearch = new AzureSearchModule(() => client)

    await azureSearch.init('site-1', { serviceName: 'demo', adminApiKey: 'key', indexName: '' })

    assert.equal(client.calls[0]!.name, 'wiki')
  })

  test('the index name defaults to "wiki" for a site that never set one', async () => {
    // -> The default lives in `definition.yml` and reaches this module through
    //    `search.getEngineConfig` — which is what `selectEngine()`/`initActiveEngines()` hand `init()`
    //    and what `configFor()` reads for every other hook. It is no longer re-applied as a local
    //    `|| DEFAULT_INDEX_NAME` at each use site (CORE-F5 phase 4).
    const config = search.getEngineConfig('site-with-no-stored-config', 'azure-search')
    assert.equal(config.indexName, 'wiki')

    const client = fakeClient()
    const azureSearch = new AzureSearchModule(() => client)
    await azureSearch.init('site-1', config)

    assert.equal(client.calls[0]!.name, 'wiki')
  })

  test('is idempotent: calling init() twice sends the identical schema both times, and neither call throws', async () => {
    const client = fakeClient()
    const azureSearch = new AzureSearchModule(() => client)
    const config = { serviceName: 'demo', adminApiKey: 'key', indexName: 'wiki' }

    await assert.doesNotReject(azureSearch.init('site-1', config))
    await assert.doesNotReject(azureSearch.init('site-1', config))

    assert.equal(client.calls.length, 2)
    // -> No duplicate-field or conflicting-schema drift between the two create-or-update calls
    assert.deepEqual(client.calls[0], client.calls[1])
    const names = client.calls[1]!.fields.map((f) => f.name)
    assert.equal(new Set(names).size, names.length)
  })

  test('reuses one client per site across repeated init() calls rather than reconnecting each time', async () => {
    const client = fakeClient()
    let factoryCalls = 0
    const azureSearch = new AzureSearchModule(() => {
      factoryCalls++
      return client
    })
    const config = { serviceName: 'demo', adminApiKey: 'key', indexName: 'wiki' }

    await azureSearch.init('site-1', config)
    await azureSearch.init('site-1', config)

    assert.equal(factoryCalls, 1)
  })

  test('builds a distinct client per site', async () => {
    const clientsBySite = new Map<string, ReturnType<typeof fakeClient>>()
    const azureSearch = new AzureSearchModule((config) => {
      const client = fakeClient()
      clientsBySite.set(config.serviceName, client)
      return client
    })

    await azureSearch.init('site-1', {
      serviceName: 'svc-a',
      adminApiKey: 'key',
      indexName: 'wiki'
    })
    await azureSearch.init('site-2', {
      serviceName: 'svc-b',
      adminApiKey: 'key',
      indexName: 'wiki'
    })

    assert.equal(clientsBySite.get('svc-a')!.calls.length, 1)
    assert.equal(clientsBySite.get('svc-b')!.calls.length, 1)
  })
})

describe('azure-search module: toIndexDocument', () => {
  test('maps a page row onto the index document shape', () => {
    const doc = toIndexDocument(page())
    assert.equal(doc.id, 'p1')
    assert.equal(doc.siteId, 'site-1')
    assert.equal(doc.path, 'docs/kangaroo')
    assert.equal(doc.title, 'The Wandering Kangaroo')
    assert.equal(doc.content, 'Hello kangaroo content')
    assert.deepEqual(doc.tags, ['animals'])
    assert.equal(doc.hasPassword, false)
    assert.equal(doc.classification, 'classification-1')
    assert.equal(doc.updatedAt, '2024-01-02T03:04:05.678Z')
  })

  test('hasPassword is true for a password-protected page', () => {
    const doc = toIndexDocument(page({ password: 'secret' }))
    assert.equal(doc.hasPassword, true)
  })

  test('falls back to empty strings for null description/icon and empty content/tags', () => {
    const doc = toIndexDocument(
      page({ description: null, icon: null, searchContent: null, tags: [] })
    )
    assert.equal(doc.description, '')
    assert.equal(doc.icon, '')
    assert.equal(doc.content, '')
    assert.deepEqual(doc.tags, [])
  })
})

describe('azure-search module: buildFilter', () => {
  test('always scopes to the site', () => {
    assert.equal(
      buildFilter({ siteId: 'site-1' }),
      `siteId eq 'site-1' and publishState ne 'draft'`
    )
  })

  test('a plain path becomes a startswith filter', () => {
    const filter = buildFilter({ siteId: 'site-1', path: 'docs/' })
    assert.match(filter, /startswith\(path, 'docs\/'\)/)
  })

  test('a wildcard path becomes a search.ismatch filter', () => {
    const filter = buildFilter({ siteId: 'site-1', path: 'docs/*' })
    assert.match(filter, /search\.ismatch\('docs\/\*', 'path', 'full', 'any'\)/)
  })

  test('locales become a search.in filter', () => {
    const filter = buildFilter({ siteId: 'site-1', locales: ['en', 'fr'] })
    assert.match(filter, /search\.in\(locale, 'en\|fr', '\|'\)/)
  })

  test('tags become tags/any(t: search.in(t, ...))', () => {
    const filter = buildFilter({ siteId: 'site-1', tags: ['a', 'b'] })
    assert.match(filter, /tags\/any\(t: search\.in\(t, 'a\|b', '\|'\)\)/)
  })

  test('editor becomes an eq filter', () => {
    const filter = buildFilter({ siteId: 'site-1', editor: 'markdown' })
    assert.match(filter, /editor eq 'markdown'/)
  })

  test('publicOnly restricts to published, overriding the default draft exclusion', () => {
    const filter = buildFilter({ siteId: 'site-1', publicOnly: true })
    assert.match(filter, /publishState eq 'published'/)
    assert.doesNotMatch(filter, /ne 'draft'/)
  })

  test('includeDrafts drops the default draft exclusion', () => {
    const filter = buildFilter({ siteId: 'site-1', includeDrafts: true })
    assert.doesNotMatch(filter, /publishState/)
  })

  test('an explicit publishState is ANDed alongside the draft exclusion', () => {
    const filter = buildFilter({ siteId: 'site-1', publishState: 'published' })
    assert.match(filter, /publishState ne 'draft' and publishState eq 'published'/)
  })

  test('hasPassword becomes a boolean eq filter when set', () => {
    assert.match(buildFilter({ siteId: 'site-1', hasPassword: true }), /hasPassword eq true/)
    assert.match(buildFilter({ siteId: 'site-1', hasPassword: false }), /hasPassword eq false/)
  })

  test('a single quote in a value is escaped by doubling it', () => {
    const filter = buildFilter({ siteId: 'site-1', editor: "o'brien" })
    assert.match(filter, /editor eq 'o''brien'/)
  })
})

describe('azure-search module: buildOrderBy', () => {
  test('relevancy maps to search.score()', () => {
    assert.deepEqual(buildOrderBy('relevancy', 'desc'), ['search.score() desc'])
    assert.deepEqual(buildOrderBy('relevancy', 'asc'), ['search.score() asc'])
  })

  test('title and updatedAt map to themselves', () => {
    assert.deepEqual(buildOrderBy('title', 'asc'), ['title asc'])
    assert.deepEqual(buildOrderBy('updatedAt', 'desc'), ['updatedAt desc'])
  })
})

describe('azure-search module: created/updated/deleted/renamed', () => {
  test('created() merges the page document into the index', async () => {
    const client = fakeQueryClient()
    const azureSearch = new AzureSearchModule(undefined, () => client)

    await azureSearch.created(page())

    assert.equal(client.merged.length, 1)
    assert.equal(client.merged[0]!.id, 'p1')
  })

  test('updated() merges the page document into the index', async () => {
    const client = fakeQueryClient()
    const azureSearch = new AzureSearchModule(undefined, () => client)

    await azureSearch.updated(page({ title: 'New Title' }))

    assert.equal(client.merged[0]!.title, 'New Title')
  })

  test('renamed() reindexes under the new path, ignoring previousPath (the document key is id)', async () => {
    const client = fakeQueryClient()
    const azureSearch = new AzureSearchModule(undefined, () => client)

    await azureSearch.renamed('site-1', page({ path: 'docs/new-path' }), 'docs/old-path')

    assert.equal(client.merged[0]!.path, 'docs/new-path')
  })

  test('deleted() removes the document by id', async () => {
    const client = fakeQueryClient()
    const azureSearch = new AzureSearchModule(undefined, () => client)

    await azureSearch.deleted('site-1', 'p1')

    assert.deepEqual(client.deleted, [{ keyName: 'id', keyValues: ['p1'] }])
  })

  test('created() never throws when the client rejects -- logs and continues', async () => {
    const client = fakeQueryClient()
    client.mergeOrUploadDocuments = async () => {
      throw new Error('boom')
    }
    const azureSearch = new AzureSearchModule(undefined, () => client)

    await assert.doesNotReject(azureSearch.created(page()))
  })

  test('deleted() never throws when the client rejects -- logs and continues', async () => {
    const client = fakeQueryClient()
    client.deleteDocuments = async () => {
      throw new Error('boom')
    }
    const azureSearch = new AzureSearchModule(undefined, () => client)

    await assert.doesNotReject(azureSearch.deleted('site-1', 'p1'))
  })
})

/**
 * OpenProject #922: the query client used to be cached by siteId alone, so changing
 * `serviceName`/`adminApiKey`/`indexName` in the admin area had no effect until a process restart.
 * Cached alongside a `configKey` (as JSON) now, mirroring the pattern `elasticsearch`/`algolia`'s
 * `getClient()` already use.
 */
describe('azure-search module: query client caching', () => {
  test('reuses the same client across calls when the site config is unchanged', async () => {
    let factoryCalls = 0
    const client = fakeQueryClient()
    const azureSearch = new AzureSearchModule(undefined, () => {
      factoryCalls++
      return client
    })

    await azureSearch.created(page())
    await azureSearch.created(page())

    assert.equal(factoryCalls, 1)
  })

  test('builds a fresh client once the site config changes, rather than keeping a stale one', async () => {
    let factoryCalls = 0
    const client = fakeQueryClient()
    const azureSearch = new AzureSearchModule(undefined, () => {
      factoryCalls++
      return client
    })
    const engines = (globalThis as any).WIKI.sites['site-1'].config.search.engines
    const originalConfig = engines['azure-search']

    try {
      await azureSearch.created(page())
      assert.equal(factoryCalls, 1)

      engines['azure-search'] = { ...originalConfig, indexName: 'wiki-v2' }
      await azureSearch.created(page())
      assert.equal(factoryCalls, 2)
    } finally {
      engines['azure-search'] = originalConfig
    }
  })
})

describe('azure-search module: query()', () => {
  function row(overrides: Partial<AzureSearchRow['document']> = {}, score = 1): AzureSearchRow {
    return {
      document: {
        id: 'p1',
        siteId: 'site-1',
        locale: 'en',
        path: 'docs/kangaroo',
        title: 'The Wandering Kangaroo',
        description: 'A page about kangaroos',
        icon: 'mdi:file',
        tags: ['animals'],
        updatedAt: '2024-01-02T03:04:05.678Z',
        hasPassword: false,
        ...overrides
      },
      score,
      // -> The pre/post tags requested from Azure are control characters, not its default `<em>`/
      //    `</em>` -- see the doc comment on `HL_START`/`HL_STOP` in `search.ts` for why.
      highlights: { content: ['a kangaroo hops'] }
    }
  }

  /**
   * OpenProject #2156: `offset`/`limit` are no longer sent straight through as Azure's own `skip`/
   * `top` -- page-rule filtering happens after the query, so the module now always scans a bounded
   * window from the start (`skip: 0`) and applies the caller's own pagination in JS, over the
   * filtered set. See `query()`'s own comment for the full reasoning.
   */
  test('always scans from the start with a bounded top, regardless of the caller’s own offset/limit', async () => {
    const client = fakeQueryClient([{ count: 1, rows: [row()] }])
    const azureSearch = new AzureSearchModule(undefined, () => client)

    await azureSearch.query({
      siteId: 'site-1',
      query: 'kangaroo',
      offset: 10,
      limit: 5,
      hideProtectedContent: false
    })

    assert.equal(client.searches.length, 1)
    assert.equal(client.searches[0]!.options.skip, 0)
    assert.ok(
      client.searches[0]!.options.top > 5,
      'expected a bounded scan window larger than the requested page size'
    )
  })

  test('applies the caller’s offset/limit in JS, over the filtered (visible) set', async () => {
    const client = fakeQueryClient([
      {
        count: 3,
        rows: [
          row({ id: 'a', path: 'a' }, 3),
          row({ id: 'b', path: 'b' }, 2),
          row({ id: 'c', path: 'c' }, 1)
        ]
      }
    ])
    const azureSearch = new AzureSearchModule(undefined, () => client)

    const result = await azureSearch.query({
      siteId: 'site-1',
      query: 'kangaroo',
      offset: 1,
      limit: 1,
      hideProtectedContent: false
    })

    assert.equal(result.results.length, 1)
    assert.equal(result.results[0]!.id, 'b')
    assert.equal(result.totalHits, 3)
  })

  test('returns the exact SearchPagesResult shape', async () => {
    const client = fakeQueryClient([{ count: 1, rows: [row()] }])
    const azureSearch = new AzureSearchModule(undefined, () => client)

    const result = await azureSearch.query({
      siteId: 'site-1',
      query: 'kangaroo',
      hideProtectedContent: false
    })

    assert.deepEqual(Object.keys(result).sort(), [
      'results',
      'suggestion',
      'totalHits',
      'totalHitsApproximate'
    ])
    assert.equal(result.totalHits, 1)
    assert.equal(result.results.length, 1)
    assert.deepEqual(Object.keys(result.results[0]!).sort(), [
      'description',
      'highlight',
      'icon',
      'id',
      'locale',
      'path',
      'relevancy',
      'tags',
      'title',
      'updatedAt'
    ])
  })

  test('normalizes a highlighted fragment into <b>, HTML-escaping the rest of the text first', async () => {
    // -> Azure wraps a match in whatever `highlightPreTag`/`highlightPostTag` were requested -- here,
    //    the control characters `search.ts` configures instead of Azure's own `<em>`/`</em>` default,
    //    specifically so a literal "<em>" in the page's own text can never be mistaken for one.
    const withHighlight = row()
    withHighlight.highlights = { content: ['a <script> tag & a kangaroo hop'] }
    const client = fakeQueryClient([{ count: 1, rows: [withHighlight] }])
    const azureSearch = new AzureSearchModule(undefined, () => client)

    const result = await azureSearch.query({
      siteId: 'site-1',
      query: 'kangaroo',
      hideProtectedContent: false
    })

    assert.equal(result.results[0]!.highlight, 'a &lt;script&gt; tag &amp; a <b>kangaroo</b> hop')
  })

  test('a query with no text matches everything (search=undefined) and skips highlighting', async () => {
    const client = fakeQueryClient([{ count: 1, rows: [row({}, 0)] }])
    const azureSearch = new AzureSearchModule(undefined, () => client)

    await azureSearch.query({ siteId: 'site-1' })

    assert.equal(client.searches[0]!.searchText, undefined)
    assert.equal(client.searches[0]!.options.highlightFields, undefined)
  })

  test('drops a row checkAccess denies, and adjusts totalHits accordingly', async () => {
    const client = fakeQueryClient([
      { count: 2, rows: [row(), row({ id: 'p2', path: 'docs/other' }, 0.5)] }
    ])
    const azureSearch = new AzureSearchModule(undefined, () => client)
    const actor = { groupIds: [], permissions: [] }
    ;(WIKI.models.groups.checkAccess as any) = (_actor: any, _perm: any, p: any) =>
      p.path !== 'docs/kangaroo'

    const result = await azureSearch.query({
      siteId: 'site-1',
      query: 'kangaroo',
      actor,
      hideProtectedContent: false
    })

    assert.equal(result.results.length, 1)
    assert.equal(result.results[0]!.id, 'p2')
    // -> offset (0) plus how many of this page's rows survived checkAccess, never Azure's own count
    assert.equal(result.totalHits, 1)
    WIKI.models.groups.checkAccess = () => true
  })

  test('totalHits never reflects Azure’s own count when it exceeds what this page can vouch for', async () => {
    const client = fakeQueryClient([
      {
        // -> Azure reports 100 total matches across many pages this call never fetched -- the old
        //    arithmetic (count - rows.length + visible.length) would have leaked most of that into
        //    totalHits even though only this one page was ever checked against checkAccess.
        count: 100,
        rows: [
          row({ id: 'p1', path: 'docs/kangaroo' }, 3),
          row({ id: 'p2', path: 'docs/secret' }, 2),
          row({ id: 'p3', path: 'docs/other' }, 1)
        ]
      }
    ])
    const azureSearch = new AzureSearchModule(undefined, () => client)
    const actor = { groupIds: [], permissions: [] }
    ;(WIKI.models.groups.checkAccess as any) = (_actor: any, _perm: any, p: any) =>
      p.path !== 'docs/secret'

    const result = await azureSearch.query({
      siteId: 'site-1',
      query: 'kangaroo',
      offset: 0,
      actor,
      hideProtectedContent: false
    })

    assert.equal(result.results.length, 2)
    // -> Exactly the readable count of this page (offset 0 + 2 visible), never Azure's 100
    assert.equal(result.totalHits, 2)
    WIKI.models.groups.checkAccess = () => true
  })

  test('passes each row’s own indexed classification to checkAccess, not a hardcoded null (OpenProject #1125)', async () => {
    const client = fakeQueryClient([
      { count: 1, rows: [row({ classification: 'classification-restricted' })] }
    ])
    const azureSearch = new AzureSearchModule(undefined, () => client)
    const actor = { groupIds: [], permissions: [] }
    const seen: any[] = []
    ;(WIKI.models.groups.checkAccess as any) = (_actor: any, _perm: any, p: any) => {
      seen.push(p.classification)
      return true
    }

    await azureSearch.query({
      siteId: 'site-1',
      query: 'kangaroo',
      actor,
      hideProtectedContent: false
    })

    assert.deepEqual(seen, ['classification-restricted'])
    WIKI.models.groups.checkAccess = () => true
  })

  test('hideProtectedContent issues a title/description-only search for protected rows and merges it in', async () => {
    const publicRow = row({ id: 'pub', hasPassword: false }, 2)
    const protectedRow = row({ id: 'prot', title: 'Vault Secrets', hasPassword: true }, 1)
    protectedRow.highlights = undefined
    const client = fakeQueryClient([
      { count: 1, rows: [publicRow] },
      { count: 1, rows: [protectedRow] }
    ])
    const azureSearch = new AzureSearchModule(undefined, () => client)

    const result = await azureSearch.query({
      siteId: 'site-1',
      query: 'secrets',
      hideProtectedContent: true
    })

    assert.equal(client.searches.length, 2)
    // -> Public half: full-content search fields, restricted to pages with no password
    assert.deepEqual(client.searches[0]!.options.searchFields, ['title', 'description', 'content'])
    assert.match(client.searches[0]!.options.filter, /hasPassword eq false/)
    // -> Protected half: title/description only, restricted to pages with a password, no highlights
    assert.deepEqual(client.searches[1]!.options.searchFields, ['title', 'description'])
    assert.match(client.searches[1]!.options.filter, /hasPassword eq true/)
    assert.equal(client.searches[1]!.options.highlightFields, undefined)

    assert.equal(result.results.length, 2)
    assert.equal(result.totalHits, 2)
    const protectedResult = result.results.find((r) => r.id === 'prot')!
    assert.equal(protectedResult.title, 'Vault Secrets')
    // -> Found by title, but never carries an excerpt of the body behind the password
    assert.equal(protectedResult.highlight, null)
  })

  /**
   * OpenProject #2151/#2156: `runProtectedSplitQuery`'s merged rows used to be sliced to the
   * caller's page BEFORE `checkAccess()` ran, so a denied match elsewhere in the merge could still
   * count toward -- and even occupy a slot in -- the page returned at `limit=1`, the audit's own
   * repro shape. `totalHits` must never exceed the number of matches the actor can actually read.
   */
  test('the split-query path never counts or returns a denied match, even at limit=1', async () => {
    const openRow = row({ id: 'open', path: 'docs/open', hasPassword: false }, 2)
    const secretRow = row({ id: 'secret', path: 'docs/secret', hasPassword: false }, 1)
    const client = fakeQueryClient([
      { count: 2, rows: [openRow, secretRow] },
      { count: 0, rows: [] }
    ])
    const azureSearch = new AzureSearchModule(undefined, () => client)
    const actor = { groupIds: [], permissions: [] }
    ;(WIKI.models.groups.checkAccess as any) = (_actor: any, _perm: any, p: any) =>
      p.path !== 'docs/secret'

    try {
      const result = await azureSearch.query({
        siteId: 'site-1',
        query: 'kangaroo',
        actor,
        limit: 1,
        hideProtectedContent: true
      })
      assert.equal(result.totalHits, 1)
      assert.equal(result.results.length, 1)
      assert.equal(result.results[0]!.id, 'open')
    } finally {
      WIKI.models.groups.checkAccess = () => true
    }
  })

  test('hideProtectedContent is skipped without a query, since there is no body text to leak', async () => {
    const client = fakeQueryClient([{ count: 0, rows: [] }])
    const azureSearch = new AzureSearchModule(undefined, () => client)

    await azureSearch.query({ siteId: 'site-1', hideProtectedContent: true })

    assert.equal(client.searches.length, 1)
  })

  test('hideProtectedContent: false runs a single unrestricted query even with protected pages', async () => {
    const client = fakeQueryClient([{ count: 1, rows: [row({ hasPassword: true })] }])
    const azureSearch = new AzureSearchModule(undefined, () => client)

    await azureSearch.query({ siteId: 'site-1', query: 'kangaroo', hideProtectedContent: false })

    assert.equal(client.searches.length, 1)
    assert.doesNotMatch(client.searches[0]!.options.filter, /hasPassword/)
  })
})

describe('azure-search module: rebuild()', () => {
  test('streams every locale through mergeOrUploadDocuments and reports a per-locale RebuildResult', async () => {
    const client = fakeQueryClient()
    const source = makeRebuildPageSource({
      en: [page({ id: 'en-1' }), page({ id: 'en-2' })],
      fr: [page({ id: 'fr-1', locale: 'fr' })]
    })
    const azureSearch = new AzureSearchModule(undefined, () => client, source)

    const result = await azureSearch.rebuild('site-1')

    assert.equal(result.pages, 3)
    assert.deepEqual(result.locales, [
      { locale: 'en', pages: 2 },
      { locale: 'fr', pages: 1 }
    ])
    // -> No `dictionary` on either entry: this engine has no such concept (see `RebuildResult`'s own
    //    doc comment in `models/search.ts`).
    assert.ok(result.locales.every((l) => !('dictionary' in l)))
  })

  test('uploads the exact documents toIndexDocument would build for each page', async () => {
    const client = fakeQueryClient()
    const source = makeRebuildPageSource({ en: [page({ id: 'en-1' })] })
    const azureSearch = new AzureSearchModule(undefined, () => client, source)

    await azureSearch.rebuild('site-1')

    assert.equal(client.merged.length, 1)
    assert.deepEqual(client.merged[0], toIndexDocument(page({ id: 'en-1' })))
  })

  test('paginates a locale larger than one batch, walking every row exactly once', async () => {
    const client = fakeQueryClient()
    const enPages = Array.from({ length: REBUILD_BATCH_SIZE + 3 }, (_, i) =>
      page({ id: `en-${i}` })
    )
    const source = makeRebuildPageSource({ en: enPages })
    const azureSearch = new AzureSearchModule(undefined, () => client, source)

    const result = await azureSearch.rebuild('site-1')

    assert.equal(result.pages, REBUILD_BATCH_SIZE + 3)
    assert.equal(result.locales[0]!.pages, REBUILD_BATCH_SIZE + 3)
    // -> Two `pageBatch` calls (a full batch, then the 3-row remainder) and two matching
    //    `mergeOrUploadDocuments` calls -- the working set never grows past one batch.
    assert.deepEqual(
      source.calls.map((c) => c.offset),
      [0, REBUILD_BATCH_SIZE]
    )
    assert.equal(client.merged.length, REBUILD_BATCH_SIZE + 3)
    const ids = new Set(client.merged.map((d) => d.id))
    assert.equal(ids.size, REBUILD_BATCH_SIZE + 3)
  })

  test('a locale with no pages contributes zero and no upload call', async () => {
    const client = fakeQueryClient()
    const source = makeRebuildPageSource({ en: [] })
    const azureSearch = new AzureSearchModule(undefined, () => client, source)

    const result = await azureSearch.rebuild('site-1')

    assert.deepEqual(result, { pages: 0, locales: [{ locale: 'en', pages: 0 }] })
    assert.equal(client.merged.length, 0)
  })

  /**
   * OpenProject #922: `rebuild()` only ever upserted, so a page deleted while this engine was
   * unreachable stayed in the index forever -- a ghost result. It now queries every id already in the
   * index for the site and deletes whichever ones were not just re-uploaded.
   */
  describe('purges ghost documents', () => {
    test('deletes an indexed id that was not re-uploaded, keeps the ones that were', async () => {
      const client = fakeQueryClient([
        {
          count: 2,
          rows: [
            { document: { id: 'stays' }, score: 1 },
            { document: { id: 'ghost' }, score: 1 }
          ]
        }
      ])
      const source = makeRebuildPageSource({ en: [page({ id: 'stays' })] })
      const azureSearch = new AzureSearchModule(undefined, () => client, source)

      await azureSearch.rebuild('site-1')

      assert.deepEqual(client.deleted, [{ keyName: 'id', keyValues: ['ghost'] }])
    })

    test('deletes nothing when every previously-indexed id was re-uploaded', async () => {
      const client = fakeQueryClient([{ count: 1, rows: [{ document: { id: 'p1' }, score: 1 }] }])
      const source = makeRebuildPageSource({ en: [page({ id: 'p1' })] })
      const azureSearch = new AzureSearchModule(undefined, () => client, source)

      await azureSearch.rebuild('site-1')

      assert.deepEqual(client.deleted, [])
    })

    test('the stale-id lookup is scoped to the site, not just any indexed id', async () => {
      const client = fakeQueryClient([
        { count: 1, rows: [{ document: { id: 'ghost' }, score: 1 }] }
      ])
      const source = makeRebuildPageSource({ en: [] })
      const azureSearch = new AzureSearchModule(undefined, () => client, source)

      await azureSearch.rebuild('site-1')

      assert.match(client.searches[0]!.options.filter, /siteId eq 'site-1'/)
    })

    test('chunks deleteDocuments at REBUILD_BATCH_SIZE, mirroring the upload loop above', async () => {
      const ghostCount = REBUILD_BATCH_SIZE + 1
      const rows = Array.from({ length: ghostCount }, (_, i) => ({
        document: { id: `ghost-${i}` },
        score: 1
      }))
      const client = fakeQueryClient([{ count: ghostCount, rows }])
      const source = makeRebuildPageSource({ en: [] })
      const azureSearch = new AzureSearchModule(undefined, () => client, source)

      await azureSearch.rebuild('site-1')

      assert.equal(client.deleted.length, 2)
      assert.equal(client.deleted[0]!.keyValues.length, REBUILD_BATCH_SIZE)
      assert.equal(client.deleted[1]!.keyValues.length, 1)
      assert.equal(client.deleted.flatMap((d) => d.keyValues).length, ghostCount)
    })
  })
})

describe('azure-search module: default export', () => {
  test('is an AzureSearchModule instance', () => {
    assert.ok(defaultAzureSearchModule instanceof AzureSearchModule)
  })
})
