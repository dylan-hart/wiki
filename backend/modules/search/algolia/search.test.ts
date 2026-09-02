import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTemporal } from '../../../test/temporal.ts'
import { installTestWiki } from '../../../test/mocks.ts'
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
import type { AccessActor } from '../../../models/groups.ts'
import type { SearchIndexablePage, SearchPagesParams } from '../../../models/search.ts'

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

before(() => ensureTemporal())

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
    classification: 'classification-1',
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

  /**
   * OpenProject #921: a `siteId` embedded with an unescaped quote could otherwise break out of its
   * filter clause the same way any other value could -- the site id itself is escaped no differently.
   */
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
    assert.equal(doc.objectID, 'page-1')
    assert.equal(doc.path, 'docs/getting-started')
    assert.deepEqual(doc.pathAncestors, ['docs', 'docs/getting-started'])
    assert.equal(doc.title, 'Getting Started')
    assert.deepEqual(doc.tags, ['guide'])
    assert.equal(doc.editor, 'markdown')
    assert.equal(doc.publishState, 'published')
    assert.equal(doc.isSearchable, true)
    assert.equal(doc.classification, 'classification-1')
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
    // -> With the actual reference constants, MAX_INDEXING_COUNT (1000) documents at just under
    //    MAX_DOCUMENT_BYTES (10240B) each total ~10.24MB, which is still under MAX_INDEXING_BYTES
    //    (~10.49MB) -- so the count cap always binds before the byte cap for realistically-sized
    //    documents, and a batch genuinely split by bytes alone cannot be constructed without a
    //    document that violates the per-object cap. This instead guards the byte accumulator itself:
    //    a good number of large-but-valid documents, comfortably under both limits, must not be
    //    split prematurely by an off-by-one in the running byte total.
    const big = 'x'.repeat(8000)
    const docs = Array.from({ length: 500 }, (_, i) => doc({ objectID: `p${i}`, description: big }))
    assert.deepEqual(batchDocuments(docs), { batches: [docs], skipped: [] })
  })

  /**
   * OpenProject #830 (upstream discussion #3675): a page whose document alone exceeds Algolia's
   * per-object size limit used to make `batchDocuments()` throw, which aborted `rebuild()` entirely --
   * losing every other, correctly-sized page in the same rebuild, not just the oversized one. It is
   * now diverted into `skipped` instead, so `rebuild()` can send everything else and just log a
   * warning for what it couldn't.
   */
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
 * The `AlgoliaSearchModule` class itself, exercised against a fake Algolia client (`createClient`
 * overridden per instance) rather than a live account -- see `moduleWithFakeClient()`. `search`'s real
 * `definitions` are loaded from the actual `definition.yml` files on disk so `getEngineConfig()`
 * resolves this module's `appId`/`apiKey`/`indexName` defaults exactly the way the running app would.
 *
 * Task #559: unlike `modules/search/elasticsearch/search.smoke.test.ts`'s companion suite, there is no
 * live-cluster equivalent for this module. Algolia is a hosted SaaS with no self-hostable server to
 * bring up in a `docker-compose.yml` the way Elasticsearch's own image can be -- a real run would mean
 * either committing a throwaway account's live API keys to CI (a secret-management problem no other
 * suite in this repo takes on) or silently skipping in every environment that lacks one, both worse
 * than what this file already does. So this is where Algolia's coverage stops rather than a gap
 * nobody noticed: `moduleWithFakeClient()`'s `calls` recorder is a genuine contract test against
 * `algoliasearch`'s actual method call shapes -- `setSettings`'s `indexName`/`indexSettings`
 * (`init()`, above), `saveObject`'s `indexName`/`body` (`created`/`updated`/`renamed`), `deleteObject`'s
 * `indexName`/`objectID` (`deleted()`), and `searchSingleIndex`'s `searchParams.filters` string built by
 * `buildFilters()` (`query()`) -- asserted against the same request shapes the real SDK method
 * signatures expect, just never sent over the wire.
 */
describe('AlgoliaSearchModule', () => {
  const siteId = 'site-1'
  let wikiHandle: { restore(): void }

  before(async () => {
    wikiHandle = installTestWiki({
      SERVERPATH: backendDir,
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
    })
    await search.refreshFromDisk()
  })

  after(() => {
    wikiHandle.restore()
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
      'pathAncestors',
      'siteId'
    ]) {
      assert.ok(indexSettings.attributesForFaceting.includes(facet), `missing facet: ${facet}`)
    }
  })

  test('an index name the operator CLEARED still targets "wiki", not an unnamed index', async () => {
    // -> `getEngineConfig`'s merge only substitutes a declared default for `undefined`, and an
    //    emptied text field is stored as `''` — so the module completes empty strings itself
    //    (`shared.ts#fillEmptyStringDefaults`). This is what the per-engine `|| 'wiki'` used to cover.
    const { mod, calls } = moduleWithFakeClient()
    await mod.init(siteId, { appId: 'app123', apiKey: 'key456', indexName: '' })

    assert.equal(calls.setSettings![0].indexName, 'wiki')
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

  /**
   * OpenProject #2156: `offset`/`limit` are no longer sent straight through as Algolia's own
   * `offset`/`length` -- page-rule filtering happens after the query, so the module now always
   * scans a bounded window from the start and applies the caller's own pagination in JS, over the
   * filtered set. See `query()`'s own comment for the full reasoning.
   */
  test('query() always scans from the start with a bounded length, regardless of the caller’s own offset/limit', async () => {
    const { mod, calls } = moduleWithFakeClient()
    await mod.query({ siteId, query: 'kangaroo', tags: ['guide'], offset: 10, limit: 5 })

    assert.equal(calls.searchSingleIndex!.length, 1)
    const [{ indexName, searchParams }] = calls.searchSingleIndex!
    assert.equal(indexName, 'wiki-test')
    assert.equal(searchParams.query, 'kangaroo')
    assert.equal(searchParams.offset, 0)
    assert.ok(
      searchParams.length > 5,
      'expected a bounded scan window larger than the requested page size'
    )
    assert.match(searchParams.filters, /isSearchable:true/)
    assert.match(searchParams.filters, /tags:"guide"/)
  })

  test('query() applies the caller’s offset/limit in JS, over the filtered (visible) set', async () => {
    const { mod, calls, setSearchResponse } = moduleWithFakeClient()
    setSearchResponse({
      hits: [
        { objectID: 'p1', path: 'a', locale: 'en', title: 'A', tags: [], updatedAt: 'x' },
        { objectID: 'p2', path: 'b', locale: 'en', title: 'B', tags: [], updatedAt: 'x' },
        { objectID: 'p3', path: 'c', locale: 'en', title: 'C', tags: [], updatedAt: 'x' }
      ],
      nbHits: 3
    })

    const result = await mod.query({ siteId, query: 'x', offset: 1, limit: 1 })
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0]!.path, 'b')
    assert.equal(result.totalHits, 3)
    assert.equal(calls.searchSingleIndex!.length, 1)
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
      // -> totalHits is derived from the whole filtered scan window, never Algolia's own nbHits
      assert.equal(result.totalHits, 1)
    } finally {
      ;(globalThis as any).WIKI.models.groups.checkAccess = previousCheckAccess
    }
    assert.equal(calls.searchSingleIndex!.length, 1)
  })

  test('totalHits never reflects nbHits when it exceeds what this page can vouch for', async () => {
    const { mod, setSearchResponse } = moduleWithFakeClient()
    setSearchResponse({
      hits: [
        { objectID: 'p1', path: 'open-1', locale: 'en', title: 'Open 1', tags: [], updatedAt: 'x' },
        {
          objectID: 'p2',
          path: 'secret-1',
          locale: 'en',
          title: 'Secret 1',
          tags: [],
          updatedAt: 'x'
        },
        { objectID: 'p3', path: 'open-2', locale: 'en', title: 'Open 2', tags: [], updatedAt: 'x' }
      ],
      // -> Algolia reports 100 total matches across many pages this call never fetched -- the old
      //    arithmetic (nbHits - hits.length + visible.length) would have leaked most of that into
      //    totalHits even though only this one page was ever checked against checkAccess.
      nbHits: 100
    })
    const denySecret = (_actor: AccessActor, _permission: string, page: { path: string }) =>
      !page.path.startsWith('secret')
    const previousCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
    ;(globalThis as any).WIKI.models.groups.checkAccess = denySecret

    try {
      const result = await mod.query({
        siteId,
        query: 'x',
        offset: 0,
        actor: { groupIds: [], permissions: [] }
      })
      assert.equal(result.results.length, 2)
      // -> Exactly the readable count within the scanned window (2 visible), never Algolia's 100
      assert.equal(result.totalHits, 2)
    } finally {
      ;(globalThis as any).WIKI.models.groups.checkAccess = previousCheckAccess
    }
  })

  test('query() passes each hit’s own indexed classification to checkAccess, not a hardcoded null (OpenProject #1125)', async () => {
    const { mod, setSearchResponse } = moduleWithFakeClient()
    setSearchResponse({
      hits: [
        {
          objectID: 'p1',
          path: 'restricted',
          locale: 'en',
          title: 'Restricted',
          tags: [],
          classification: 'classification-restricted',
          updatedAt: 'x'
        }
      ],
      nbHits: 1
    })
    const seen: any[] = []
    const previousCheckAccess = (globalThis as any).WIKI.models.groups.checkAccess
    ;(globalThis as any).WIKI.models.groups.checkAccess = (
      _actor: AccessActor,
      _permission: string,
      page: any
    ) => {
      seen.push(page.classification)
      return true
    }

    try {
      await mod.query({ siteId, query: '', actor: { groupIds: [], permissions: [] } })
      assert.deepEqual(seen, ['classification-restricted'])
    } finally {
      ;(globalThis as any).WIKI.models.groups.checkAccess = previousCheckAccess
    }
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

    test('purges only this site’s records, then batches and sends every page found', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).WIKI.db = fakeDb({
        [siteId]: [
          fakePage({ id: 'p1', locale: 'en' }),
          fakePage({ id: 'p2', locale: 'en' }),
          fakePage({ id: 'p3', locale: 'fr' })
        ]
      })

      const result = await mod.rebuild(siteId)

      assert.equal(calls.deleteBy!.length, 1)
      assert.equal(calls.deleteBy![0].indexName, 'wiki-test')
      assert.equal(calls.deleteBy![0].deleteByParams.filters, `siteId:"${siteId}"`)
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

    /**
     * OpenProject #830 (upstream discussion #3675): a page whose Algolia document exceeds the
     * per-object size limit used to throw out of `batchDocuments()` uncaught, which aborted the whole
     * `rebuild()` -- so a single oversized page took every other page in the site down with it. It
     * must instead be skipped, with the rest of the site still indexed and a warning logged that says
     * which page and why.
     */
    test('an oversized page is skipped with a logged warning, the rest of the site still gets indexed', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).WIKI.db = fakeDb({
        [siteId]: [
          fakePage({ id: 'p1', path: 'docs/small-one', locale: 'en' }),
          fakePage({
            id: 'p-huge',
            path: 'docs/huge-page',
            locale: 'en',
            searchContent: 'x'.repeat(MAX_DOCUMENT_BYTES)
          }),
          fakePage({ id: 'p2', path: 'docs/small-two', locale: 'fr' })
        ]
      })
      const warnings: string[] = []
      const previousWarn = (globalThis as any).WIKI.logger.warn
      ;(globalThis as any).WIKI.logger.warn = (msg: string) => warnings.push(msg)

      let result
      try {
        result = await mod.rebuild(siteId)
      } finally {
        ;(globalThis as any).WIKI.logger.warn = previousWarn
      }

      // -> Both small pages made it into the one batch sent; the huge one did not abort anything.
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

      // -> Admin-visible: a warning names the skipped page, and the result itself records it too.
      assert.ok(warnings.some((w) => w.includes('docs/huge-page')))
      assert.equal(result.warnings?.length, 1)
      assert.ok(result.warnings![0]!.includes('docs/huge-page'))
    })

    test('an empty site still purges its own records and sends no batches', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).WIKI.db = fakeDb({ [siteId]: [] })

      const result = await mod.rebuild(siteId)

      assert.equal(calls.deleteBy!.length, 1)
      assert.equal(calls.batch!.length, 0)
      assert.equal(result.pages, 0)
      assert.deepEqual(result.locales, [])
    })

    /**
     * OpenProject #921: `rebuild()` used to `clearObjects` the whole index before re-adding only this
     * site's pages -- with two sites sharing an app/index (the shared `wiki` default), rebuilding site
     * A permanently deleted every one of site B's records. It must now purge only its own site's
     * records via `deleteBy`.
     */
    test('does not touch another site’s records: rebuild scopes its purge to siteId', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).WIKI.db = fakeDb({ [siteId]: [fakePage({ id: 'p1' })] })

      await mod.rebuild(siteId)

      assert.equal(calls.deleteBy!.length, 1)
      assert.doesNotMatch(calls.deleteBy![0].deleteByParams.filters, /site-2/)
      // -> No whole-index clear call exists on the fake client any more -- if `rebuild()` regressed
      //    back to `clearObjects`, this test would fail with a `TypeError` (no such method), not
      //    silently pass.
      assert.equal(typeof calls.clearObjects, 'undefined')
    })
  })
})
