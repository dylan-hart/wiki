import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import {
  AwsCloudSearchModule,
  batchDocuments,
  buildFilterQuery,
  buildIndexFields,
  buildSort,
  buildStructuredQuery,
  fieldMatches,
  MAX_BATCH_BYTES,
  MAX_BATCH_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  REBUILD_BATCH_SIZE,
  toIndexDocument,
  type CloudSearchAdminClient,
  type CloudSearchHit,
  type CloudSearchQueryClient,
  type CloudSearchSearchRequest,
  type DescribedAnalysisScheme,
  type DescribedCloudSearchField,
  type DescribedSuggester,
  type RebuildPageSource,
  type SdfDocument
} from './search.ts'
import defaultAwsCloudSearchModule from './search.ts'
import type { SearchIndexablePage } from '../../../models/search.ts'

/**
 * Minimal stand-in for `Date.prototype.toTemporalInstant()`, which `toIndexDocument` calls to build
 * the document's `updatedAt` field.
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
 * v25.9.0, which doesn't expose it yet (same environment gap `core/scheduler.test.ts` stubs around, and
 * the identical workaround `azure-search/search.test.ts` already uses). `toISOString()` already gives
 * millisecond precision with a `Z` suffix, so it's an exact stand-in for what
 * `toTemporalInstant().toString({ smallestUnit: 'millisecond' })` produces. Guarded so it's a no-op on
 * a runtime where the native method already exists.
 */
if (typeof (Date.prototype as any).toTemporalInstant !== 'function') {
  ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
    const iso = this.toISOString()
    return { toString: () => iso }
  }
}

/**
 * `init()` is task #560's scope — the SDK dependencies, `definition.yml`, and idempotent domain
 * (analysis scheme / index fields / suggester) provisioning. The page-lifecycle hooks and query
 * adapter are task #562's; `rebuild()` is task #564's — both throw `not implemented yet` here, same
 * split `azure-search` used across #553/#557/#564. Neither talks to the network: there is no local
 * CloudSearch emulator (Feature #381's description), so every suite here builds a fake admin client
 * that records what it was called with and resolves canned describe results, the way a real one would.
 */
;(globalThis as any).WIKI = {
  logger: { info: mock.fn(), warn: mock.fn() },
  sites: {
    'site-1': {
      config: {
        search: {
          engines: {
            'aws-cloudsearch': {
              domain: 'wiki-demo',
              endpoint: 'https://doc-wiki-demo.us-east-1.cloudsearch.amazonaws.com',
              region: 'us-east-1',
              accessKeyId: 'AKIA...',
              secretAccessKey: 'secret',
              analysisSchemeLang: 'en'
            }
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
}

/** A fake `CloudSearchAdminClient` that starts with an empty domain (nothing described yet). */
function fakeClient(
  overrides: Partial<{
    schemes: DescribedAnalysisScheme[]
    fields: DescribedCloudSearchField[]
    suggesters: DescribedSuggester[]
  }> = {}
): CloudSearchAdminClient & {
  defineIndexFieldCalls: string[]
  defineAnalysisSchemeCalls: number
  defineSuggesterCalls: number
  indexDocumentsCalls: number
} {
  const state = {
    schemes: overrides.schemes ?? [],
    fields: overrides.fields ?? [],
    suggesters: overrides.suggesters ?? []
  }
  const client = {
    defineIndexFieldCalls: [] as string[],
    defineAnalysisSchemeCalls: 0,
    defineSuggesterCalls: 0,
    indexDocumentsCalls: 0,
    async describeIndexFields() {
      return state.fields
    },
    async defineIndexField(_domainName: string, field: { name: string }) {
      client.defineIndexFieldCalls.push(field.name)
    },
    async describeAnalysisSchemes() {
      return state.schemes
    },
    async defineAnalysisScheme() {
      client.defineAnalysisSchemeCalls++
    },
    async describeSuggesters() {
      return state.suggesters
    },
    async defineSuggester() {
      client.defineSuggesterCalls++
    },
    async indexDocuments() {
      client.indexDocumentsCalls++
    }
  }
  return client
}

const BASE_CONFIG = {
  domain: 'wiki-demo',
  endpoint: 'https://doc-wiki-demo.us-east-1.cloudsearch.amazonaws.com',
  region: 'us-east-1',
  accessKeyId: 'AKIA...',
  secretAccessKey: 'secret',
  analysisSchemeLang: 'en'
}

describe('aws-cloudsearch module: buildIndexFields', () => {
  const fields = buildIndexFields('wiki_analysis_scheme')

  test('declares one field per name, with no duplicates', () => {
    const names = fields.map((f) => f.name)
    assert.deepEqual(new Set(names).size, names.length)
    assert.deepEqual(
      names.sort(),
      [
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
      ].sort()
    )
  })

  test('siteId is a literal, unreturned, unsearched, unfaceted field (OpenProject #2113)', () => {
    const siteId = fields.find((f) => f.name === 'siteId')!
    assert.equal(siteId.type, 'literal')
    assert.equal(siteId.options.searchEnabled, false)
    assert.equal(siteId.options.facetEnabled, false)
    assert.equal(siteId.options.returnEnabled, false)
  })

  test('id is a literal field with search and facet disabled', () => {
    const id = fields.find((f) => f.name === 'id')!
    assert.equal(id.type, 'literal')
    assert.equal(id.options.searchEnabled, false)
    assert.equal(id.options.facetEnabled, false)
  })

  test('path, locale, title, description and content are text fields referencing the analysis scheme', () => {
    for (const name of ['path', 'locale', 'title', 'description', 'content']) {
      const field = fields.find((f) => f.name === name)!
      assert.equal(field.type, 'text')
      assert.equal(field.options.analysisScheme, 'wiki_analysis_scheme')
    }
  })

  test('content is not returned in results, unlike title/description/path/locale', () => {
    assert.equal(fields.find((f) => f.name === 'content')!.options.returnEnabled, false)
    for (const name of ['path', 'locale', 'title', 'description']) {
      assert.equal(fields.find((f) => f.name === name)!.options.returnEnabled, true)
    }
  })

  test('tags is a literal-array, facet-enabled field', () => {
    const tags = fields.find((f) => f.name === 'tags')!
    assert.equal(tags.type, 'literal-array')
    assert.equal(tags.options.facetEnabled, true)
  })

  test('editor and publishState are facet-enabled literal fields', () => {
    for (const name of ['editor', 'publishState']) {
      const field = fields.find((f) => f.name === name)!
      assert.equal(field.type, 'literal')
      assert.equal(field.options.facetEnabled, true)
    }
  })

  test('is a pure function of the analysis scheme name: same name in, identical fields out', () => {
    assert.deepEqual(buildIndexFields('a'), buildIndexFields('a'))
    assert.notDeepEqual(buildIndexFields('a'), buildIndexFields('b'))
  })
})

describe('aws-cloudsearch module: fieldMatches', () => {
  test('false when nothing is described yet', () => {
    assert.equal(fieldMatches({ name: 'id', type: 'literal', options: {} }, undefined), false)
  })

  test('false when the described type differs', () => {
    assert.equal(
      fieldMatches(
        { name: 'tags', type: 'literal-array', options: {} },
        { name: 'tags', type: 'literal', options: {} }
      ),
      false
    )
  })

  test('false when a desired option differs from what is described', () => {
    assert.equal(
      fieldMatches(
        { name: 'editor', type: 'literal', options: { facetEnabled: true } },
        { name: 'editor', type: 'literal', options: { facetEnabled: false } }
      ),
      false
    )
  })

  test('true when every desired option matches, ignoring options the description carries but this module never set', () => {
    assert.equal(
      fieldMatches(
        { name: 'editor', type: 'literal', options: { facetEnabled: true } },
        { name: 'editor', type: 'literal', options: { facetEnabled: true, searchEnabled: true } }
      ),
      true
    )
  })
})

describe('aws-cloudsearch module: init()', () => {
  test('on an empty domain, defines the analysis scheme, every field and the suggester, then reindexes', async () => {
    const client = fakeClient()
    const module = new AwsCloudSearchModule(() => client)
    await module.init('site-1', BASE_CONFIG)

    assert.equal(client.defineAnalysisSchemeCalls, 1)
    assert.deepEqual(
      client.defineIndexFieldCalls.sort(),
      [
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
      ].sort()
    )
    assert.equal(client.defineSuggesterCalls, 1)
    assert.equal(client.indexDocumentsCalls, 1)
  })

  test('on an already-provisioned domain, defines nothing and skips the reindex', async () => {
    const client = fakeClient({
      schemes: [{ name: 'wiki_analysis_scheme', language: 'en' }],
      fields: buildIndexFields('wiki_analysis_scheme').map((f) => ({
        name: f.name,
        type: f.type,
        options: f.options
      })),
      suggesters: [{ name: 'wiki_title_suggester' }]
    })
    const module = new AwsCloudSearchModule(() => client)
    await module.init('site-1', BASE_CONFIG)

    assert.equal(client.defineAnalysisSchemeCalls, 0)
    assert.deepEqual(client.defineIndexFieldCalls, [])
    assert.equal(client.defineSuggesterCalls, 0)
    assert.equal(client.indexDocumentsCalls, 0)
  })

  test('redefines only the analysis scheme when the configured language changed, and still reindexes', async () => {
    const client = fakeClient({
      schemes: [{ name: 'wiki_analysis_scheme', language: 'en' }],
      fields: buildIndexFields('wiki_analysis_scheme').map((f) => ({
        name: f.name,
        type: f.type,
        options: f.options
      })),
      suggesters: [{ name: 'wiki_title_suggester' }]
    })
    const module = new AwsCloudSearchModule(() => client)
    await module.init('site-1', { ...BASE_CONFIG, analysisSchemeLang: 'fr' })

    assert.equal(client.defineAnalysisSchemeCalls, 1)
    assert.deepEqual(client.defineIndexFieldCalls, [])
    assert.equal(client.defineSuggesterCalls, 0)
    assert.equal(client.indexDocumentsCalls, 1)
  })

  test('redefines only the field whose options actually differ, and still reindexes', async () => {
    const currentFields = buildIndexFields('wiki_analysis_scheme').map((f) => ({
      name: f.name,
      type: f.type,
      options: f.name === 'editor' ? { ...f.options, facetEnabled: false } : f.options
    }))
    const client = fakeClient({
      schemes: [{ name: 'wiki_analysis_scheme', language: 'en' }],
      fields: currentFields,
      suggesters: [{ name: 'wiki_title_suggester' }]
    })
    const module = new AwsCloudSearchModule(() => client)
    await module.init('site-1', BASE_CONFIG)

    assert.deepEqual(client.defineIndexFieldCalls, ['editor'])
    assert.equal(client.indexDocumentsCalls, 1)
  })

  test('is idempotent: a second init() against the now-provisioned domain defines nothing further', async () => {
    const client = fakeClient()
    const module = new AwsCloudSearchModule(() => client)
    await module.init('site-1', BASE_CONFIG)

    // -> Simulate the domain now reporting back exactly what the first call defined.
    const provisioned = fakeClient({
      schemes: [{ name: 'wiki_analysis_scheme', language: 'en' }],
      fields: buildIndexFields('wiki_analysis_scheme').map((f) => ({
        name: f.name,
        type: f.type,
        options: f.options
      })),
      suggesters: [{ name: 'wiki_title_suggester' }]
    })
    const secondModule = new AwsCloudSearchModule(() => provisioned)
    await secondModule.init('site-1', BASE_CONFIG)

    assert.equal(provisioned.defineAnalysisSchemeCalls, 0)
    assert.deepEqual(provisioned.defineIndexFieldCalls, [])
    assert.equal(provisioned.defineSuggesterCalls, 0)
    assert.equal(provisioned.indexDocumentsCalls, 0)
  })

  test('reuses one client per site across repeated init() calls rather than reconnecting each time', async () => {
    let factoryCalls = 0
    const client = fakeClient()
    const module = new AwsCloudSearchModule(() => {
      factoryCalls++
      return client
    })
    await module.init('site-1', BASE_CONFIG)
    await module.init('site-1', BASE_CONFIG)

    assert.equal(factoryCalls, 1)
  })

  test('builds a distinct client per site', async () => {
    const clients: Record<string, ReturnType<typeof fakeClient>> = {}
    const module = new AwsCloudSearchModule((config) => {
      const client = fakeClient()
      clients[config.domain] = client
      return client
    })
    await module.init('site-1', { ...BASE_CONFIG, domain: 'wiki-one' })
    await module.init('site-2', { ...BASE_CONFIG, domain: 'wiki-two' })

    assert.ok(clients['wiki-one'])
    assert.ok(clients['wiki-two'])
    assert.notEqual(clients['wiki-one'], clients['wiki-two'])
  })
})

/** A page row with every field `toIndexDocument`/the lifecycle hooks read. */
function basePage(overrides: Partial<SearchIndexablePage> = {}): SearchIndexablePage {
  return {
    id: 'page-1',
    siteId: 'site-1',
    locale: 'en',
    path: 'en/getting-started',
    title: 'Getting Started',
    description: 'How to get started',
    searchContent: 'Full body text goes here',
    tags: ['guide', 'intro'],
    editor: 'markdown',
    publishState: 'published',
    icon: 'mdi:file',
    classification: 'classification-1',
    password: null,
    updatedAt: new Date('2026-01-15T12:30:00.123Z'),
    ...overrides
  } as any as SearchIndexablePage
}

describe('aws-cloudsearch module: toIndexDocument', () => {
  test('maps a page row to an SDF add document', () => {
    const doc = toIndexDocument(basePage())
    assert.equal(doc.type, 'add')
    assert.equal(doc.id, 'page-1')
    assert.equal(doc.fields.siteId, 'site-1')
    assert.equal(doc.fields.path, 'en/getting-started')
    assert.equal(doc.fields.locale, 'en')
    assert.equal(doc.fields.title, 'Getting Started')
    assert.equal(doc.fields.description, 'How to get started')
    assert.equal(doc.fields.content, 'Full body text goes here')
    assert.deepEqual(doc.fields.tags, ['guide', 'intro'])
    assert.equal(doc.fields.editor, 'markdown')
    assert.equal(doc.fields.publishState, 'published')
    assert.equal(doc.fields.icon, 'mdi:file')
    assert.equal(doc.fields.classification, 'classification-1')
    assert.equal(doc.fields.updatedAt, '2026-01-15T12:30:00.123Z')
  })

  test('hasPassword is the literal string "false" when there is no password', () => {
    assert.equal(toIndexDocument(basePage({ password: null })).fields.hasPassword, 'false')
  })

  test('hasPassword is the literal string "true" when the page has a password', () => {
    assert.equal(toIndexDocument(basePage({ password: 'hunter2' })).fields.hasPassword, 'true')
  })

  test('description/content/icon default to an empty string when null', () => {
    const doc = toIndexDocument(basePage({ description: null, searchContent: null, icon: null }))
    assert.equal(doc.fields.description, '')
    assert.equal(doc.fields.content, '')
    assert.equal(doc.fields.icon, '')
  })
})

describe('aws-cloudsearch module: batchDocuments', () => {
  test('a single small document is its own one-document batch', () => {
    const doc: SdfDocument = { type: 'delete', id: 'p1' }
    assert.deepEqual(batchDocuments([doc]), [[doc]])
  })

  test('splits into batches of at most 1000 documents', () => {
    const docs: SdfDocument[] = Array.from({ length: 2500 }, (_, i) => ({
      type: 'delete',
      id: `p${i}`
    }))
    const batches = batchDocuments(docs)
    assert.deepEqual(
      batches.map((b) => b.length),
      [MAX_BATCH_DOCUMENTS, MAX_BATCH_DOCUMENTS, 500]
    )
    // -> Every document present exactly once, in order
    assert.deepEqual(batches.flat(), docs)
  })

  test('splits into a further batch once the running total would exceed the 5 MB request limit', () => {
    const bigDoc = (id: string): SdfDocument => ({
      type: 'add',
      id,
      fields: { content: 'x'.repeat(900_000) }
    })
    const perDocBytes = Buffer.byteLength(JSON.stringify(bigDoc('p')))
    const perBatch = Math.floor((MAX_BATCH_BYTES - 2) / (perDocBytes + 1))
    const docs = Array.from({ length: perBatch + 1 }, (_, i) => bigDoc(`p${i}`))

    const batches = batchDocuments(docs)

    assert.equal(batches.length, 2)
    assert.equal(batches[0].length, perBatch)
    assert.equal(batches[1].length, 1)
  })

  test('throws when a single document exceeds the 1 MB per-document limit', () => {
    const huge: SdfDocument = {
      type: 'add',
      id: 'huge',
      fields: { content: 'x'.repeat(MAX_DOCUMENT_BYTES + 10) }
    }
    assert.throws(() => batchDocuments([huge]), /per-document limit/)
  })
})

describe('aws-cloudsearch module: buildStructuredQuery', () => {
  test('returns "matchall" for an empty (whitespace-only) query', () => {
    assert.equal(buildStructuredQuery(['title', 'content'], ''), 'matchall')
    assert.equal(buildStructuredQuery(['title', 'content'], '   '), 'matchall')
  })

  test('wraps non-empty terms in an (and (phrase field=... "...")) clause', () => {
    assert.equal(
      buildStructuredQuery(['title', 'description', 'content'], 'hello world'),
      `(and (phrase field=title,description,content 'hello world'))`
    )
  })

  test('escapes an embedded single quote and backslash in the query text', () => {
    const clause = buildStructuredQuery(['title'], `it's a \\test`)
    assert.equal(clause, `(and (phrase field=title 'it\\'s a \\\\test'))`)
  })
})

describe('aws-cloudsearch module: buildFilterQuery', () => {
  test('siteId alone (every other filter off, including draft exclusion) is the whole clause', () => {
    // -> OpenProject #2113: `siteId` is unconditional, unlike every other filter, so this is the
    //    no-filters floor rather than an empty/undefined result.
    assert.equal(
      buildFilterQuery({ siteId: 'site-1', includeDrafts: true }),
      `(term field=siteId 'site-1')`
    )
  })

  test('siteId plus the default draft exclusion and-join into one clause', () => {
    // -> `includeDrafts: false` (the default) always contributes a clause too, so with no other
    //    filter set this is `siteId` and-joined with the draft exclusion.
    assert.equal(
      buildFilterQuery({ siteId: 'site-1' }),
      `(and (term field=siteId 'site-1') (not (term field=publishState 'draft')))`
    )
  })

  test('path becomes a prefix clause, alongside the unconditional siteId term', () => {
    assert.equal(
      buildFilterQuery({ siteId: 'site-1', path: 'en/guides', includeDrafts: true }),
      `(and (term field=siteId 'site-1') (prefix field=path 'en/guides'))`
    )
  })

  test('multiple locales become an or of term clauses', () => {
    assert.equal(
      buildFilterQuery({ siteId: 'site-1', locales: ['en', 'fr'], includeDrafts: true }),
      `(and (term field=siteId 'site-1') (or (term field=locale 'en') (term field=locale 'fr')))`
    )
  })

  test('multiple tags become an or of term clauses, any-of not all-of', () => {
    assert.equal(
      buildFilterQuery({ siteId: 'site-1', tags: ['a', 'b'], includeDrafts: true }),
      `(and (term field=siteId 'site-1') (or (term field=tags 'a') (term field=tags 'b')))`
    )
  })

  test('editor becomes a term clause', () => {
    assert.equal(
      buildFilterQuery({ siteId: 'site-1', editor: 'markdown', includeDrafts: true }),
      `(and (term field=siteId 'site-1') (term field=editor 'markdown'))`
    )
  })

  test('publicOnly restricts to published, overriding includeDrafts', () => {
    assert.equal(
      buildFilterQuery({ siteId: 'site-1', publicOnly: true, includeDrafts: true }),
      `(and (term field=siteId 'site-1') (term field=publishState 'published'))`
    )
  })

  test('an explicit publishState adds its own clause alongside the draft exclusion', () => {
    assert.equal(
      buildFilterQuery({ siteId: 'site-1', publishState: 'published' }),
      `(and (term field=siteId 'site-1') (not (term field=publishState 'draft')) (term field=publishState 'published'))`
    )
  })

  test('hasPassword becomes a literal true/false term clause', () => {
    assert.equal(
      buildFilterQuery({ siteId: 'site-1', hasPassword: false, includeDrafts: true }),
      `(and (term field=siteId 'site-1') (term field=hasPassword 'false'))`
    )
    assert.equal(
      buildFilterQuery({ siteId: 'site-1', hasPassword: true, includeDrafts: true }),
      `(and (term field=siteId 'site-1') (term field=hasPassword 'true'))`
    )
  })

  test('several filters and-join into one clause, siteId always first', () => {
    assert.equal(
      buildFilterQuery({ siteId: 'site-1', path: 'en', editor: 'markdown', includeDrafts: true }),
      `(and (term field=siteId 'site-1') (prefix field=path 'en') (term field=editor 'markdown'))`
    )
  })

  test('always scopes to the requesting site — OpenProject #2113, two sites sharing one domain', () => {
    const clauseForA = buildFilterQuery({ siteId: 'site-a', includeDrafts: true })
    const clauseForB = buildFilterQuery({ siteId: 'site-b', includeDrafts: true })
    assert.ok(clauseForA.includes(`field=siteId 'site-a'`))
    assert.ok(!clauseForA.includes('site-b'))
    assert.ok(clauseForB.includes(`field=siteId 'site-b'`))
    assert.ok(!clauseForB.includes('site-a'))
  })
})

describe('aws-cloudsearch module: buildSort', () => {
  test('relevancy sorts by _score', () => {
    assert.equal(buildSort('relevancy', 'desc'), '_score desc')
    assert.equal(buildSort('relevancy', 'asc'), '_score asc')
  })

  test('a plain field name is used as-is', () => {
    assert.equal(buildSort('title', 'asc'), 'title asc')
    assert.equal(buildSort('updatedAt', 'desc'), 'updatedAt desc')
  })
})

/**
 * A fake `CloudSearchQueryClient`. `search()` is scripted per call via `results` (a queue, drained in
 * FIFO order) so a test exercising the protected-content split can hand back a different hit set to
 * each of the two queries `runProtectedSplitQuery` issues.
 */
function fakeQueryClient(
  results: { found?: number; hit: CloudSearchHit[] }[] = [{ found: 0, hit: [] }]
): CloudSearchQueryClient & {
  uploaded: SdfDocument[][]
  searches: CloudSearchSearchRequest[]
} {
  const queue = [...results]
  const uploaded: SdfDocument[][] = []
  const searches: CloudSearchSearchRequest[] = []
  return {
    uploaded,
    searches,
    async uploadDocuments(batch) {
      uploaded.push(batch)
    },
    async search(request) {
      searches.push(request)
      const next = queue.shift() ?? { found: 0, hit: [] }
      return { hits: { found: next.found ?? 0, hit: next.hit } }
    }
  }
}

/** A hit as `SearchCommand` would report it, with every field this module reads pre-populated. */
function hit(overrides: Partial<CloudSearchHit> & { id: string }): CloudSearchHit {
  const fields = overrides.fields ?? {}
  return {
    id: overrides.id,
    fields: {
      path: ['en/getting-started'],
      locale: ['en'],
      title: ['Getting Started'],
      description: ['How to get started'],
      tags: ['guide'],
      updatedAt: ['2026-01-15T12:30:00.123Z'],
      _score: ['1.5'],
      ...fields
    },
    highlights: overrides.highlights
  }
}

describe('aws-cloudsearch module: page lifecycle hooks', () => {
  test('created uploads a single add document', async () => {
    const client = fakeQueryClient()
    const module = new AwsCloudSearchModule(undefined, () => client)
    await module.created(basePage())

    assert.equal(client.uploaded.length, 1)
    assert.equal(client.uploaded[0].length, 1)
    assert.equal(client.uploaded[0][0].type, 'add')
    assert.equal(client.uploaded[0][0].id, 'page-1')
  })

  test('updated uploads a single add document', async () => {
    const client = fakeQueryClient()
    const module = new AwsCloudSearchModule(undefined, () => client)
    await module.updated(basePage({ title: 'Updated Title' }))

    assert.equal((client.uploaded[0][0] as any).fields.title, 'Updated Title')
  })

  test('deleted uploads a single delete document, by id only', async () => {
    const client = fakeQueryClient()
    const module = new AwsCloudSearchModule(undefined, () => client)
    await module.deleted('site-1', 'page-1')

    assert.deepEqual(client.uploaded, [[{ type: 'delete', id: 'page-1' }]])
  })

  test('renamed re-uploads the page as an add, ignoring previousPath', async () => {
    const client = fakeQueryClient()
    const module = new AwsCloudSearchModule(undefined, () => client)
    await module.renamed('site-1', basePage({ path: 'en/new-path' }), 'en/old-path')

    assert.equal(client.uploaded[0][0].type, 'add')
    assert.equal((client.uploaded[0][0] as any).fields.path, 'en/new-path')
  })

  test('a failed upload is swallowed and logged, not thrown', async () => {
    const client: CloudSearchQueryClient = {
      async uploadDocuments() {
        throw new Error('boom')
      },
      async search() {
        return { hits: { found: 0, hit: [] } }
      }
    }
    const module = new AwsCloudSearchModule(undefined, () => client)
    await module.created(basePage())
    await module.deleted('site-1', 'page-1')
    // -> Neither call threw
    assert.ok(true)
  })
})

/**
 * OpenProject #922: the query client used to be cached by siteId alone, so changing
 * `region`/`accessKeyId`/`secretAccessKey`/`endpoint`/`domain` in the admin area had no effect until a
 * process restart. Cached alongside a `configKey` (as JSON) now, mirroring the pattern
 * `elasticsearch`/`algolia`'s `getClient()` already use.
 */
describe('aws-cloudsearch module: query client caching', () => {
  test('reuses the same client across calls when the site config is unchanged', async () => {
    let factoryCalls = 0
    const client = fakeQueryClient()
    const module = new AwsCloudSearchModule(undefined, () => {
      factoryCalls++
      return client
    })

    await module.created(basePage())
    await module.created(basePage())

    assert.equal(factoryCalls, 1)
  })

  test('builds a fresh client once the site config changes, rather than keeping a stale one', async () => {
    let factoryCalls = 0
    const client = fakeQueryClient()
    const module = new AwsCloudSearchModule(undefined, () => {
      factoryCalls++
      return client
    })
    const engines = (globalThis as any).WIKI.sites['site-1'].config.search.engines
    const originalConfig = engines['aws-cloudsearch']

    try {
      await module.created(basePage())
      assert.equal(factoryCalls, 1)

      engines['aws-cloudsearch'] = { ...originalConfig, domain: 'wiki-demo-v2' }
      await module.created(basePage())
      assert.equal(factoryCalls, 2)
    } finally {
      engines['aws-cloudsearch'] = originalConfig
    }
  })
})

describe('aws-cloudsearch module: query()', () => {
  test('a browse with no query text uses "matchall" and no highlight', async () => {
    const client = fakeQueryClient([{ found: 1, hit: [hit({ id: 'page-1' })] }])
    const module = new AwsCloudSearchModule(undefined, () => client)
    const result = await module.query({ siteId: 'site-1' })

    assert.equal(client.searches.length, 1)
    assert.equal(client.searches[0].query, 'matchall')
    assert.equal(client.searches[0].highlight, undefined)
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].id, 'page-1')
    assert.equal(result.totalHits, 1)
  })

  test('a text query with hideProtectedContent off runs a single query with highlight', async () => {
    const client = fakeQueryClient([
      {
        found: 1,
        hit: [hit({ id: 'page-1', highlights: { content: 'a b c' } })]
      }
    ])
    const module = new AwsCloudSearchModule(undefined, () => client)
    const result = await module.query({
      siteId: 'site-1',
      query: 'hello',
      hideProtectedContent: false
    })

    assert.equal(client.searches.length, 1)
    assert.match(client.searches[0].query, /phrase field=title,description,content 'hello'/)
    assert.ok(client.searches[0].highlight)
    assert.equal(result.results[0].highlight, 'a <b>b</b> c')
  })

  test('hideProtectedContent splits into two queries and merges the results', async () => {
    const client = fakeQueryClient([
      { found: 1, hit: [hit({ id: 'public-1' })] },
      { found: 1, hit: [hit({ id: 'protected-1' })] }
    ])
    const module = new AwsCloudSearchModule(undefined, () => client)
    const result = await module.query({ siteId: 'site-1', query: 'hello' })

    assert.equal(client.searches.length, 2)
    assert.match(client.searches[0].query, /title,description,content/)
    assert.match(client.searches[0].filterQuery!, /hasPassword 'false'/)
    assert.match(client.searches[1].query, /title,description/)
    assert.ok(!client.searches[1].query.includes(',content'))
    assert.match(client.searches[1].filterQuery!, /hasPassword 'true'/)
    assert.equal(client.searches[1].highlight, undefined)
    assert.equal(result.results.length, 2)
    assert.equal(result.totalHits, 2)
  })

  test('rows a page rule denies are filtered out, and totalHits accounts for it', async () => {
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      _actor: any,
      _perm: string,
      page: { path: string }
    ) => page.path !== 'en/secret'
    try {
      const client = fakeQueryClient([
        {
          found: 2,
          hit: [
            hit({ id: 'visible', fields: { path: ['en/visible'] } }),
            hit({ id: 'hidden', fields: { path: ['en/secret'] } })
          ]
        }
      ])
      const module = new AwsCloudSearchModule(undefined, () => client)
      const result = await module.query({ siteId: 'site-1', actor: {} as any })

      assert.equal(result.results.length, 1)
      assert.equal(result.results[0].id, 'visible')
      assert.equal(result.totalHits, 1)
    } finally {
      ;(globalThis as any).WIKI.models.groups.checkAccess = () => true
    }
  })

  test('passes each hit’s own indexed classification to checkAccess, not a hardcoded null (OpenProject #1125)', async () => {
    const seen: any[] = []
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      _actor: any,
      _perm: string,
      page: any
    ) => {
      seen.push(page.classification)
      return true
    }
    try {
      const client = fakeQueryClient([
        {
          found: 1,
          hit: [hit({ id: 'p1', fields: { classification: ['classification-restricted'] } })]
        }
      ])
      const module = new AwsCloudSearchModule(undefined, () => client)
      await module.query({ siteId: 'site-1', actor: {} as any })

      assert.deepEqual(seen, ['classification-restricted'])
    } finally {
      ;(globalThis as any).WIKI.models.groups.checkAccess = () => true
    }
  })

  test('reuses one query client per site across repeated query() calls', async () => {
    let factoryCalls = 0
    const client = fakeQueryClient([
      { found: 0, hit: [] },
      { found: 0, hit: [] }
    ])
    const module = new AwsCloudSearchModule(undefined, () => {
      factoryCalls++
      return client
    })
    await module.query({ siteId: 'site-1' })
    await module.query({ siteId: 'site-1' })

    assert.equal(factoryCalls, 1)
  })
})

/**
 * A fake `RebuildPageSource`: pages supplied per locale, sliced by whatever `offset`/`limit`
 * `rebuild()` actually passes — records every call so a test can assert the pagination loop walked
 * the full set in the batches it should have, rather than only checking the final tally. Identical
 * shape to `azure-search`'s own `fakePageSource` (task #564), copied rather than imported — each
 * module's test file stays self-contained too.
 */
function fakePageSource(
  pagesByLocale: Record<string, SearchIndexablePage[]>
): RebuildPageSource & { calls: { locale: string; offset: number; limit: number }[] } {
  const calls: { locale: string; offset: number; limit: number }[] = []
  return {
    calls,
    async locales() {
      return Object.keys(pagesByLocale)
    },
    async pageBatch(_siteId, locale, offset, limit) {
      calls.push({ locale, offset, limit })
      return (pagesByLocale[locale] ?? []).slice(offset, offset + limit)
    }
  }
}

describe('aws-cloudsearch module: rebuild()', () => {
  test('streams every locale through uploadBatch and reports a per-locale RebuildResult', async () => {
    const client = fakeQueryClient()
    const source = fakePageSource({
      en: [basePage({ id: 'en-1' }), basePage({ id: 'en-2' })],
      fr: [basePage({ id: 'fr-1', locale: 'fr' })]
    })
    const module = new AwsCloudSearchModule(undefined, () => client, source)

    const result = await module.rebuild('site-1')

    assert.equal(result.pages, 3)
    assert.deepEqual(result.locales, [
      { locale: 'en', pages: 2 },
      { locale: 'fr', pages: 1 }
    ])
    // -> No `dictionary` on either entry: this engine has no such concept (see `RebuildResult`'s own
    //    doc comment in `models/search.ts`).
    assert.ok(result.locales.every((l) => !('dictionary' in l)))
  })

  test('uploads the exact SDF documents toIndexDocument would build for each page', async () => {
    const client = fakeQueryClient()
    const source = fakePageSource({ en: [basePage({ id: 'en-1' })] })
    const module = new AwsCloudSearchModule(undefined, () => client, source)

    await module.rebuild('site-1')

    assert.equal(client.uploaded.length, 1)
    assert.deepEqual(client.uploaded[0], [toIndexDocument(basePage({ id: 'en-1' }))])
  })

  test('paginates a locale larger than one read batch, walking every row exactly once', async () => {
    const client = fakeQueryClient()
    const enPages = Array.from({ length: REBUILD_BATCH_SIZE + 3 }, (_, i) =>
      basePage({ id: `en-${i}` })
    )
    const source = fakePageSource({ en: enPages })
    const module = new AwsCloudSearchModule(undefined, () => client, source)

    const result = await module.rebuild('site-1')

    assert.equal(result.pages, REBUILD_BATCH_SIZE + 3)
    // -> Two `pageBatch` calls (a full read batch, then the 3-row remainder) each fed straight into
    //    `uploadBatch` -- and since both batches are well under CloudSearch's own 1000-document/5MB
    //    `UploadDocuments` limits (`batchDocuments`, task #562), each becomes exactly one upload.
    assert.deepEqual(
      source.calls.map((c) => c.offset),
      [0, REBUILD_BATCH_SIZE]
    )
    assert.equal(client.uploaded.length, 2)
    assert.equal(client.uploaded[0]!.length, REBUILD_BATCH_SIZE)
    assert.equal(client.uploaded[1]!.length, 3)
    const ids = new Set(client.uploaded.flat().map((d) => d.id))
    assert.equal(ids.size, REBUILD_BATCH_SIZE + 3)
  })

  test('a locale with no pages contributes zero and no upload call', async () => {
    const client = fakeQueryClient()
    const source = fakePageSource({ en: [] })
    const module = new AwsCloudSearchModule(undefined, () => client, source)

    const result = await module.rebuild('site-1')

    assert.deepEqual(result, { pages: 0, locales: [{ locale: 'en', pages: 0 }] })
    assert.equal(client.uploaded.length, 0)
  })

  /**
   * OpenProject #922: `rebuild()` only ever added/overwrote documents, so a page deleted while this
   * engine was unreachable stayed in the domain forever -- a ghost result. It now queries every id
   * already in the domain and uploads an SDF `delete` entry for whichever ones were not just
   * re-uploaded.
   */
  describe('purges ghost documents', () => {
    test('deletes a domain id that was not re-uploaded, keeps the ones that were', async () => {
      const client = fakeQueryClient([
        { found: 2, hit: [hit({ id: 'stays' }), hit({ id: 'ghost' })] }
      ])
      const source = fakePageSource({ en: [basePage({ id: 'stays' })] })
      const module = new AwsCloudSearchModule(undefined, () => client, source)

      await module.rebuild('site-1')

      const deleteEntries = client.uploaded.flat().filter((doc) => doc.type === 'delete')
      assert.deepEqual(deleteEntries, [{ type: 'delete', id: 'ghost' }])
    })

    test('deletes nothing when every previously-indexed id was re-uploaded', async () => {
      const client = fakeQueryClient([{ found: 1, hit: [hit({ id: 'page-1' })] }])
      const source = fakePageSource({ en: [basePage({ id: 'page-1' })] })
      const module = new AwsCloudSearchModule(undefined, () => client, source)

      await module.rebuild('site-1')

      const deleteEntries = client.uploaded.flat().filter((doc) => doc.type === 'delete')
      assert.deepEqual(deleteEntries, [])
    })

    test('the domain-id lookup uses a matchall query, not siteId -- this module talks to one domain per site', async () => {
      const client = fakeQueryClient([{ found: 1, hit: [hit({ id: 'ghost' })] }])
      const source = fakePageSource({ en: [] })
      const module = new AwsCloudSearchModule(undefined, () => client, source)

      await module.rebuild('site-1')

      assert.equal(client.searches[0]!.query, 'matchall')
      assert.equal(client.searches[0]!.filterQuery, undefined)
    })
  })
})

describe('aws-cloudsearch module: default export', () => {
  test('is a singleton AwsCloudSearchModule instance', () => {
    assert.ok(defaultAwsCloudSearchModule instanceof AwsCloudSearchModule)
  })
})
