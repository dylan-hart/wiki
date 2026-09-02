import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  batchBySize,
  buildSearchDocument,
  defaultPageSource,
  escapeHtml,
  filterVisible,
  HL_START,
  HL_STOP,
  localePageStream,
  normalizeMarkers,
  pageStream,
  REBUILD_BATCH_SIZE,
  SCAN_CAP,
  toSearchPagesResult
} from './shared.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import type { RebuildPageSource } from './shared.ts'
import type { AccessActor } from '../../models/groups.ts'
import type { SearchIndexablePage, SearchResult } from '../../models/search.ts'

/**
 * `buildSearchDocument` calls `Date.prototype.toTemporalInstant()` to build a document's `updatedAt`.
 * Same environment gap every engine suite stubs around: this sandbox's node predates the global.
 */
before(() => ensureTemporal())

describe('escapeHtml()', () => {
  test('escapes the four characters that could turn page text into markup', () => {
    assert.equal(escapeHtml(`<script>a & b "c"`), '&lt;script&gt;a &amp; b &quot;c&quot;')
  })

  test('escapes the ampersand first, so an escape sequence is never double-escaped away', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;')
  })

  test('leaves text with nothing to escape untouched', () => {
    assert.equal(escapeHtml('plain text'), 'plain text')
  })

  test('leaves a single quote alone — it is not one of the four', () => {
    assert.equal(escapeHtml("it's"), "it's")
  })
})

describe('normalizeMarkers()', () => {
  test('the markers are the C0 control characters, not anything that could occur in page text', () => {
    assert.equal(HL_START, '\u0002')
    assert.equal(HL_STOP, '\u0003')
  })

  test('turns the control-character markers into <b> tags', () => {
    assert.equal(normalizeMarkers(`a ${HL_START}match${HL_STOP} here`), 'a <b>match</b> here')
  })

  test('escapes the fragment before the markers become tags, so page markup cannot survive', () => {
    assert.equal(normalizeMarkers(`${HL_START}<script>${HL_STOP}`), '<b>&lt;script&gt;</b>')
  })

  test('normalizes every marker in the fragment, not just the first', () => {
    assert.equal(
      normalizeMarkers(`${HL_START}a${HL_STOP} and ${HL_START}b${HL_STOP}`),
      '<b>a</b> and <b>b</b>'
    )
  })

  test('an absent or empty fragment is null, not an empty string', () => {
    assert.equal(normalizeMarkers(undefined), null)
    assert.equal(normalizeMarkers(null), null)
    assert.equal(normalizeMarkers(''), null)
  })
})

describe('defaultPageSource()', () => {
  let previousDb: any

  before(() => {
    ;(globalThis as any).WIKI = (globalThis as any).WIKI ?? {}
    previousDb = (globalThis as any).WIKI.db
  })

  after(() => {
    ;(globalThis as any).WIKI.db = previousDb
  })

  test('locales() reads the distinct locales of one site, in the order postgres returned them', async () => {
    const calls: any[] = []
    ;(globalThis as any).WIKI.db = {
      selectDistinct: (columns: any) => {
        calls.push(columns)
        return {
          from: () => ({
            where: () => ({
              orderBy: async () => [{ locale: 'en' }, { locale: 'fr' }]
            })
          })
        }
      }
    }

    assert.deepEqual(await defaultPageSource().locales('site-1'), ['en', 'fr'])
    assert.equal(calls.length, 1)
  })

  test('pageBatch() asks for one ordered window of one locale of one site', async () => {
    const seen: Record<string, any> = {}
    ;(globalThis as any).WIKI.db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: (limit: number) => {
                seen.limit = limit
                return {
                  offset: async (offset: number) => {
                    seen.offset = offset
                    return [{ id: 'p1' }]
                  }
                }
              }
            })
          })
        })
      })
    }

    const rows = await defaultPageSource().pageBatch('site-1', 'en', 500, REBUILD_BATCH_SIZE)

    assert.deepEqual(rows, [{ id: 'p1' }] as any)
    assert.equal(seen.limit, REBUILD_BATCH_SIZE)
    assert.equal(seen.offset, 500)
  })

  test('REBUILD_BATCH_SIZE is the one batch size both bulk-indexing engines page by', () => {
    assert.equal(REBUILD_BATCH_SIZE, 500)
  })
})

describe('SCAN_CAP', () => {
  test('is the one bounded window every external engine scans before permission-filtering', () => {
    assert.equal(SCAN_CAP, 500)
  })
})

describe('buildSearchDocument()', () => {
  function fakePage(overrides: Record<string, any> = {}): SearchIndexablePage {
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
      searchContent: 'Some page content.',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides
    } as unknown as SearchIndexablePage
  }

  test('carries every field an external index filters, orders or returns on', () => {
    assert.deepEqual(buildSearchDocument(fakePage()), {
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
      updatedAt: '2026-01-01T00:00:00.000Z',
      content: 'Some page content.'
    })
  })

  test('omits content entirely for a password-protected page, rather than sending it', () => {
    const doc = buildSearchDocument(fakePage({ password: 'hunter2' }))
    assert.equal('content' in doc, false)
  })

  test('a null description, tag list or body becomes the empty value the index expects', () => {
    const doc = buildSearchDocument(
      fakePage({ description: null, tags: null, searchContent: null })
    )
    assert.equal(doc.description, '')
    assert.deepEqual(doc.tags, [])
    assert.equal(doc.content, '')
  })

  test('updatedAt is an exact instant at millisecond precision, not nanoseconds', () => {
    const doc = buildSearchDocument(fakePage({ updatedAt: new Date('2026-03-04T05:06:07.008Z') }))
    assert.equal(doc.updatedAt, '2026-03-04T05:06:07.008Z')
  })
})

describe('batchBySize()', () => {
  const sizeOf = (item: { bytes: number }) => item.bytes

  test('an empty list produces no batches at all, not one empty batch', () => {
    assert.deepEqual(batchBySize([], { sizeOf, maxBytes: 100, maxCount: 10 }), {
      batches: [],
      oversized: []
    })
  })

  test('closes a batch once it holds maxCount items', () => {
    const items = [{ bytes: 1 }, { bytes: 1 }, { bytes: 1 }, { bytes: 1 }, { bytes: 1 }]
    const { batches } = batchBySize(items, { sizeOf, maxBytes: 1000, maxCount: 2 })
    assert.deepEqual(
      batches.map((b) => b.length),
      [2, 2, 1]
    )
  })

  test('closes a batch before its serialized size would reach maxBytes, counting the separators', () => {
    // -> 10 + 1 (separator) + 10 = 21, which reaches maxBytes 21, so the second item starts a batch
    const items = [{ bytes: 10 }, { bytes: 10 }]
    const { batches } = batchBySize(items, { sizeOf, maxBytes: 21, maxCount: 100 })
    assert.deepEqual(
      batches.map((b) => b.length),
      [1, 1]
    )
  })

  test('one byte under that boundary still fits in the same batch', () => {
    const items = [{ bytes: 10 }, { bytes: 10 }]
    const { batches } = batchBySize(items, { sizeOf, maxBytes: 22, maxCount: 100 })
    assert.deepEqual(
      batches.map((b) => b.length),
      [2]
    )
  })

  test('an item too large for any batch is diverted, with its size, rather than sent', () => {
    const big = { bytes: 500 }
    const items = [{ bytes: 10 }, big, { bytes: 10 }]
    const { batches, oversized } = batchBySize(items, {
      sizeOf,
      maxBytes: 1000,
      maxCount: 100,
      maxItemBytes: 100
    })
    assert.deepEqual(batches, [[{ bytes: 10 }, { bytes: 10 }]])
    assert.deepEqual(oversized, [{ item: big, bytes: 500 }])
  })

  test('with no maxItemBytes nothing is ever diverted, however large', () => {
    const { batches, oversized } = batchBySize([{ bytes: 10_000 }], {
      sizeOf,
      maxBytes: 100,
      maxCount: 100
    })
    assert.deepEqual(
      batches.map((b) => b.length),
      [1]
    )
    assert.deepEqual(oversized, [])
  })
})

describe('pageStream()', () => {
  let previousDb: any

  before(() => {
    ;(globalThis as any).WIKI = (globalThis as any).WIKI ?? {}
    previousDb = (globalThis as any).WIKI.db
  })

  after(() => {
    ;(globalThis as any).WIKI.db = previousDb
  })

  /** A fake `WIKI.db` serving successive keyset windows, recording the cursor conditions it saw. */
  function fakeDb(windows: any[][]) {
    const calls: number[] = []
    ;(globalThis as any).WIKI.db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async (limit: number) => {
                calls.push(limit)
                return windows.shift() ?? []
              }
            })
          })
        })
      })
    }
    return calls
  }

  test('yields each full window and stops on the first short one, without a further query', async () => {
    const calls = fakeDb([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]])

    const seen: any[][] = []
    for await (const batch of pageStream('site-1', { pageSize: 2 })) {
      seen.push(batch)
    }

    assert.deepEqual(seen, [[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]])
    // -> Two queries, not three: the short second window is the end of the set
    assert.deepEqual(calls, [2, 2])
  })

  test('an empty first window yields nothing at all', async () => {
    fakeDb([[]])
    const seen: any[][] = []
    for await (const batch of pageStream('site-1', { pageSize: 2 })) {
      seen.push(batch)
    }
    assert.deepEqual(seen, [])
  })

  test('an exactly-full last window costs one more query, which comes back empty', async () => {
    const calls = fakeDb([[{ id: 'a' }, { id: 'b' }], []])
    const seen: any[][] = []
    for await (const batch of pageStream('site-1', { pageSize: 2 })) {
      seen.push(batch)
    }
    assert.deepEqual(seen, [[{ id: 'a' }, { id: 'b' }]])
    assert.deepEqual(calls, [2, 2])
  })

  test('never reads the next window while the consumer is still working on this one', async () => {
    const calls = fakeDb([[{ id: 'a' }], [{ id: 'b' }]])
    let inFlight = 0
    for await (const _batch of pageStream('site-1', { pageSize: 1 })) {
      // -> One query has been made per batch consumed so far, never one ahead
      inFlight += 1
      assert.equal(calls.length, inFlight)
      if (inFlight === 2) {
        break
      }
    }
  })
})

describe('localePageStream()', () => {
  /** A fake `RebuildPageSource` recording the (locale, offset, limit) it was asked for. */
  function fakeSource(rows: SearchIndexablePage[]) {
    const asked: { locale: string; offset: number; limit: number }[] = []
    const source: RebuildPageSource = {
      async locales() {
        return ['en']
      },
      async pageBatch(_siteId, locale, offset, limit) {
        asked.push({ locale, offset, limit })
        return rows.slice(offset, offset + limit)
      }
    }
    return { source, asked }
  }

  const page = (id: string) => ({ id }) as unknown as SearchIndexablePage

  test('walks one locale by increasing offset until a short batch ends it', async () => {
    const { source, asked } = fakeSource([page('a'), page('b'), page('c')])

    const seen: string[][] = []
    for await (const batch of localePageStream(source, 'site-1', 'en', { batchSize: 2 })) {
      seen.push(batch.map((p) => p.id))
    }

    assert.deepEqual(seen, [['a', 'b'], ['c']])
    assert.deepEqual(asked, [
      { locale: 'en', offset: 0, limit: 2 },
      { locale: 'en', offset: 2, limit: 2 }
    ])
  })

  test('a locale with no rows yields nothing, after exactly one call', async () => {
    const { source, asked } = fakeSource([])
    const seen: unknown[] = []
    for await (const batch of localePageStream(source, 'site-1', 'en', { batchSize: 2 })) {
      seen.push(batch)
    }
    assert.deepEqual(seen, [])
    assert.equal(asked.length, 1)
  })

  test('defaults to REBUILD_BATCH_SIZE when no batch size is given', async () => {
    const { source, asked } = fakeSource([])
    for await (const _batch of localePageStream(source, 'site-1', 'en')) {
      // -> nothing to consume; the assertion is on what was asked for
    }
    assert.equal(asked[0]!.limit, REBUILD_BATCH_SIZE)
  })
})

describe('filterVisible()', () => {
  let previousModels: any

  before(() => {
    ;(globalThis as any).WIKI = (globalThis as any).WIKI ?? {}
    previousModels = (globalThis as any).WIKI.models
  })

  after(() => {
    ;(globalThis as any).WIKI.models = previousModels
  })

  /** Installs a `checkAccess` recording every ref it was asked about, and answering from `allow`. */
  function stubCheckAccess(allow: (ref: any) => boolean) {
    const seen: any[] = []
    ;(globalThis as any).WIKI.models = {
      groups: {
        checkAccess: (_actor: any, permission: string, ref: any) => {
          seen.push({ permission, ref })
          return allow(ref)
        }
      }
    }
    return seen
  }

  const row = (path: string, extra: Record<string, any> = {}) => ({
    path,
    locale: 'en',
    tags: [],
    classification: null,
    ...extra
  })

  const actor = { id: 'user-1' } as unknown as AccessActor

  test('with no actor, every row is visible and checkAccess is never consulted', () => {
    const seen = stubCheckAccess(() => false)
    const rows = [row('a'), row('b')]

    assert.deepEqual(
      filterVisible(rows, undefined, 'site-1', (r) => r),
      rows
    )
    assert.equal(seen.length, 0)
  })

  test('drops exactly the rows the actor has no read:pages access to, keeping order', () => {
    stubCheckAccess((ref) => ref.path !== 'secret')
    const rows = [row('a'), row('secret'), row('b')]

    assert.deepEqual(
      filterVisible(rows, actor, 'site-1', (r) => r).map((r) => r.path),
      ['a', 'b']
    )
  })

  test('asks about read:pages, threading the site id onto every ref (task 678)', () => {
    const seen = stubCheckAccess(() => true)
    filterVisible([row('a')], actor, 'site-9', (r) => r)

    assert.equal(seen.length, 1)
    assert.equal(seen[0].permission, 'read:pages')
    assert.equal(seen[0].ref.siteId, 'site-9')
  })

  test('the ref is whatever the caller maps out of its own row shape', () => {
    const seen = stubCheckAccess(() => true)
    // -> An engine's hits are not page rows: each pulls path/locale/tags/classification out of its
    //    own document shape before this can check them.
    const hits = [{ _source: { p: 'docs/x', l: 'fr', t: ['guide'], c: 'confidential' } }]

    filterVisible(hits, actor, 'site-1', (hit) => ({
      path: hit._source.p,
      locale: hit._source.l,
      tags: hit._source.t,
      classification: hit._source.c
    }))

    assert.deepEqual(seen[0].ref, {
      path: 'docs/x',
      locale: 'fr',
      siteId: 'site-1',
      tags: ['guide'],
      classification: 'confidential'
    })
  })
})

describe('toSearchPagesResult()', () => {
  const hit = (id: string) => ({ id })
  const toResult = (h: { id: string }) =>
    ({
      id: h.id,
      path: `docs/${h.id}`,
      locale: 'en',
      title: h.id,
      description: null,
      icon: null,
      tags: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
      relevancy: 1,
      highlight: null
    }) as SearchResult

  test('slices the caller’s page out of the VISIBLE rows, not the scanned ones', () => {
    const scanned = [hit('a'), hit('denied'), hit('b'), hit('c')]
    const visible = [hit('a'), hit('b'), hit('c')]

    const result = toSearchPagesResult(scanned, visible, { offset: 1, limit: 2, toResult })

    assert.deepEqual(
      result.results.map((r) => r.id),
      ['b', 'c']
    )
  })

  test('totalHits counts only what survived filtering — never what the engine reported', () => {
    const scanned = [hit('a'), hit('denied'), hit('b')]
    const visible = [hit('a'), hit('b')]

    // -> OpenProject #2151/#2156: the count oracle is closed by deriving this from `visible` alone
    assert.equal(
      toSearchPagesResult(scanned, visible, { offset: 0, limit: 25, toResult }).totalHits,
      2
    )
  })

  test('totalHitsApproximate is true exactly when filtering dropped something', () => {
    const scanned = [hit('a'), hit('b')]

    assert.equal(
      toSearchPagesResult(scanned, scanned, { offset: 0, limit: 25, toResult })
        .totalHitsApproximate,
      false
    )
    assert.equal(
      toSearchPagesResult(scanned, [hit('a')], { offset: 0, limit: 25, toResult })
        .totalHitsApproximate,
      true
    )
  })

  test('suggestion is null: no external engine has a "did you mean" of its own', () => {
    assert.equal(toSearchPagesResult([], [], { offset: 0, limit: 25, toResult }).suggestion, null)
  })

  test('an offset past the end of the visible set is an empty page, not an error', () => {
    const result = toSearchPagesResult([hit('a')], [hit('a')], {
      offset: 50,
      limit: 25,
      toResult
    })
    assert.deepEqual(result.results, [])
    assert.equal(result.totalHits, 1)
  })
})
