import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETS, NOT_FOUND_CACHE_MAX, icons } from './icons.ts'

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
 * OpenProject #2272: `getSet(prefix)` used to be `(await this.getSets()).find(...)`, which meant a
 * full `select * from iconSets` plus a `count(*) ... group by prefix` aggregate over the entire
 * `icons` table on every call -- paid twice per public batch request (`controllers/icons.ts`) and
 * again for any unresolved name (`fetchIconsUpstream()`). This is a pure unit test against a fake
 * `WIKI.db` query builder recording which methods were chained: no real Postgres connection is
 * needed to verify the *shape* of the query `getSet()` now issues.
 */
describe('icons.getSet', () => {
  let previousWiki: any

  beforeEach(() => {
    previousWiki = (globalThis as any).WIKI
  })

  afterEach(() => {
    ;(globalThis as any).WIKI = previousWiki
  })

  /** Records which drizzle builder methods were chained, resolving `.limit()` with canned rows. */
  function installFakeDb(rows: any[]): { selectCalls: number; chainedCalls: string[] } {
    const state = { selectCalls: 0, chainedCalls: [] as string[] }
    const builder: any = {
      from: (..._args: any[]) => {
        state.chainedCalls.push('from')
        return builder
      },
      where: (..._args: any[]) => {
        state.chainedCalls.push('where')
        return builder
      },
      groupBy: (..._args: any[]) => {
        state.chainedCalls.push('groupBy')
        return builder
      },
      limit: (..._args: any[]) => {
        state.chainedCalls.push('limit')
        return Promise.resolve(rows)
      }
    }
    ;(globalThis as any).WIKI = {
      db: {
        select: (..._args: any[]) => {
          state.selectCalls++
          return builder
        }
      }
    }
    return state
  }

  it('issues exactly one row-scoped select, with no count()/groupBy() aggregate', async () => {
    const row = {
      prefix: 'mdi',
      name: 'Material Design Icons',
      isEnabled: true,
      info: {},
      refreshedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z')
    }
    const state = installFakeDb([row])

    const result = await icons.getSet('mdi')

    assert.equal(state.selectCalls, 1, 'must issue exactly one select() query')
    assert.ok(
      !state.chainedCalls.includes('groupBy'),
      'must not run the icons-table count()/groupBy() aggregate'
    )
    assert.ok(state.chainedCalls.includes('where'), 'must scope the query to the requested prefix')
    assert.deepEqual(result, { ...row, info: {}, iconCount: 0 })
  })

  it('returns null when the set has not been added, still with a single query', async () => {
    const state = installFakeDb([])

    const result = await icons.getSet('does-not-exist')

    assert.equal(result, null)
    assert.equal(state.selectCalls, 1)
  })
})

/**
 * OpenProject #2272: `notFoundCache` was a plain `Map` with no eviction other than a lazy same-key
 * TTL check inside `isKnownMissing()` -- nothing ever swept it, so it grew without bound across a
 * long-lived instance. It is now an `LRUCache` with a hard `max`, verified directly here rather than
 * by driving it through `fetchIconsUpstream()` (which would need a mocked upstream fetch and adds
 * nothing this doesn't already cover).
 */
describe('icons.notFoundCache', () => {
  afterEach(() => {
    icons.notFoundCache.clear()
  })

  it('stops growing once its bound is reached', () => {
    for (let i = 0; i < NOT_FOUND_CACHE_MAX + 500; i++) {
      icons.notFoundCache.set(`mdi:missing-${i}`, true)
    }
    assert.ok(
      icons.notFoundCache.size <= NOT_FOUND_CACHE_MAX,
      `expected size <= ${NOT_FOUND_CACHE_MAX}, got ${icons.notFoundCache.size}`
    )
  })

  it('evicts the oldest entry once the bound is exceeded, so it is no longer known-missing', () => {
    icons.notFoundCache.set('mdi:first', true)
    assert.equal(icons.isKnownMissing('mdi', 'first'), true)

    for (let i = 0; i < NOT_FOUND_CACHE_MAX + 500; i++) {
      icons.notFoundCache.set(`mdi:filler-${i}`, true)
    }

    assert.equal(icons.isKnownMissing('mdi', 'first'), false)
  })
})
