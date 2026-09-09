import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { icons as iconsTable, iconSets as iconSetsTable } from '../db/schema.ts'
import { DEFAULT_SETS, NOT_FOUND_CACHE_MAX, IconNotFoundUpstreamError, icons } from './icons.ts'

/**
 * OpenProject #1212: Font Awesome Free ships pre-added, the same way Line Awesome and Material
 * Design Icons already do, rather than being something an admin has to know to search for and add
 * manually via the live Iconify catalog.
 *
 * Pure data assertion, not a DB-backed test -- `init()` itself (the thing that actually inserts
 * these rows) is a one-line `db.insert(...).values(...)` with no branching worth a Postgres round
 * trip; what is worth pinning is the seed list's own shape, which is what a future edit is most
 * likely to accidentally change.
 */
describe('icons DEFAULT_SETS', () => {
  it('still seeds the pre-existing mdi and la prefixes', () => {
    const prefixes = DEFAULT_SETS.map((set) => set.prefix)
    assert.ok(prefixes.includes('mdi'))
    assert.ok(prefixes.includes('la'))
  })

  it('seeds all three Font Awesome 6 free-tier collections, not the single legacy fa prefix', () => {
    const prefixes = DEFAULT_SETS.map((set) => set.prefix)
    assert.ok(prefixes.includes('fa6-solid'))
    assert.ok(prefixes.includes('fa6-regular'))
    assert.ok(prefixes.includes('fa6-brands'))
    assert.ok(!prefixes.includes('fa'))
  })

  it('has no duplicate prefixes', () => {
    const prefixes = DEFAULT_SETS.map((set) => set.prefix)
    assert.equal(new Set(prefixes).size, prefixes.length)
  })
})

/**
 * `getSet()` (OpenProject #2272): a single-row query by prefix, with no `count()` aggregate over the
 * (potentially large) `icons` table -- the public `/_icons` batch route calls this on every request.
 *
 * A fake `WIKI.db` distinguishing the two tables `select().from()` could be pointed at, rather than a
 * real database: what is under test is which query shape `getSet()` issues, not any actual row data,
 * so recording call counts against each table's own chain is a more direct check than reading back
 * values a real Postgres round trip would launder through anyway.
 */
describe('icons.getSet', () => {
  const calls = { setsRowQuery: 0, setsCountAggregate: 0 }
  const fixtureSet = {
    prefix: 'mdi',
    name: 'Material Design Icons',
    isEnabled: true,
    info: {},
    refreshedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z')
  }

  function makeFakeDb() {
    return {
      select: (_cols?: any) => ({
        from: (table: any) => {
          if (table === iconSetsTable) {
            return {
              where: (_where: any) => ({
                limit: async (_n: number) => {
                  calls.setsRowQuery++
                  return [fixtureSet]
                }
              })
            }
          }
          if (table === iconsTable) {
            return {
              groupBy: async (_col: any) => {
                calls.setsCountAggregate++
                return []
              }
            }
          }
          throw new Error(`unexpected table passed to select().from(): ${String(table)}`)
        }
      })
    }
  }

  beforeEach(() => {
    calls.setsRowQuery = 0
    calls.setsCountAggregate = 0
    ;(globalThis as any).WIKI = { db: makeFakeDb() }
  })

  afterEach(() => {
    delete (globalThis as any).WIKI
  })

  it('issues exactly one row-scoped query and no count() aggregate', async () => {
    const result = await icons.getSet('mdi')
    assert.equal(calls.setsRowQuery, 1)
    assert.equal(calls.setsCountAggregate, 0)
    assert.equal(result?.prefix, 'mdi')
    assert.ok(!('iconCount' in (result as object)), 'getSet() must not return iconCount')
  })

  it('returns null, still with no aggregate, when the prefix has not been added', async () => {
    ;(globalThis as any).WIKI.db = {
      select: () => ({
        from: (table: any) => {
          if (table === iconSetsTable) {
            return { where: () => ({ limit: async () => [] }) }
          }
          throw new Error('must not query the icons table for a set that is not there')
        }
      })
    }
    const result = await icons.getSet('does-not-exist')
    assert.equal(result, null)
  })
})

/**
 * `notFoundCache` bound (OpenProject #2272): it is an `LRUCache` with `max: NOT_FOUND_CACHE_MAX`, so
 * inserting past that bound through `rememberMissing()` evicts the oldest (least recently used) entry
 * automatically. No `WIKI` needed -- this exercises the cache directly, with no I/O.
 */
describe('icons.rememberMissing (notFoundCache bound)', () => {
  afterEach(() => {
    icons.notFoundCache.clear()
  })

  it('stops growing once the bound is reached', () => {
    for (let i = 0; i < NOT_FOUND_CACHE_MAX + 50; i++) {
      icons.rememberMissing('mdi', `icon-${i}`)
    }
    assert.equal(icons.notFoundCache.size, NOT_FOUND_CACHE_MAX)
  })

  it('evicts the oldest entry first, keeping the most recently remembered names', () => {
    for (let i = 0; i < NOT_FOUND_CACHE_MAX + 1; i++) {
      icons.rememberMissing('mdi', `icon-${i}`)
    }
    assert.ok(
      !icons.notFoundCache.has('mdi:icon-0'),
      'the very first entry should have been evicted'
    )
    assert.ok(
      icons.notFoundCache.has(`mdi:icon-${NOT_FOUND_CACHE_MAX}`),
      'the most recently added entry should still be present'
    )
  })
})

/**
 * `apiFetch` (OpenProject #2889): upstream answers an unknown icon/prefix two documented ways -- a
 * genuine HTTP 404, or a 200 response whose JSON body is the literal string `'404'` -- and both must
 * reject with `IconNotFoundUpstreamError` specifically, not the plain `Error` a real failure throws,
 * since that is what lets `fetchIconsUpstream` pick the right log level.
 */
describe('icons.apiFetch upstream-not-found detection', () => {
  beforeEach(() => {
    ;(globalThis as any).WIKI = {
      config: { offline: false, icons: {} },
      logger: { debug: mock.fn() }
    }
  })

  afterEach(() => {
    delete (globalThis as any).WIKI
    mock.restoreAll()
  })

  it('throws IconNotFoundUpstreamError for a genuine HTTP 404', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 404,
      json: async () => {
        throw new Error('must not be read on a 404')
      }
    }))
    await assert.rejects(() => icons.apiFetch('/does-not-exist.json'), IconNotFoundUpstreamError)
  })

  it('throws IconNotFoundUpstreamError for a 200 response whose body is the literal string "404"', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => '404'
    }))
    await assert.rejects(
      () => icons.apiFetch('/mdi.json?icons=does-not-exist'),
      IconNotFoundUpstreamError
    )
  })

  it('throws a plain Error, not IconNotFoundUpstreamError, for a real failure (5xx)', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error('must not be read on a non-404 error')
      }
    }))
    await assert.rejects(
      () => icons.apiFetch('/mdi.json?icons=user'),
      (err: any) => err instanceof Error && !(err instanceof IconNotFoundUpstreamError)
    )
  })

  it('throws a plain Error, not IconNotFoundUpstreamError, for a malformed non-404 body', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => null
    }))
    await assert.rejects(
      () => icons.apiFetch('/mdi.json?icons=user'),
      (err: any) => err instanceof Error && !(err instanceof IconNotFoundUpstreamError)
    )
  })
})

/**
 * `fetchIconsUpstream` (OpenProject #2889): the "upstream has nothing for this" shape is an
 * expected, routine outcome and must log at `debug`, not `warn` -- only a genuine failure (network
 * error, 5xx, a malformed body) still warns. `apiFetch` is stubbed here so the test is about which
 * log level the catch block picks, not about `apiFetch`'s own response parsing (covered above).
 */
describe('icons.fetchIconsUpstream logging level', () => {
  function makeFakeDb() {
    return {
      select: () => ({
        from: (table: any) => {
          if (table === iconSetsTable) {
            return {
              where: () => ({
                limit: async () => [
                  {
                    prefix: 'wp2889',
                    name: 'Test Set',
                    isEnabled: true,
                    info: {},
                    refreshedAt: null,
                    createdAt: new Date('2026-01-01T00:00:00.000Z')
                  }
                ]
              })
            }
          }
          throw new Error(`unexpected table passed to select().from(): ${String(table)}`)
        }
      })
    }
  }

  beforeEach(() => {
    ;(globalThis as any).WIKI = {
      db: makeFakeDb(),
      config: { offline: false, icons: {} },
      logger: { debug: mock.fn(), warn: mock.fn() }
    }
  })

  afterEach(() => {
    delete (globalThis as any).WIKI
    mock.restoreAll()
    icons.notFoundCache.clear()
  })

  it('logs debug, not warn, when upstream has nothing for this request', async () => {
    mock.method(icons, 'apiFetch', async () => {
      throw new IconNotFoundUpstreamError('upstream has nothing for this')
    })
    await icons.fetchIconsUpstream('wp2889', ['unknown-icon-a'])
    const wiki = (globalThis as any).WIKI
    assert.equal(wiki.logger.debug.mock.calls.length, 1)
    assert.equal(wiki.logger.warn.mock.calls.length, 0)
    const [scope, message, fields] = wiki.logger.debug.mock.calls[0].arguments
    assert.equal(scope, 'icons')
    assert.equal(typeof message, 'string')
    assert.equal(fields.prefix, 'wp2889')
  })

  it('still logs warn, not debug, for a genuine failure', async () => {
    mock.method(icons, 'apiFetch', async () => {
      throw new Error('network exploded')
    })
    await icons.fetchIconsUpstream('wp2889', ['unknown-icon-b'])
    const wiki = (globalThis as any).WIKI
    assert.equal(wiki.logger.warn.mock.calls.length, 1)
    assert.equal(wiki.logger.debug.mock.calls.length, 0)
  })
})
