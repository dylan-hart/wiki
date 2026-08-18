import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { IdMap, resolveActorId } from './id-map.ts'

describe('IdMap', () => {
  test('starts empty', () => {
    const map = new IdMap<number>()
    assert.equal(map.size, 0)
    assert.equal(map.has(1), false)
    assert.equal(map.get(1), undefined)
  })

  test('set() then get()/has() see the mapping', () => {
    const map = new IdMap<number>()
    map.set(42, 'uuid-42')
    assert.equal(map.size, 1)
    assert.equal(map.has(42), true)
    assert.equal(map.get(42), 'uuid-42')
  })

  test('resolve() returns the mapped uuid', () => {
    const map = new IdMap<number>()
    map.set(1, 'uuid-1')
    assert.equal(map.resolve(1), 'uuid-1')
  })

  test('resolve() throws for an id nothing has set yet', () => {
    const map = new IdMap<number>()
    assert.throws(() => map.resolve(999), /No new-UUID mapping for old id "999"/)
  })

  test('set() overwrites a previous mapping for the same old id', () => {
    const map = new IdMap<number>()
    map.set(1, 'uuid-a')
    map.set(1, 'uuid-b')
    assert.equal(map.get(1), 'uuid-b')
    assert.equal(map.size, 1)
  })

  test('entries() iterates every [oldId, newId] pair', () => {
    const map = new IdMap<number>()
    map.set(1, 'uuid-1')
    map.set(2, 'uuid-2')
    assert.deepEqual(
      [...map.entries()].sort(),
      [
        [1, 'uuid-1'],
        [2, 'uuid-2']
      ].sort()
    )
  })
})

describe('resolveActorId', () => {
  const fallback = 'uuid-operator'

  test('resolves through the user id map when the old id is mapped', () => {
    const userIdMap = new IdMap<number>()
    userIdMap.set(10, 'uuid-user-10')
    const result = resolveActorId(10, userIdMap, fallback)
    assert.equal(result.actorId, 'uuid-user-10')
    assert.equal(result.usedFallback, false)
  })

  test('falls back when the old id is null (2.x column was null)', () => {
    const userIdMap = new IdMap<number>()
    const result = resolveActorId(null, userIdMap, fallback)
    assert.equal(result.actorId, fallback)
    assert.equal(result.usedFallback, false)
  })

  test('falls back when the old id is undefined', () => {
    const userIdMap = new IdMap<number>()
    const result = resolveActorId(undefined, userIdMap, fallback)
    assert.equal(result.actorId, fallback)
    assert.equal(result.usedFallback, false)
  })

  test('falls back and flags it when the old id is set but unmapped (orphaned FK)', () => {
    const userIdMap = new IdMap<number>()
    const result = resolveActorId(999, userIdMap, fallback)
    assert.equal(result.actorId, fallback)
    assert.equal(result.usedFallback, true)
  })
})
