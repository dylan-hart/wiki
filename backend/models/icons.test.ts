import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETS } from './icons.ts'

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
