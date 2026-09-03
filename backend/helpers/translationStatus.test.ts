import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { ensureTemporal } from '../test/temporal.ts'
import {
  computeTranslationStatus,
  computeTranslationStatuses,
  translationStatusForPath,
  type TranslationRow
} from './translationStatus.ts'

before(async () => {
  await ensureTemporal()
})

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

const PRIMARY = 'en'
const OLDER = new Date('2026-01-01T00:00:00.000Z')
const NEWER = new Date('2026-06-01T00:00:00.000Z')

describe('translationStatusForPath', () => {
  test('the primary locale reports "primary", never compared against itself', () => {
    const rows: TranslationRow[] = [{ locale: 'en', updatedAt: NEWER }]
    const [entry] = translationStatusForPath(rows, ['en'], PRIMARY)
    assert.equal(entry.locale, 'en')
    assert.equal(entry.state, 'primary')
    assert.equal(
      entry.updatedAt,
      NEWER.toTemporalInstant().toString({ smallestUnit: 'millisecond' })
    )
  })

  test('a translation older than the primary page is stale', () => {
    const rows: TranslationRow[] = [
      { locale: 'en', updatedAt: NEWER },
      { locale: 'fr', updatedAt: OLDER }
    ]
    const entries = translationStatusForPath(rows, ['en', 'fr'], PRIMARY)
    const fr = entries.find((e) => e.locale === 'fr')!
    assert.equal(fr.state, 'stale')
  })

  test('a translation at least as fresh as the primary page is current', () => {
    const rows: TranslationRow[] = [
      { locale: 'en', updatedAt: OLDER },
      { locale: 'fr', updatedAt: NEWER }
    ]
    const entries = translationStatusForPath(rows, ['en', 'fr'], PRIMARY)
    const fr = entries.find((e) => e.locale === 'fr')!
    assert.equal(fr.state, 'current')
  })

  test('a translation exactly as fresh as the primary page is current, not stale', () => {
    const rows: TranslationRow[] = [
      { locale: 'en', updatedAt: NEWER },
      { locale: 'fr', updatedAt: NEWER }
    ]
    const entries = translationStatusForPath(rows, ['en', 'fr'], PRIMARY)
    const fr = entries.find((e) => e.locale === 'fr')!
    assert.equal(fr.state, 'current')
  })

  test('a locale with no matching row is missing, with a null updatedAt', () => {
    const rows: TranslationRow[] = [{ locale: 'en', updatedAt: NEWER }]
    const entries = translationStatusForPath(rows, ['en', 'fr'], PRIMARY)
    const fr = entries.find((e) => e.locale === 'fr')!
    assert.equal(fr.state, 'missing')
    assert.equal(fr.updatedAt, null)
  })

  test('the primary locale itself is missing when authored only in another locale', () => {
    const rows: TranslationRow[] = [{ locale: 'fr', updatedAt: NEWER }]
    const entries = translationStatusForPath(rows, ['en', 'fr'], PRIMARY)
    const en = entries.find((e) => e.locale === 'en')!
    assert.equal(en.state, 'missing')
  })

  test('with no primary row to compare against, an existing translation reports current, not stale', () => {
    const rows: TranslationRow[] = [{ locale: 'fr', updatedAt: OLDER }]
    const entries = translationStatusForPath(rows, ['en', 'fr'], PRIMARY)
    const fr = entries.find((e) => e.locale === 'fr')!
    assert.equal(fr.state, 'current')
  })

  test('the primary locale is always reported first, then the rest of activeLocales in order', () => {
    const entries = translationStatusForPath([], ['de', 'fr', 'en'], PRIMARY)
    assert.deepEqual(
      entries.map((e) => e.locale),
      ['en', 'de', 'fr']
    )
  })

  test('a primary locale repeated in activeLocales is not reported twice', () => {
    const entries = translationStatusForPath([], ['en', 'fr'], PRIMARY)
    assert.deepEqual(
      entries.map((e) => e.locale),
      ['en', 'fr']
    )
  })

  test('a locale absent from activeLocales is never reported, even if a row exists for it', () => {
    const rows: TranslationRow[] = [
      { locale: 'en', updatedAt: NEWER },
      { locale: 'de', updatedAt: OLDER }
    ]
    const entries = translationStatusForPath(rows, ['en'], PRIMARY)
    assert.deepEqual(
      entries.map((e) => e.locale),
      ['en']
    )
  })
})

describe('computeTranslationStatuses', () => {
  test('computes each path independently, keyed by path', () => {
    const rowsByPath = new Map<string, TranslationRow[]>([
      ['docs/a', [{ locale: 'en', updatedAt: NEWER }]],
      [
        'docs/b',
        [
          { locale: 'en', updatedAt: OLDER },
          { locale: 'fr', updatedAt: OLDER }
        ]
      ]
    ])
    const result = computeTranslationStatuses(rowsByPath, ['en', 'fr'], PRIMARY)
    assert.equal(result.size, 2)
    assert.equal(result.get('docs/a')!.find((e) => e.locale === 'fr')!.state, 'missing')
    assert.equal(result.get('docs/b')!.find((e) => e.locale === 'fr')!.state, 'current')
  })

  test('an empty map produces an empty result', () => {
    const result = computeTranslationStatuses(new Map(), ['en'], PRIMARY)
    assert.equal(result.size, 0)
  })
})
