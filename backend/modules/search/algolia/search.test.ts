import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { search } from '../../../models/search.ts'
import {
  AlgoliaSearchModule,
  MAX_DOCUMENT_BYTES,
  MAX_INDEXING_COUNT,
  batchDocuments,
  buildFilters,
  pageToDocument,
  pathAncestors,
  type AlgoliaPageDocument
} from './search.ts'
import type { AccessActor } from '../../../models/groups.ts'
import type { SearchIndexablePage, SearchPagesParams } from '../../../models/search.ts'

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function fakePage(overrides: Partial<Record<string, any>> = {}): SearchIndexablePage {
  return {
    id: 'page-1',
    siteId: 'site-1',
    locale: 'en',
    path: 'docs/getting-started',
    title: 'Getting Started',
    description: 'How to get started',
    icon: null,
    tags: ['guide'],
    editor: 'markdown',
    publishState: 'published',
    isSearchable: true,
    password: null,
    searchContent: 'Some page content about getting started.',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  } as unknown as SearchIndexablePage
}

/** A fake Algolia client: every method a test needs, recording every call it received. */
function fakeAlgoliaClient() {
  const calls: Record<string, any[]> = {
    setSettings: [],
    saveObject: [],
    deleteObject: [],
    searchSingleIndex: [],
    clearObjects: [],
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
    clearObjects: mock.fn(async (args: any) => {
      calls.clearObjects!.push(args)
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

/** A module instance wired to a fake client, bypassing any real Algolia network call. */
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

  test('always requires isSearchable, and excludes drafts by default', () => {
    assert.equal(buildFilters(params()), 'isSearchable:true AND NOT publishState:"draft"')
  })

  test('publicOnly restricts to published, taking precedence over the includeDrafts branch', () => {
    assert.equal(
      buildFilters(params({ publicOnly: true })),
      'isSearchable:true AND publishState:"published"'
    )
  })

  test('includeDrafts drops the NOT-draft condition', () => {
    assert.equal(buildFilters(params({ includeDrafts: true })), 'isSearchable:true')
  })

  test('an explicit publishState ANDs onto the publicOnly/includeDrafts branch, not replaces it', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, publishState: 'published' })),
      'isSearchable:true AND publishState:"published"'
    )
  })

  test('path becomes a pathAncestors equality filter', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, path: 'docs/guide' })),
      'isSearchable:true AND pathAncestors:"docs/guide"'
    )
  })

  test('locales become an OR group', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, locales: ['en', 'fr'] })),
      'isSearchable:true AND (locale:"en" OR locale:"fr")'
    )
  })

  test("tags are ANDed, requiring every one present (mirrors the db module's @> containment)", () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, tags: ['a', 'b'] })),
      'isSearchable:true AND tags:"a" AND tags:"b"'
    )
  })

  test('editor becomes an equality filter', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, editor: 'markdown' })),
      'isSearchable:true AND editor:"markdown"'
    )
  })

  test('escapes a quote embedded in a filter value', () => {
    assert.equal(
      buildFilters(params({ includeDrafts: true, editor: 'weird"editor' })),
      'isSearchable:true AND editor:"weird\\"editor"'
    )
  })
})

describe('pageToDocument()', () => {
  test('carries the searchable/faceted fields, including pathAncestors', () => {
    const doc = pageToDocument(fakePage())
    assert.equal(doc.objectID, 'page-1')
    assert.equal(doc.path, 'docs/getting-started')
    assert.deepEqual(doc.pathAncestors, ['docs', 'docs/getting-started'])
    assert.equal(doc.title, 'Getting Started')
    assert.deepEqual(doc.tags, ['guide'])
    assert.equal(doc.editor, 'markdown')
    assert.equal(doc.publishState, 'published')
    assert.equal(doc.isSearchable, true)
    assert.equal(doc.content, 'Some page content about getting started.')
  })

  test('never sends content for a password-protected page', () => {
    const doc = pageToDocument(fakePage({ password: 'letmein' }))
    assert.equal('content' in doc, false)
    // -> Everything a reader sees without the password is still there
    assert.equal(doc.title, 'Getting Started')
    assert.equal(doc.description, 'How to get started')
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
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides
    }
  }

  test('a handful of small documents fit in a single batch', () => {
    const docs = [doc({ objectID: 'p1' }), doc({ objectID: 'p2' }), doc({ objectID: 'p3' })]
    assert.deepEqual(batchDocuments(docs), [docs])
  })

  test('an empty list produces no batches', () => {
    assert.deepEqual(batchDocuments([]), [])
  })

  test('splits once the object count reaches MAX_INDEXING_COUNT', () => {
    const docs = Array.from({ length: MAX_INDEXING_COUNT + 1 }, (_, i) =>
      doc({ objectID: `p${i}` })
    )
    const batches = batchDocuments(docs)
    assert.equal(batches.length, 2)
    assert.equal(batches[0]!.length, MAX_INDEXING_COUNT)
    assert.equal(batches[1]!.length, 1)
  })

  test('does not split early: near-max-size documents stay in one batch below both caps', () => {
    // -> With the actual reference constants, MAX_INDEXING_COUNT (1000) documents at just under
    //    MAX_DOCUMENT_BYTES (10240B) each total ~10.24MB, which is still under MAX_INDEXING_BYTES
    //    (~10.49MB) -- so the count cap always binds before the byte cap for realistically-sized
    //    documents, and a batch genuinely split by bytes alone cannot be constructed without a
    //    document that violates the per-object cap. This instead guards the byte accumulator itself:
    //    a good number of large-but-valid documents, comfortably under both limits, must not be
    //    split prematurely by an off-by-one in the running byte total.
    const big = 'x'.repeat(8000)
    const docs = Array.from({ length: 500 }, (_, i) => doc({ objectID: `p${i}`, description: big }))
    assert.deepEqual(batchDocuments(docs), [docs])
  })

  test('throws for a single document that alone exceeds MAX_DOCUMENT_BYTES', () => {
    const huge = doc({ objectID: 'p-huge', description: 'x'.repeat(MAX_DOCUMENT_BYTES) })
    assert.throws(() => batchDocuments([huge]), /exceeds the maximum object size/)
  })
})

/**
 * The `AlgoliaSearchModule` class itself, exercised against a fake Algolia client (`createClient`
 * overridden per instance) rather than a live account -- see `moduleWithFakeClient()`. `search`'s real
 * `definitions` are loaded from the actual `definition.yml` files on disk so `getEngineConfig()`
 * resolves this module's `appId`/`apiKey`/`indexName` defaults exactly the way the running app would.
 */
describe('AlgoliaSearchModule', () => {
  const siteId = 'site-1'
  let previousWiki: any

  before(async () => {
    previousWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      SERVERPATH: backendDir,
      logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
      sites: {
        [siteId]: {
          config: {
            search: {
              engine: 'algolia',
              engines: { algolia: { appId: 'app123', apiKey: 'key456', indexName: 'wiki-test' } }
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
    await search.refreshFromDisk()
  })

  after(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  test('init() pushes searchableAttributes and the facet attributes to Algolia', async () => {
    const { mod, calls } = moduleWithFakeClient()
    await mod.init(siteId, { appId: 'app123', apiKey: 'key456', indexName: 'wiki-test' })

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
      'pathAncestors'
    ]) {
      assert.ok(indexSettings.attributesForFaceting.includes(facet), `missing facet: ${facet}`)
    }
  })

  test('created() saves the page as an Algolia object', async () => {
    const { mod, calls } = moduleWithFakeClient()
    await mod.created(fakePage())

    assert.equal(calls.saveObject!.length, 1)
    const [{ indexName, body }] = calls.saveObject!
    assert.equal(indexName, 'wiki-test')
    assert.equal(body.objectID, 'page-1')
    assert.equal(body.title, 'Getting Started')
  })

  test('updated() also saves via saveObject, keeping the object fully in sync', async () => {
    const { mod, calls } = moduleWithFakeClient()
    await mod.updated(fakePage({ title: 'Renamed Title' }))

    assert.equal(calls.saveObject!.length, 1)
    assert.equal(calls.saveObject![0].body.title, 'Renamed Title')
  })

  test('deleted() removes the object by id', async () => {
    const { mod, calls } = moduleWithFakeClient()
    await mod.deleted(siteId, 'page-1')

    assert.equal(calls.deleteObject!.length, 1)
    assert.deepEqual(calls.deleteObject![0], { indexName: 'wiki-test', objectID: 'page-1' })
  })

  test('renamed() updates the same object in place rather than delete+add', async () => {
    const { mod, calls } = moduleWithFakeClient()
    await mod.renamed(siteId, fakePage({ path: 'docs/new-path' }), 'docs/old-path')

    assert.equal(calls.deleteObject!.length, 0)
    assert.equal(calls.saveObject!.length, 1)
    assert.equal(calls.saveObject![0].body.path, 'docs/new-path')
    assert.equal(calls.saveObject![0].body.objectID, 'page-1')
  })

  test('created() never throws when Algolia fails -- a page save must not fail because of it', async () => {
    const { mod } = moduleWithFakeClient()
    ;(mod as any).createClient = () => ({
      setSettings: async () => {
        throw new Error('boom')
      }
    })
    await assert.doesNotReject(mod.created(fakePage()))
  })

  test('query() sends the free-text query plus the translated filters', async () => {
    const { mod, calls } = moduleWithFakeClient()
    await mod.query({ siteId, query: 'kangaroo', tags: ['guide'], offset: 10, limit: 5 })

    assert.equal(calls.searchSingleIndex!.length, 1)
    const [{ indexName, searchParams }] = calls.searchSingleIndex!
    assert.equal(indexName, 'wiki-test')
    assert.equal(searchParams.query, 'kangaroo')
    assert.equal(searchParams.offset, 10)
    assert.equal(searchParams.length, 5)
    assert.match(searchParams.filters, /isSearchable:true/)
    assert.match(searchParams.filters, /tags:"guide"/)
  })

  test('query() applies actor-based checkAccess filtering to the hits Algolia returned', async () => {
    const { mod, calls, setSearchResponse } = moduleWithFakeClient()
    setSearchResponse({
      hits: [
        { objectID: 'p1', path: 'open', locale: 'en', title: 'Open', tags: [], updatedAt: 'x' },
        { objectID: 'p2', path: 'secret', locale: 'en', title: 'Secret', tags: [], updatedAt: 'x' }
      ],
      nbHits: 2
    })
    const denyForSecret = (_actor: AccessActor, _permission: string, page: { path: string }) =>
      page.path !== 'secret'
    const previousCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
    ;(globalThis as any).WIKI.models.groups.checkAccess = denyForSecret

    try {
      const result = await mod.query({
        siteId,
        query: '',
        actor: { groupIds: [], permissions: [] }
      })
      assert.equal(result.results.length, 1)
      assert.equal(result.results[0]!.path, 'open')
      // -> totalHits is nbHits adjusted by what checkAccess removed from this page, not the raw count
      assert.equal(result.totalHits, 1)
    } finally {
      ;(globalThis as any).WIKI.models.groups.checkAccess = previousCheckAccess
    }
    assert.equal(calls.searchSingleIndex!.length, 1)
  })

  test('query() with no actor returns every hit unfiltered', async () => {
    const { mod, setSearchResponse } = moduleWithFakeClient()
    setSearchResponse({
      hits: [{ objectID: 'p1', path: 'a', locale: 'en', title: 'A', tags: [], updatedAt: 'x' }],
      nbHits: 1
    })
    const result = await mod.query({ siteId, query: '' })
    assert.equal(result.results.length, 1)
  })

  describe('rebuild()', () => {
    let previousDb: any

    before(() => {
      previousDb = (globalThis as any).WIKI.db
    })

    after(() => {
      ;(globalThis as any).WIKI.db = previousDb
    })

    /** A fake `WIKI.db` serving one page of rows, then an empty page, matching the keyset-loop shape. */
    function fakeDb(rowsBySiteId: Record<string, any[]>) {
      return {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => {
                  const rows = rowsBySiteId[siteId] ?? []
                  rowsBySiteId[siteId] = []
                  return rows
                }
              })
            })
          })
        })
      }
    }

    test('clears the index, then batches and sends every page found', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).WIKI.db = fakeDb({
        [siteId]: [
          fakePage({ id: 'p1', locale: 'en' }),
          fakePage({ id: 'p2', locale: 'en' }),
          fakePage({ id: 'p3', locale: 'fr' })
        ]
      })

      const result = await mod.rebuild(siteId)

      assert.equal(calls.clearObjects!.length, 1)
      assert.equal(calls.batch!.length, 1)
      assert.equal(calls.batch![0].batchWriteParams.requests.length, 3)
      assert.equal(calls.batch![0].batchWriteParams.requests[0].action, 'addObject')
      assert.equal(result.pages, 3)
      assert.deepEqual(
        result.locales.sort((a: any, b: any) => a.locale.localeCompare(b.locale)),
        [
          { locale: 'en', dictionary: 'n/a', pages: 2 },
          { locale: 'fr', dictionary: 'n/a', pages: 1 }
        ]
      )
    })

    test('an empty site clears the index and sends no batches', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).WIKI.db = fakeDb({ [siteId]: [] })

      const result = await mod.rebuild(siteId)

      assert.equal(calls.clearObjects!.length, 1)
      assert.equal(calls.batch!.length, 0)
      assert.equal(result.pages, 0)
      assert.deepEqual(result.locales, [])
    })
  })
})
