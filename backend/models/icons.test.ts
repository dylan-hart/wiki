import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { icons as iconsTable, iconSets as iconSetsTable } from '../db/schema.ts'
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
 * `notFoundCache` bound (OpenProject #2272): `rememberMissing()` evicts the oldest entry once the
 * cache reaches `NOT_FOUND_CACHE_MAX`, the same oldest-entry bound `remember()` already applies to
 * `memoryCache`. No `WIKI` needed -- this is plain `Map` bookkeeping with no I/O.
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
