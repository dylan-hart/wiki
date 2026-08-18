import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import {
  AwsCloudSearchModule,
  buildIndexFields,
  fieldMatches,
  type CloudSearchAdminClient,
  type DescribedAnalysisScheme,
  type DescribedCloudSearchField,
  type DescribedSuggester
} from './search.ts'
import defaultAwsCloudSearchModule from './search.ts'

/**
 * `init()` is task #560's scope — the SDK dependencies, `definition.yml`, and idempotent domain
 * (analysis scheme / index fields / suggester) provisioning. The page-lifecycle hooks and query
 * adapter are task #562's; `rebuild()` is task #564's — both throw `not implemented yet` here, same
 * split `azure-search` used across #553/#557/#564. Neither talks to the network: there is no local
 * CloudSearch emulator (Feature #381's description), so every suite here builds a fake admin client
 * that records what it was called with and resolves canned describe results, the way a real one would.
 */
;(globalThis as any).WIKI = {
  logger: { info: mock.fn(), warn: mock.fn() }
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
        'content',
        'description',
        'editor',
        'id',
        'locale',
        'path',
        'publishState',
        'tags',
        'title'
      ].sort()
    )
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
        'content',
        'description',
        'editor',
        'id',
        'locale',
        'path',
        'publishState',
        'tags',
        'title'
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

describe('aws-cloudsearch module: not-yet-implemented hooks', () => {
  test('created/updated/deleted/renamed/query throw, pointing at task #562', async () => {
    const module = new AwsCloudSearchModule(() => fakeClient())
    await assert.rejects(() => module.created({} as any), /task #562/)
    await assert.rejects(() => module.updated({} as any), /task #562/)
    await assert.rejects(() => module.deleted('site-1', 'page-1'), /task #562/)
    await assert.rejects(() => module.renamed('site-1', {} as any, '/old'), /task #562/)
    await assert.rejects(() => module.query({ siteId: 'site-1' }), /task #562/)
  })

  test('rebuild throws, pointing at task #564', async () => {
    const module = new AwsCloudSearchModule(() => fakeClient())
    await assert.rejects(() => module.rebuild('site-1'), /task #564/)
  })
})

describe('aws-cloudsearch module: default export', () => {
  test('is a singleton AwsCloudSearchModule instance', () => {
    assert.ok(defaultAwsCloudSearchModule instanceof AwsCloudSearchModule)
  })
})
