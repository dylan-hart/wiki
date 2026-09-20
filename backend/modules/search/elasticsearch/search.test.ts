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

const ES_CONFIG = { hosts: 'http://localhost:9200', indexName: 'wiki-test', analyzer: 'standard' }

before(() => ensureTemporal())

const fakePage = makeIndexablePage

function fakeElasticsearchClient() {
  const calls: Record<string, any[]> = {
    indicesExists: [],
    indicesCreate: [],
    indicesPutMapping: [],
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
      }),
      putMapping: mock.fn(async (args: any) => {
        calls.indicesPutMapping!.push(args)
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

function moduleWithFakeClient() {
  const mod = new ElasticsearchSearchModule()
  const fake = fakeElasticsearchClient()
  ;(mod as any).createClient = () => fake.client
  return { mod, ...fake }
}

/**
 * Guards against a dependency bump dragging the client pin back down to an EOL major.
 * `dev/docker-compose.search-test.yml` keeps the smoke-tested server image on the same major.
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
 * `definition.yml` documents `sniffInterval` in seconds, but `@elastic/elasticsearch`'s own client
 * option is milliseconds -- passed straight through, "300 seconds" sniffs every 300ms.
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

// -> This module indexes `shared.ts`'s `buildSearchDocument` unchanged, so the field-by-field
//    coverage lives in `modules/search/shared.test.ts` rather than being repeated per engine.

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
    const q = buildEsQuery(params({ publishState: ['published'] }))
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
    const q = buildEsQuery(params({ path: ['docs/guide'] }))
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

  test('tagsMatch any wraps the tags in a should group needing one match', () => {
    const q = buildEsQuery(params({ tags: ['guide', 'howto'], tagsMatch: 'any' }))
    assert.deepEqual(
      q.bool.filter.filter((f: any) => f.bool?.should),
      [
        {
          bool: {
            should: [{ match: { tags: 'guide' } }, { match: { tags: 'howto' } }],
            minimum_should_match: 1
          }
        }
      ]
    )
    assert.equal(q.bool.filter.filter((f: any) => f.match?.tags).length, 0)
  })

  test('editor becomes a term filter', () => {
    const q = buildEsQuery(params({ editor: ['markdown'] }))
    assert.ok(q.bool.filter.some((f: any) => f.term?.editor === 'markdown'))
  })

  test('several include values become any-of clauses', () => {
    const q = buildEsQuery(
      params({
        path: ['docs', 'guides'],
        editor: ['markdown', 'code'],
        publishState: ['published', 'scheduled']
      })
    )
    assert.ok(
      q.bool.filter.some(
        (f: any) =>
          f.bool?.minimum_should_match === 1 &&
          f.bool.should.length === 2 &&
          f.bool.should[0].match_phrase_prefix.path === 'docs'
      ),
      'missing any-of path prefixes'
    )
    assert.ok(q.bool.filter.some((f: any) => f.terms?.editor?.length === 2))
    assert.ok(q.bool.filter.some((f: any) => f.terms?.publishState?.length === 2))
  })

  test('no exclusion leaves the query without a must_not clause', () => {
    assert.equal('must_not' in buildEsQuery(params()).bool, false)
  })

  test('every exclude list becomes a native must_not clause, never a post-filter', () => {
    const q = buildEsQuery(
      params({
        excludePath: ['docs/private', 'drafts'],
        excludeLocales: ['fr', 'de'],
        excludeTags: ['old', 'stale'],
        excludeEditor: ['code'],
        excludePublishState: ['scheduled']
      })
    )
    assert.deepEqual(q.bool.must_not, [
      { terms: { publishState: ['scheduled'] } },
      { match_phrase_prefix: { path: 'docs/private' } },
      { match_phrase_prefix: { path: 'drafts' } },
      { terms: { locale: ['fr', 'de'] } },
      { match: { tags: 'old' } },
      { match: { tags: 'stale' } },
      { terms: { editor: ['code'] } }
    ])
  })

  test('creator and author lists are native term filters and must_not clauses', () => {
    const q = buildEsQuery(
      params({
        creatorId: ['11111111-1111-4111-8111-111111111111'],
        authorId: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
        excludeCreatorId: ['22222222-2222-4222-8222-222222222222'],
        excludeAuthorId: ['11111111-1111-4111-8111-111111111111']
      })
    )
    assert.ok(
      q.bool.filter.some((f: any) => f.term?.creatorId === '11111111-1111-4111-8111-111111111111')
    )
    assert.ok(q.bool.filter.some((f: any) => f.terms?.authorId?.length === 2))
    assert.deepEqual(q.bool.must_not, [
      { terms: { creatorId: ['22222222-2222-4222-8222-222222222222'] } },
      { terms: { authorId: ['11111111-1111-4111-8111-111111111111'] } }
    ])
  })

  test('an exclusion sits beside, not in place of, the always-on draft exclusion', () => {
    const q = buildEsQuery(params({ excludeEditor: ['code'] }))
    assert.ok(q.bool.filter.some((f: any) => f.bool?.must_not?.[0]?.term?.publishState === 'draft'))
    assert.deepEqual(q.bool.must_not, [{ terms: { editor: ['code'] } }])
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
 * Exercised against a fake client rather than a live cluster, but `search`'s real `definitions` are
 * loaded from the on-disk `definition.yml` files, so `getEngineConfig()` resolves this module's
 * config defaults exactly the way the running app would.
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
    assert.deepEqual(mappings.properties.creatorId, { type: 'keyword' })
    assert.deepEqual(mappings.properties.authorId, { type: 'keyword' })
    assert.deepEqual(mappings.properties.path, { type: 'text' })
  })

  test('an index name and analyzer the operator CLEARED fall back to their declared defaults', async () => {
    // -> `getEngineConfig`'s merge only substitutes a declared default for `undefined`, and an
    //    emptied text field is stored as `''` — so without `fillEmptyStringDefaults` the cluster
    //    would be asked for an index named `''` analyzed by `''`
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

  test('init() adds the creator and author mappings to an index created before they existed', async () => {
    const { mod, calls, setIndexExists } = moduleWithFakeClient()
    setIndexExists(true)
    await mod.init(siteId, { hosts: 'http://localhost:9200', indexName: 'wiki-test' })

    assert.deepEqual(calls.indicesPutMapping, [
      {
        index: 'wiki-test',
        properties: { creatorId: { type: 'keyword' }, authorId: { type: 'keyword' } }
      }
    ])
  })

  describe('rebuild()', () => {
    let previousDb: any

    before(() => {
      previousDb = (globalThis as any).CARDINAL.db
    })

    after(() => {
      ;(globalThis as any).CARDINAL.db = previousDb
    })

    /**
     * The batching and per-locale tally belong to the shared contract. Elasticsearch's alone: the
     * purge is a `deleteByQuery` over this site, the bulk body interleaves one index-meta entry per
     * document, and each locale reports `dictionary: 'n/a'` — the analyzer is index-wide, not per
     * locale.
     */
    test("deletes only this site's documents, and bulk-sends meta/document pairs", async () => {
      const { mod, calls } = moduleWithFakeClient()
      ;(globalThis as any).CARDINAL.db = stubPageStreamDb([
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
      ;(globalThis as any).CARDINAL.db = stubPageStreamDb([])

      const result = await mod.rebuild(siteId)

      assert.equal(calls.deleteByQuery!.length, 1)
      assert.deepEqual(result.locales, [])
    })

    /**
     * Reading every page up front, or prefetching the next page while a `bulk` call is still in
     * flight, holds postgres connections open for the whole duration of talking to Elasticsearch.
     * 501 rows puts the assertion across a `PAGE_SIZE` boundary rather than inside one page.
     */
    test('streams sequentially: never reads the next page of rows while a batch upload is still in flight', async () => {
      const { mod, client } = moduleWithFakeClient()
      const events: string[] = []

      const originalBulk = client.bulk
      client.bulk = async (args: any) => {
        events.push('bulk-start')
        // -> A real round-trip is asynchronous; without the delay the mock resolves synchronously
        //    and an overlapping `select` would go undetected
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push('bulk-end')
        return originalBulk(args)
      }

      const firstPage = Array.from({ length: 500 }, (_, i) =>
        fakePage({ id: `p${String(i).padStart(4, '0')}`, locale: 'en' })
      )
      const secondPage = [fakePage({ id: 'p0500', locale: 'en' })]
      let selectCall = 0
      ;(globalThis as any).CARDINAL.db = {
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
 * The claims every external engine owes `models/search.ts`, translated into Elasticsearch's own
 * request and response shapes. Everything above this line is Elasticsearch's alone.
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
        ;(globalThis as any).CARDINAL.db = stubPageStreamDb(pages)
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
