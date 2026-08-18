import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { blocks } from './blocks.ts'

/**
 * `setBlocksState` is what the admin "Content Blocks" page's Apply button calls, and it is the only
 * writer of the `blocks.config` JSONB column — which is where a site-wide default (e.g. the Kroki or
 * PlantUML "Server" field) is stored. `WIKI.db` is stubbed rather than pointed at a real Postgres:
 * the logic under test is which `.set()` payload gets built per state entry, not Drizzle's own
 * query-building, and stubbing keeps this a fast, DB-less unit test.
 */

let sets: Array<{ values: any; where: any }>

beforeEach(() => {
  sets = []
  ;(globalThis as any).WIKI = {
    db: {
      update: () => ({
        set: (values: any) => ({
          where: async (where: any) => {
            sets.push({ values, where })
            return { rowCount: 1 }
          }
        })
      })
    }
  }
})

describe('blocks.setBlocksState', () => {
  test('writes isEnabled alone when no config is given', async () => {
    const changed = await blocks.setBlocksState('site-1', [{ id: 'block-1', isEnabled: true }])
    assert.equal(changed, 1)
    assert.deepEqual(sets[0].values, { isEnabled: true })
  })

  test('writes config alongside isEnabled when the caller provides one', async () => {
    await blocks.setBlocksState('site-1', [
      { id: 'block-1', isEnabled: true, config: { server: 'https://kroki.example.com' } }
    ])
    assert.deepEqual(sets[0].values, {
      isEnabled: true,
      config: { server: 'https://kroki.example.com' }
    })
  })

  test('writes an empty config object as-is, clearing a previously-set value', async () => {
    await blocks.setBlocksState('site-1', [{ id: 'block-1', isEnabled: false, config: {} }])
    assert.deepEqual(sets[0].values, { isEnabled: false, config: {} })
  })

  test('one row written per state entry, even when several share isEnabled', async () => {
    const changed = await blocks.setBlocksState('site-1', [
      { id: 'block-1', isEnabled: true, config: { server: 'https://a.example.com' } },
      { id: 'block-2', isEnabled: true, config: { server: 'https://b.example.com' } }
    ])
    assert.equal(changed, 2)
    assert.equal(sets.length, 2)
    assert.deepEqual(sets[0].values.config, { server: 'https://a.example.com' })
    assert.deepEqual(sets[1].values.config, { server: 'https://b.example.com' })
  })
})
