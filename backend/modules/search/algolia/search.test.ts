import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTemporal } from '../../../test/temporal.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeIndexablePage, stubPageStreamDb } from '../../../test/builders.ts'
import { runSearchModuleContract } from '../../../test/searchModuleContract.ts'
import { search } from '../../../models/search.ts'
import {
  AlgoliaSearchModule,
  MAX_DOCUMENT_BYTES,
  batchDocuments,
  buildFilters,
  pageToDocument,
  pathAncestors,
  type AlgoliaPageDocument
} from './search.ts'
import { MAX_INDEXING_COUNT } from '../shared.ts'
import type { SearchPagesParams } from '../../../models/search.ts'

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const ALGOLIA_CONFIG = { appId: 'app123', apiKey: 'key456', indexName: 'wiki-test' }

before(() => ensureTemporal())

const fakePage = makeIndexablePage

function fakeAlgoliaClient() {
  const calls: Record<string, any[]> = {
    setSettings: [],
    saveObject: [],
    deleteObject: [],
    searchSingleIndex: [],
    deleteBy: [],
    batch: []
  }
  let searchResponse: any = { hits: [], nbHits: 0 }
  const client: any = {
    setSettings: mock.fn(async (args: any) => {
      calls.setSettings!.push(args)
      return {}
    }),
    saveObject: mock.fn(async (args: any) => {
      calls.saveObject!.push(args)
      return {}
    }),
    deleteObject: mock.fn(async (args: any) => {
      calls.deleteObject!.push(args)
      return {}
    }),
    searchSingleIndex: mock.fn(async (args: any) => {
      calls.searchSingleIndex!.push(args)
      return searchResponse
    }),
    deleteBy: mock.fn(async (args: any) => {
      calls.deleteBy!.push(args)
      return {}
    }),
    batch: mock.fn(async (args: any) => {
      calls.batch!.push(args)
      return {}
    })
  }
  return {
    client,
    calls,
    setSearchResponse: (response: any) => {
      searchResponse = response
    }
  }
}

function moduleWithFakeClient() {
  const mod = new AlgoliaSearchModule()
  const fake = fakeAlgoliaClient()
  ;(mod as any).createClient = () => fake.client
  return { mod, ...fake }
}

describe('pathAncestors()', () => {
  test('returns every ancestor segment, deepest last', () => {
    assert.deepEqual(pathAncestors('a/b/c'), ['a', 'a/b', 'a/b/c'])
  })

  test('a top-level path has exactly one ancestor: itself', () => {
    assert.deepEqual(pathAncestors('home'), ['home'])
  })

  test('ignores stray slashes', () => {
    assert.deepEqual(pathAncestors('/a//b/'), ['a', 'a/b'])
  })
})

describe('buildFilters()', () => {
  function params(overrides: Partial<SearchPagesParams> = {}): SearchPagesParams {
    return { siteId: 'site-1', ...overrides }
  }

  test('always scopes to the site and requires isSearchable, excluding drafts by default', () => {
    assert.equal(
      buildFilters(params()),
      'siteId:"site-1" AND isSearchable:true AND NOT publishState:"draft"'
    )
  })

  test('publicOnly restricts to published, taking precedence over the includeDrafts branch', () => {
    assert.equal(
      buildFilters(params({ publicOnly: true })),
      'siteId:"site-1" AND isSearchable:true AND publishState:"published"'
    )
  })

  test('includeDrafts drops the NOT-draft condition', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true })),
      'siteId:"site-1" AND isSearchable:true'
    )
  })

  test('an explicit publishState ANDs onto the publicOnly/includeDrafts branch, not replaces it', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, publishState: 'published' })),
      'siteId:"site-1" AND isSearchable:true AND publishState:"published"'
    )
  })

  test('path becomes a pathAncestors equality filter', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, path: 'docs/guide' })),
      'siteId:"site-1" AND isSearchable:true AND pathAncestors:"docs/guide"'
    )
  })

  test('locales become an OR group', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, locales: ['en', 'fr'] })),
      'siteId:"site-1" AND isSearchable:true AND (locale:"en" OR locale:"fr")'
    )
  })

  test("tags are ANDed, requiring every one present (mirrors the db module's @> containment)", () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, tags: ['a', 'b'] })),
      'siteId:"site-1" AND isSearchable:true AND tags:"a" AND tags:"b"'
    )
  })

  test('editor becomes an equality filter', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, editor: 'markdown' })),
      'siteId:"site-1" AND isSearchable:true AND editor:"markdown"'
    )
  })

  test('escapes a quote embedded in a filter value', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, editor: 'weird"editor' })),
      'siteId:"site-1" AND isSearchable:true AND editor:"weird\\"editor"'
    )
  })

  test('escapes a quote embedded in siteId itself', () => {
    assert.equal(
      buildFilters({ siteId: 'weird"site' }),
      'siteId:"weird\\"site" AND isSearchable:true AND NOT publishState:"draft"'
    )
  })
})

describe('pageToDocument()', () => {
  test('carries the searchable/faceted fields, including pathAncestors', () => {
    const doc = pageToDocument(fakePage())
    assert.equal(doc.objectID, 'p1')
    assert.equal(doc.path, 'docs/kangaroo')
    assert.deepEqual(doc.pathAncestors, ['docs', 'docs/kangaroo'])
    assert.equal(doc.title, 'The Wandering Kangaroo')
    assert.deepEqual(doc.tags, ['animals'])
    assert.equal(doc.editor, 'markdown')
    assert.equal(doc.publishState, 'published')
    assert.equal(doc.isSearchable, true)
    assert.equal(doc.classification, 'classification-1')
    assert.equal(doc.content, 'Hello kangaroo content')
  })

  test('never sends content for a password-protected page', () => {
    const doc = pageToDocument(fakePage({ password: 'letmein' }))
    assert.equal('content' in doc, false)
    assert.equal(doc.title, 'The Wandering Kangaroo')
    assert.equal(doc.description, 'A page about kangaroos')
  })

  test('formats a Date updatedAt as an ISO string', () => {
    const doc = pageToDocument(fakePage({ updatedAt: new Date('2026-03-04T05:06:07.000Z') }))
    assert.equal(doc.updatedAt, '2026-03-04T05:06:07.000Z')
  })
})

describe('batchDocuments()', () => {
  function doc(overrides: Partial<AlgoliaPageDocument> = {}): AlgoliaPageDocument {
    return {
      objectID: 'p1',
      siteId: 's1',
      locale: 'en',
      path: 'a',
      pathAncestors: ['a'],
      title: 'A',
      description: '',
      icon: null,
      tags: [],
      editor: 'markdown',
      publishState: 'published',
      isSearchable: true,
      classification: 'classification-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides
    }
  }

  test('a handful of small documents fit in a single batch', () => {
    const docs = [doc({ objectID: 'p1' }), doc({ objectID: 'p2' }), doc({ objectID: 'p3' })]
    assert.deepEqual(batchDocuments(docs), { batches: [docs], skipped: [] })
  })

  test('an empty list produces no batches', () => {
    assert.deepEqual(batchDocuments([]), { batches: [], skipped: [] })
  })

  test('splits once the object count reaches MAX_INDEXING_COUNT', () => {
    const docs = Array.from({ length: MAX_INDEXING_COUNT + 1 }, (_, i) =>
      doc({ objectID: `p${i}` })
    )
    const { batches, skipped } = batchDocuments(docs)
    assert.equal(batches.length, 2)
    assert.equal(batches[0]!.length, MAX_INDEXING_COUNT)
    assert.equal(batches[1]!.length, 1)
    assert.deepEqual(skipped, [])
  })

  test('does not split early: near-max-size documents stay in one batch below both caps', () => {
    // -> With the real constants the count cap always binds before the byte cap, so a batch split by
    //    bytes alone cannot be constructed without a document that violates the per-object cap. This
    //    guards the byte accumulator instead: large-but-valid documents under both limits must not be
    //    split by an off-by-one in the running total.
    const big = 'x'.repeat(8000)
    const docs = Array.from({ length: 500 }, (_, i) => doc({ objectID: `p${i}`, description: big }))
    assert.deepEqual(batchDocuments(docs), { batches: [docs], skipped: [] })
  })

  test('diverts a single document that alone exceeds MAX_DOCUMENT_BYTES into `skipped`, batching the rest', () => {
    const huge = doc({
      objectID: 'p-huge',
      path: 'docs/huge',
      description: 'x'.repeat(MAX_DOCUMENT_BYTES)
    })
    const small1 = doc({ objectID: 'p1' })
    const small2 = doc({ objectID: 'p2' })

    const { batches, skipped } = batchDocuments([small1, huge, small2])

    assert.deepEqual(batches, [[small1, small2]])
    assert.equal(skipped.length, 1)
    assert.equal(skipped[0]!.objectID, 'p-huge')
    assert.equal(skipped[0]!.path, 'docs/huge')
    assert.ok(skipped[0]!.bytes >= MAX_DOCUMENT_BYTES)
  })

  test('multiple oversized documents are all reported, batching everything that fits around them', () => {
    const huge1 = doc({ objectID: 'p-huge-1', description: 'x'.repeat(MAX_DOCUMENT_BYTES) })
    const huge2 = doc({ objectID: 'p-huge-2', description: 'y'.repeat(MAX_DOCUMENT_BYTES) })
    const small = doc({ objectID: 'p1' })

    const { batches, skipped } = batchDocuments([huge1, small, huge2])

    assert.deepEqual(batches, [[small]])
    assert.deepEqual(
      skipped.map((doc) => doc.objectID),
      ['p-huge-1', 'p-huge-2']
    )
  })
})

/**
 * There is deliberately no live-cluster companion suite here, unlike Elasticsearch's: Algolia is
 * hosted SaaS with nothing to bring up in a compose file, so a real run would mean either committing
 * live API keys to CI or skipping in every environment without them. The fake client's `calls`
 * recorder stands in, asserted against the request shapes the real SDK methods take. The engine
 * config comes off the real `definition.yml` on disk, so `getEngineConfig()` resolves defaults
 * exactly as the running app would.
 */
describe('AlgoliaSearchModule', () => {
  const siteId = 'site-1'
  let wikiHandle: { restore(): void }

  before(async () => {
    wikiHandle = installTestWiki({
      SERVERPATH: backendDir,
      sites: {
        [siteId]: {
          config: { search: { engine: 'algolia', engines: { algolia: ALGOLIA_CONFIG } } }
        }
      },
      models: {
        groups: {
          checkAccess: () => true
        }
      }
    })
    await search.refreshFromDisk()
  })

  after(() => {
    wikiHandle.restore()
  })

  test('init() pushes searchableAttributes and the facet attributes to Algolia', async () => {
    const { mod, calls } = moduleWithFakeClient()
    await mod.init(siteId, ALGOLIA_CONFIG)

    assert.equal(calls.setSettings!.length, 1)
    const [{ indexName, indexSettings }] = calls.setSettings!
    assert.equal(indexName, 'wiki-test')
    assert.deepEqual(indexSettings.searchableAttributes, ['title', 'description', 'content'])
    for (const facet of [
      'tags',
      'locale',
      'editor',
      'publishState',
      'isSearchable',
      'pathAncestors',
      'siteId'
    ]) {
      assert.ok(indexSettings.attributesForFaceting.includes(facet), `missing facet: ${facet}`)
    }
  })

  test('an index name the operator CLEARED still targets "wiki", not an unnamed index', async () => {
    // -> `getEngineConfig`'s merge substitutes a declared default only for `undefined`, and an
    //    emptied text field is stored as `''`, so the module completes empty strings itself
    //    (`shared.ts#fillEmptyStringDefaults`).
    const { mod, calls } = moduleWithFakeClient()
    await mod.init(siteId, { appId: 'app123', apiKey: 'key456', indexName: '' })

    assert.equal(calls.setSettings![0].indexName, 'wiki')
  })

  describe('rebuild()', () => {
    let previousDb: any

    before(() => {
      previousDb = (globalThis as any).CARDINAL.db
    })

    after(() => {
      ;(globalThis as any).CARDINAL.db = previousDb
    })

    /** The batching and per-locale tally are the shared contract's; only these shapes are Algolia's. */
    test('purges this site’s records with a scoped deleteBy, and sends addObject requests', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).CARDINAL.db = stubPageStreamDb([
        fakePage({ id: 'p1', locale: 'en' }),
        fakePage({ id: 'p2', locale: 'en' }),
        fakePage({ id: 'p3', locale: 'fr' })
      ])

      const result = await mod.rebuild(siteId)

      assert.equal(calls.deleteBy!.length, 1)
      assert.equal(calls.deleteBy![0].indexName, 'wiki-test')
      assert.equal(calls.deleteBy![0].deleteByParams.filters, `siteId:"${siteId}"`)
      assert.equal(calls.batch![0].batchWriteParams.requests[0].action, 'addObject')
      assert.deepEqual(
        result.locales.sort((a: any, b: any) => a.locale.localeCompare(b.locale)),
        [
          { locale: 'en', dictionary: 'n/a', pages: 2 },
          { locale: 'fr', dictionary: 'n/a', pages: 1 }
        ]
      )
    })

    test('an oversized page is skipped with a logged warning, the rest of the site still gets indexed', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).CARDINAL.db = stubPageStreamDb([
        fakePage({ id: 'p1', path: 'docs/small-one', locale: 'en' }),
        fakePage({
          id: 'p-huge',
          path: 'docs/huge-page',
          locale: 'en',
          searchContent: 'x'.repeat(MAX_DOCUMENT_BYTES)
        }),
        fakePage({ id: 'p2', path: 'docs/small-two', locale: 'fr' })
      ])
      const warnings: { scope: string; message: string; fields?: Record<string, any> }[] = []
      const previousWarn = (globalThis as any).CARDINAL.logger.warn
      ;(globalThis as any).CARDINAL.logger.warn = (
        scope: string,
        message: string,
        fields?: Record<string, any>
      ) => warnings.push({ scope, message, fields })

      let result
      try {
        result = await mod.rebuild(siteId)
      } finally {
        ;(globalThis as any).CARDINAL.logger.warn = previousWarn
      }

      assert.equal(calls.batch!.length, 1)
      assert.equal(calls.batch![0].batchWriteParams.requests.length, 2)
      const sentIds = calls
        .batch![0].batchWriteParams.requests.map((r: any) => r.body.objectID)
        .sort()
      assert.deepEqual(sentIds, ['p1', 'p2'])

      assert.equal(result.pages, 2)
      assert.deepEqual(
        result.locales.sort((a: any, b: any) => a.locale.localeCompare(b.locale)),
        [
          { locale: 'en', dictionary: 'n/a', pages: 1 },
          { locale: 'fr', dictionary: 'n/a', pages: 1 }
        ]
      )

      // -> Asserted against the warning's fields, not its rendered message: the facts live in the
      //    fields, and the sentence is the logger's to format.
      assert.ok(warnings.some((w) => w.scope === 'search' && w.fields?.path === 'docs/huge-page'))
      assert.equal(result.warnings?.length, 1)
      assert.ok(result.warnings![0]!.includes('docs/huge-page'))
    })

    /** That an empty site sends no batches is the contract's; that it still purges is Algolia's. */
    test('an empty site still purges its own records', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).CARDINAL.db = stubPageStreamDb([])

      const result = await mod.rebuild(siteId)

      assert.equal(calls.deleteBy!.length, 1)
      assert.deepEqual(result.locales, [])
    })

    test('does not touch another site’s records: rebuild scopes its purge to siteId', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).CARDINAL.db = stubPageStreamDb([fakePage({ id: 'p1' })])

      await mod.rebuild(siteId)

      assert.equal(calls.deleteBy!.length, 1)
      assert.doesNotMatch(calls.deleteBy![0].deleteByParams.filters, /site-2/)
      // -> The fake client has no whole-index clear method, so a regression to `clearObjects` fails
      //    with a `TypeError` rather than silently passing.
      assert.equal(typeof calls.clearObjects, 'undefined')
    })
  })
})

/** The claims every external engine owes; everything above this line is Algolia's alone. */
runSearchModuleContract('algolia', {
  config: ALGOLIA_CONFIG,
  siteConfig: { search: { engine: 'algolia', engines: { algolia: ALGOLIA_CONFIG } } },
  makeModule: () => {
    const { mod, calls, setSearchResponse } = moduleWithFakeClient()
    return {
      mod,
      breakClient() {
        ;(mod as any).createClient = () => ({
          setSettings: async () => {
            throw new Error('boom')
          }
        })
      },
      setHits(hits, reportedTotal) {
        setSearchResponse({
          hits: hits.map((hit) => ({
            objectID: hit.id,
            path: hit.path,
            locale: hit.locale ?? 'en',
            title: hit.title ?? hit.path,
            tags: hit.tags ?? [],
            updatedAt: 'x',
            ...(hit.classification === undefined ? {} : { classification: hit.classification })
          })),
          nbHits: reportedTotal ?? hits.length
        })
      },
      windows: () =>
        calls.searchSingleIndex!.map(({ searchParams }: any) => ({
          offset: searchParams.offset,
          size: searchParams.length
        })),
      indexedIds: () => calls.saveObject!.map((call: any) => call.body.objectID),
      lastIndexedPath: () => calls.saveObject!.at(-1)?.body.path,
      removedIds: () => calls.deleteObject!.map((call: any) => call.objectID),
      setPages(pages) {
        ;(globalThis as any).CARDINAL.db = stubPageStreamDb(pages)
      },
      rebuiltIds: () =>
        calls.batch!.flatMap((call: any) =>
          call.batchWriteParams.requests.map((request: any) => request.body.objectID)
        ),
      uploadCalls: () => calls.batch!.length
    }
  }
})
