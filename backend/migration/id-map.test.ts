import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolveActorId } from './id-map.ts'

describe('resolveActorId', () => {
  const fallback = 'uuid-operator'

  test('resolves through the user id map when the old id is mapped', () => {
    const userIdMap = new Map<number, string>()
    userIdMap.set(10, 'uuid-user-10')
    const result = resolveActorId(10, userIdMap, fallback)
    assert.equal(result.actorId, 'uuid-user-10')
    assert.equal(result.usedFallback, false)
  })

  test('falls back when the old id is null (2.x column was null)', () => {
    const userIdMap = new Map<number, string>()
    const result = resolveActorId(null, userIdMap, fallback)
    assert.equal(result.actorId, fallback)
    assert.equal(result.usedFallback, false)
  })

  test('falls back when the old id is undefined', () => {
    const userIdMap = new Map<number, string>()
    const result = resolveActorId(undefined, userIdMap, fallback)
    assert.equal(result.actorId, fallback)
    assert.equal(result.usedFallback, false)
  })

  test('falls back and flags it when the old id is set but unmapped (orphaned FK)', () => {
    const userIdMap = new Map<number, string>()
    const result = resolveActorId(999, userIdMap, fallback)
    assert.equal(result.actorId, fallback)
    assert.equal(result.usedFallback, true)
  })
})
