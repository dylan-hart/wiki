import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTemporal } from '../../../test/temporal.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeIndexablePage, stubPageStreamDb } from '../../../test/builders.ts'
import { runSearchModuleContract } from '../../../test/searchModuleContract.ts'
import { search } from '../../../models/search.ts'
import {
  ElasticsearchSearchModule,
  batchOperations,
  buildEsQuery,
  getTlsOptions,
  toSniffIntervalMs
} from './search.ts'
import { buildSearchDocument, MAX_INDEXING_COUNT, type SearchDocument } from '../shared.ts'
import type { SearchPagesParams } from '../../../models/search.ts'

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** The engine config both this file's own suite and the shared contract run against. */
const ES_CONFIG = { hosts: 'http://localhost:9200', indexName: 'wiki-test', analyzer: 'standard' }

before(() => ensureTemporal())

/** The 28-field superset lives in `test/builders.ts` — see `makeIndexablePage`'s own doc. */
const fakePage = makeIndexablePage

/** A fake Elasticsearch client: every method a test needs, recording every call it received. */
function fakeElasticsearchClient() {
  const calls: Record<string, any[]> = {
    indicesExists: [],
    indicesCreate: [],
    index: [],
    delete: [],
    search: [],
    deleteByQuery: [],
    bulk: []
  }
  let indexExists = true
  let searchResponse: any = { hits: { hits: [], total: { value: 0 } } }
  const client: any = {
    indices: {
      exists: mock.fn(async (args: any) => {
        calls.indicesExists!.push(args)
        return indexExists
      }),
      create: mock.fn(async (args: any) => {
        calls.indicesCreate!.push(args)
        return {}
      })
    },
    index: mock.fn(async (args: any) => {
      calls.index!.push(args)
      return {}
    }),
    delete: mock.fn(async (args: any) => {
      calls.delete!.push(args)
      return {}
    }),
    search: mock.fn(async (args: any) => {
      calls.search!.push(args)
      return searchResponse
    }),
    deleteByQuery: mock.fn(async (args: any) => {
      calls.deleteByQuery!.push(args)
      return {}
    }),
    bulk: mock.fn(async (args: any) => {
      calls.bulk!.push(args)
      return {}
    })
  }
  return {
    client,
    calls,
    setIndexExists: (value: boolean) => {
      indexExists = value
    },
    setSearchResponse: (response: any) => {
      searchResponse = response
    }
  }
}

/** A module instance wired to a fake client, bypassing any real Elasticsearch network call. */
function moduleWithFakeClient() {
  const mod = new ElasticsearchSearchModule()
  const fake = fakeElasticsearchClient()
  ;(mod as any).createClient = () => fake.client
  return { mod, ...fake }
}

/**
 * OpenProject #830 (upstream #865, open): the v2 line's Elasticsearch module used to pin its API
 * version to 6.6, an Elasticsearch major that reached end of life in 2019. Task #552 (see
 * `docs/variances.md`) already dropped the whole `apiVersion` selector in favor of targeting a single,
 * current `@elastic/elasticsearch` major -- this pins that as a regression test, so a future dependency
 * bump that drags the pin back down to an old major fails a test instead of silently shipping.
 * `dev/docker-compose.search-test.yml` keeps the smoke-tested server image in step with this same
 * major.
 */
describe('@elastic/elasticsearch client version (OpenProject #830 / upstream #865)', () => {
  test('the pinned client major is current, not the long-EOL 6.x line 2.5.x shipped', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(backendDir, 'package.json'), 'utf8'))
    const pinned = pkg.dependencies['@elastic/elasticsearch'] as string
    const major = Number.parseInt(pinned.replace(/^[^\d]*/, ''), 10)
    assert.ok(
      major >= 9,
      `@elastic/elasticsearch is pinned to "${pinned}" -- expected a current (>= 9.x) major, not the EOL line this module used to target.`
    )
  })
})

describe('getTlsOptions()', () => {
  test('with no tlsCertPath, only carries rejectUnauthorized', () => {
    assert.deepEqual(getTlsOptions({ verifyTLSCertificate: true, tlsCertPath: '' }), {
      rejectUnauthorized: true
    })
    assert.deepEqual(getTlsOptions({ verifyTLSCertificate: false, tlsCertPath: '' }), {
      rejectUnauthorized: false
    })
  })

  test('with a tlsCertPath and verification on, reads the certificate as the CA', () => {
    const certPath = path.join(os.tmpdir(), `wiki-es-test-cert-${process.pid}.pem`)
    fs.writeFileSync(certPath, 'fake-cert-contents')
    try {
      const options = getTlsOptions({ verifyTLSCertificate: true, tlsCertPath: certPath })
      assert.equal(options.rejectUnauthorized, true)
      assert.equal(Array.isArray(options.ca), true)
      assert.equal((options.ca as Buffer[]).length, 1)
      assert.equal((options.ca as Buffer[])[0]!.toString(), 'fake-cert-contents')
    } finally {
      fs.unlinkSync(certPath)
    }
  })

  test('with a tlsCertPath but verification off, never reads the file -- faithful 2.5.x port', () => {
    const options = getTlsOptions({
      verifyTLSCertificate: false,
      tlsCertPath: path.join(os.tmpdir(), 'does-not-exist-and-is-never-read.pem')
    })
    assert.deepEqual(options, { rejectUnauthorized: false, ca: [] })
  })
})

/**
 * OpenProject #923: `definition.yml` documents `sniffInterval` as seconds ("Interval in seconds to
 * check for an updated list of nodes..."), but `@elastic/elasticsearch`'s own client option is
 * milliseconds -- a value entered as "300 seconds" was passed straight through and made the client
 * sniff cluster topology every 300ms, a 1000x more aggressive poll than configured.
 */
describe('toSniffIntervalMs()', () => {
  test('multiplies a positive value by 1000 to convert seconds to milliseconds', () => {
    assert.equal(toSniffIntervalMs(300), 300_000)
    assert.equal(toSniffIntervalMs(1), 1000)
  })

  test('0 disables sniffing, matching definition.yml’s own "0 disables it"', () => {
    assert.equal(toSniffIntervalMs(0), false)
  })

  test('a negative value also disables sniffing rather than producing a negative interval', () => {
    assert.equal(toSniffIntervalMs(-5), false)
  })

  test('a non-number (unset config) disables sniffing rather than throwing', () => {
    assert.equal(toSniffIntervalMs(undefined), false)
    assert.equal(toSniffIntervalMs(null), false)
  })
})

// -> What this module indexes is `shared.ts`'s `buildSearchDocument` unchanged (it needs none of the
//    extra fields Algolia's own record carries), so the field-by-field coverage that used to sit here
//    lives in `modules/search/shared.test.ts` rather than being repeated per engine.

describe('buildEsQuery()', () => {
  function params(overrides: Partial<SearchPagesParams> = {}): SearchPagesParams {
    return { siteId: 'site-1', ...overrides }
  }

  test('always scopes to the site and requires isSearchable, and excludes drafts by default', () => {
    const q = buildEsQuery(params())
    assert.deepEqual(q.bool.filter[0], { term: { siteId: 'site-1' } })
    assert.deepEqual(q.bool.filter[1], { term: { isSearchable: true } })
    assert.deepEqual(q.bool.filter[2], {
      bool: { must_not: [{ term: { publishState: 'draft' } }] }
    })
  })

  test('with no query text, must is match_all rather than an empty simple_query_string', () => {
    const q = buildEsQuery(params())
    assert.deepEqual(q.bool.must, [{ match_all: {} }])
  })

  test('with query text, must is a simple_query_string over the boosted fields', () => {
    const q = buildEsQuery(params({ query: 'kangaroo' }))
    assert.deepEqual(q.bool.must, [
      {
        simple_query_string: {
          query: 'kangaroo',
          fields: ['title^10', 'description^3', 'tags^8', 'content'],
          default_operator: 'and'
        }
      }
    ])
  })

  test('publicOnly restricts to published, taking precedence over the includeDrafts branch', () => {
    const q = buildEsQuery(params({ publicOnly: true, includeDrafts: true }))
    assert.deepEqual(q.bool.filter, [
      { term: { siteId: 'site-1' } },
      { term: { isSearchable: true } },
      { term: { publishState: 'published' } }
    ])
  })

  test('includeDrafts drops the draft exclusion entirely', () => {
    const q = buildEsQuery(params({ includeDrafts: true }))
    assert.deepEqual(q.bool.filter, [
      { term: { siteId: 'site-1' } },
      { term: { isSearchable: true } }
    ])
  })

  test('an explicit publishState filters in addition to, not instead of, the draft exclusion', () => {
    const q = buildEsQuery(params({ publishState: 'published' }))
    assert.ok(
      q.bool.filter.some((f: any) => f.term?.publishState === 'published'),
      'missing explicit publishState filter'
    )
    assert.ok(
      q.bool.filter.some((f: any) => f.bool?.must_not?.[0]?.term?.publishState === 'draft'),
      'missing the always-on draft exclusion'
    )
  })

  test('path becomes a match_phrase_prefix filter', () => {
    const q = buildEsQuery(params({ path: 'docs/guide' }))
    assert.ok(
      q.bool.filter.some((f: any) => f.match_phrase_prefix?.path === 'docs/guide'),
      'missing path prefix filter'
    )
  })

  test('locales become a terms filter', () => {
    const q = buildEsQuery(params({ locales: ['en', 'fr'] }))
    assert.ok(
      q.bool.filter.some((f: any) => Array.isArray(f.terms?.locale) && f.terms.locale.length === 2),
      'missing locales terms filter'
    )
  })

  test('every named tag becomes its own ANDed match clause', () => {
    const q = buildEsQuery(params({ tags: ['guide', 'howto'] }))
    const tagFilters = q.bool.filter.filter((f: any) => f.match?.tags)
    assert.deepEqual(
      tagFilters.map((f: any) => f.match.tags),
      ['guide', 'howto']
    )
  })

  test('editor becomes a term filter', () => {
    const q = buildEsQuery(params({ editor: 'markdown' }))
    assert.ok(q.bool.filter.some((f: any) => f.term?.editor === 'markdown'))
  })
})

describe('batchOperations()', () => {
  function op(id: string): { id: string; document: SearchDocument } {
    return { id, document: buildSearchDocument(fakePage({ id })) }
  }

  test('a handful of small operations stays in a single batch', () => {
    const batches = batchOperations([op('a'), op('b'), op('c')])
    assert.equal(batches.length, 1)
    assert.equal(batches[0]!.length, 3)
  })

  test('splits once the count limit is reached', () => {
    const ops = Array.from({ length: MAX_INDEXING_COUNT + 1 }, (_, i) => op(`p${i}`))
    const batches = batchOperations(ops)
    assert.equal(batches.length, 2)
    assert.equal(batches[0]!.length, MAX_INDEXING_COUNT)
    assert.equal(batches[1]!.length, 1)
  })

  test('an empty list yields no batches', () => {
    assert.deepEqual(batchOperations([]), [])
  })
})

/**
 * The `ElasticsearchSearchModule` class itself, exercised against a fake Elasticsearch client
 * (`createClient` overridden per instance) rather than a live cluster -- see
 * `moduleWithFakeClient()`. `search`'s real `definitions` are loaded from the actual `definition.yml`
 * files on disk so `getEngineConfig()` resolves this module's config defaults exactly the way the
 * running app would.
 */
describe('ElasticsearchSearchModule', () => {
  const siteId = 'site-1'
  let wikiHandle: { restore(): void }

  before(async () => {
    wikiHandle = installTestWiki({
      SERVERPATH: backendDir,
      sites: {
        [siteId]: {
          config: {
            search: {
              engine: 'elasticsearch',
              engines: { elasticsearch: ES_CONFIG }
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

  test("init() creates the index with this module's mapping when it does not exist yet", async () => {
    const { mod, calls, setIndexExists } = moduleWithFakeClient()
    setIndexExists(false)
    await mod.init(siteId, ES_CONFIG)

    assert.equal(calls.indicesCreate!.length, 1)
    const [{ index, mappings }] = calls.indicesCreate!
    assert.equal(index, 'wiki-test')
    assert.ok(mappings.properties.title)
    assert.deepEqual(mappings.properties.locale, { type: 'keyword' })
    assert.deepEqual(mappings.properties.editor, { type: 'keyword' })
    assert.deepEqual(mappings.properties.publishState, { type: 'keyword' })
    assert.deepEqual(mappings.properties.path, { type: 'text' })
  })

  test('an index name and analyzer the operator CLEARED fall back to their declared defaults', async () => {
    // -> `getEngineConfig`'s merge only substitutes a declared default for `undefined`, and an
    //    emptied text field is stored as `''` — so the module completes empty strings itself
    //    (`shared.ts#fillEmptyStringDefaults`). This is what the per-engine `|| 'wiki'` /
    //    `|| 'standard'` used to cover; without it the cluster would be asked for an index named `''`
    //    analyzed by `''`.
    const { mod, calls, setIndexExists } = moduleWithFakeClient()
    setIndexExists(false)
    await mod.init(siteId, { hosts: 'http://localhost:9200', indexName: '', analyzer: '' })

    assert.equal(calls.indicesCreate!.length, 1)
    assert.equal(calls.indicesCreate![0].index, 'wiki')
    assert.equal(calls.indicesCreate![0].settings.analysis.analyzer.default.type, 'standard')
  })

  test('init() does not recreate an index that already exists', async () => {
    const { mod, calls, setIndexExists } = moduleWithFakeClient()
    setIndexExists(true)
    await mod.init(siteId, { hosts: 'http://localhost:9200', indexName: 'wiki-test' })

    assert.equal(calls.indicesCreate!.length, 0)
  })

  describe('rebuild()', () => {
    let previousDb: any

    before(() => {
      previousDb = (globalThis as any).WIKI.db
    })

    after(() => {
      ;(globalThis as any).WIKI.db = previousDb
    })

    /**
     * The batching and per-locale tally are `test/searchModuleContract.ts`'s to assert, once for
     * every engine. What is Elasticsearch's alone: the purge is a `deleteByQuery` on a `term` over
     * this site, the bulk body interleaves one index-meta entry per document (6 entries for 3
     * pages), and each locale entry reports `dictionary: 'n/a'` — the analyzer is index-wide here,
     * not per locale.
     */
    test("deletes only this site's documents, and bulk-sends meta/document pairs", async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).WIKI.db = stubPageStreamDb([
        fakePage({ id: 'p1', locale: 'en' }),
        fakePage({ id: 'p2', locale: 'en' }),
        fakePage({ id: 'p3', locale: 'fr' })
      ])

      const result = await mod.rebuild(siteId)

      assert.equal(calls.deleteByQuery!.length, 1)
      assert.deepEqual(calls.deleteByQuery![0].query, { term: { siteId } })
      assert.equal(calls.bulk![0].operations.length, 6)
      assert.deepEqual(
        result.locales.sort((a: any, b: any) => a.locale.localeCompare(b.locale)),
        [
          { locale: 'en', dictionary: 'n/a', pages: 2 },
          { locale: 'fr', dictionary: 'n/a', pages: 1 }
        ]
      )
    })

    /** That an empty site sends no batches is the contract's; that it still purges is this engine's. */
    test('an empty site still deletes its documents', async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).WIKI.db = stubPageStreamDb([])

      const result = await mod.rebuild(siteId)

      assert.equal(calls.deleteByQuery!.length, 1)
      assert.deepEqual(result.locales, [])
    })

    /**
     * OpenProject #830 (discussion #5235, ES reindex connection pool exhaustion): a rebuild that read
     * every page of a large site into memory up front (or prefetched the next page of rows while an
     * earlier batch's `client.bulk` call was still in flight) would hold postgres connections open for
     * the whole, potentially slow, duration of talking to Elasticsearch -- exactly the failure mode
     * this fork's Azure/AWS CloudSearch `rebuild()` implementations were already built to avoid (see
     * their own `pageBatch`/`uploadBatch` doc comments). This module's keyset-paginated loop reads one
     * `PAGE_SIZE` page, awaits its `client.bulk` call to finish, and only then reads the next page --
     * this pins that ordering: the second `select` must not start until the first `bulk` has settled,
     * across a large enough page count (501 rows, two iterations of `PAGE_SIZE=500`) to actually
     * exercise the loop boundary.
     */
    test('streams sequentially: never reads the next page of rows while a batch upload is still in flight', async () => {
      const { mod, client } = moduleWithFakeClient()
      const events: string[] = []

      const originalBulk = client.bulk
      client.bulk = async (args: any) => {
        events.push('bulk-start')
        // -> A real network round-trip is asynchronous; this makes an overlapping `select` detectable
        //    instead of the mock's synchronous resolution hiding it.
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push('bulk-end')
        return originalBulk(args)
      }

      const firstPage = Array.from({ length: 500 }, (_, i) =>
        fakePage({ id: `p${String(i).padStart(4, '0')}`, locale: 'en' })
      )
      const secondPage = [fakePage({ id: 'p0500', locale: 'en' })]
      let selectCall = 0
      ;(globalThis as any).WIKI.db = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => {
                  selectCall++
                  events.push(`select-${selectCall}`)
                  if (selectCall === 1) return firstPage
                  if (selectCall === 2) return secondPage
                  return []
                }
              })
            })
          })
        })
      }

      const result = await mod.rebuild(siteId)

      assert.equal(result.pages, 501)
      assert.deepEqual(events, [
        'select-1',
        'bulk-start',
        'bulk-end',
        'select-2',
        'bulk-start',
        'bulk-end'
      ])
    })
  })
})

/**
 * The thirteen claims every external engine owes `models/search.ts`, translated into Elasticsearch's
 * own request and response shapes — see `test/searchModuleContract.ts` for what they are and why they
 * live in one place. Everything above this line is Elasticsearch's alone.
 */
runSearchModuleContract('elasticsearch', {
  config: ES_CONFIG,
  siteConfig: { search: { engine: 'elasticsearch', engines: { elasticsearch: ES_CONFIG } } },
  makeModule: () => {
    const { mod, calls, setSearchResponse } = moduleWithFakeClient()
    return {
      mod,
      breakClient() {
        ;(mod as any).createClient = () => ({
          indices: {
            exists: async () => {
              throw new Error('boom')
            }
          }
        })
      },
      setHits(hits, reportedTotal) {
        setSearchResponse({
          hits: {
            total: { value: reportedTotal ?? hits.length },
            hits: hits.map((hit, index) => ({
              _id: hit.id,
              _score: hits.length - index,
              _source: {
                path: hit.path,
                locale: hit.locale ?? 'en',
                title: hit.title ?? hit.path,
                description: '',
                tags: hit.tags ?? [],
                updatedAt: 'x',
                ...(hit.classification === undefined ? {} : { classification: hit.classification })
              }
            }))
          }
        })
      },
      windows: () => calls.search!.map(({ from, size }: any) => ({ offset: from, size })),
      indexedIds: () => calls.index!.map((call: any) => call.id),
      lastIndexedPath: () => calls.index!.at(-1)?.document.path,
      removedIds: () => calls.delete!.map((call: any) => call.id),
      setPages(pages) {
        ;(globalThis as any).WIKI.db = stubPageStreamDb(pages)
      },
      rebuiltIds: () =>
        calls.bulk!.flatMap((call: any) =>
          call.operations
            .filter((operation: any) => operation.index)
            .map((operation: any) => operation.index._id)
        ),
      uploadCalls: () => calls.bulk!.length
    }
  }
})
