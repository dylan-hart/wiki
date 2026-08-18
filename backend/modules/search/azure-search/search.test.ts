import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { AzureSearchModule, buildIndexSchema, type AzureSearchIndexClient } from './search.ts'
import defaultAzureSearchModule from './search.ts'
import type { SearchIndex } from '@azure/search-documents'

/**
 * `init()` is this module's whole scope for task #553 — the SDK dependency, `definition.yml`, and
 * idempotent index provisioning. There is no local Azure AI Search emulator (see Feature #381's
 * description), so this suite never talks to the network: it builds a fake `AzureSearchIndexClient`
 * that records what it was called with and resolves, the same way a real `createOrUpdateIndex` would
 * for a schema that matches what's already there.
 *
 * A stub `WIKI.logger` is required because `init()` logs on success — the same reason
 * `test/mocks.ts` exists for model-layer tests, just inlined here rather than imported, since this
 * suite needs nothing else off the `WIKI` global.
 */
;(globalThis as any).WIKI = { logger: { info: mock.fn(), warn: mock.fn() } }

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

describe('azure-search module: buildIndexSchema', () => {
  const schema = buildIndexSchema('wiki')

  test('declares one field per name, with no duplicates', () => {
    const names = schema.fields.map((f) => f.name)
    assert.equal(new Set(names).size, names.length)
    assert.deepEqual(names.sort(), [
      'content',
      'description',
      'editor',
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

  test('defaults the index name to "wiki" when unset', async () => {
    const client = fakeClient()
    const azureSearch = new AzureSearchModule(() => client)

    await azureSearch.init('site-1', { serviceName: 'demo', adminApiKey: 'key' })

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

describe('azure-search module: hooks not yet implemented (task #557 / #564)', () => {
  const azureSearch = new AzureSearchModule(() => fakeClient())
  const page = { id: 'p1', siteId: 'site-1', locale: 'en' } as any

  test('created() rejects', async () => {
    await assert.rejects(azureSearch.created(page))
  })
  test('updated() rejects', async () => {
    await assert.rejects(azureSearch.updated(page))
  })
  test('deleted() rejects', async () => {
    await assert.rejects(azureSearch.deleted('site-1', 'p1'))
  })
  test('renamed() rejects', async () => {
    await assert.rejects(azureSearch.renamed('site-1', page, 'old-path'))
  })
  test('query() rejects', async () => {
    await assert.rejects(azureSearch.query({ siteId: 'site-1' }))
  })
  test('rebuild() rejects', async () => {
    await assert.rejects(azureSearch.rebuild('site-1'))
  })
})

describe('azure-search module: default export', () => {
  test('is an AzureSearchModule instance', () => {
    assert.ok(defaultAzureSearchModule instanceof AzureSearchModule)
  })
})
