import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeTranslationStatus } from './translationStatus.ts'

describe('computeTranslationStatus', () => {
  test('the primary locale itself is never stale, even with no other rows', () => {
    const primary = new Date('2026-01-01T00:00:00Z')
    const result = computeTranslationStatus(['en'], 'en', [{ locale: 'en', updatedAt: primary }])
    assert.deepEqual(result, [{ locale: 'en', exists: true, stale: false }])
  })

  test('a translation updated before the primary is stale', () => {
    const primary = new Date('2026-06-01T00:00:00Z')
    const older = new Date('2026-01-01T00:00:00Z')
    const result = computeTranslationStatus(['en', 'fr'], 'en', [
      { locale: 'en', updatedAt: primary },
      { locale: 'fr', updatedAt: older }
    ])
    assert.deepEqual(result, [
      { locale: 'en', exists: true, stale: false },
      { locale: 'fr', exists: true, stale: true }
    ])
  })

  test('a translation updated after the primary is not stale', () => {
    const primary = new Date('2026-01-01T00:00:00Z')
    const newer = new Date('2026-06-01T00:00:00Z')
    const result = computeTranslationStatus(['en', 'fr'], 'en', [
      { locale: 'en', updatedAt: primary },
      { locale: 'fr', updatedAt: newer }
    ])
    assert.deepEqual(result[1], { locale: 'fr', exists: true, stale: false })
  })

  test('a translation with no row is missing, not stale', () => {
    const primary = new Date('2026-01-01T00:00:00Z')
    const result = computeTranslationStatus(['en', 'de'], 'en', [
      { locale: 'en', updatedAt: primary }
    ])
    assert.deepEqual(result[1], { locale: 'de', exists: false, stale: false })
  })

  test('with no primary row in `rows`, nothing is ever marked stale', () => {
    const older = new Date('2020-01-01T00:00:00Z')
    // -> `en` (the primary) is absent -- unreadable to this caller, or genuinely gone -- so there
    //    is no baseline to compare `fr`'s row against, however old it looks in isolation.
    const result = computeTranslationStatus(['en', 'fr'], 'en', [
      { locale: 'fr', updatedAt: older }
    ])
    assert.deepEqual(result, [
      { locale: 'en', exists: false, stale: false },
      { locale: 'fr', exists: true, stale: false }
    ])
  })

  test('an exact-equal updatedAt is not stale (strictly-before only)', () => {
    const same = new Date('2026-01-01T00:00:00Z')
    const result = computeTranslationStatus(['en', 'fr'], 'en', [
      { locale: 'en', updatedAt: same },
      { locale: 'fr', updatedAt: new Date(same.getTime()) }
    ])
    assert.deepEqual(result[1], { locale: 'fr', exists: true, stale: false })
  })

  test('empty active locale list returns an empty result', () => {
    assert.deepEqual(computeTranslationStatus([], 'en', []), [])
  })
})
