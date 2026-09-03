import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { ensureTemporal } from '../test/temporal.ts'
import {
  computeTranslationStatuses,
  translationStatusForPath,
  type TranslationRow
} from './translationStatus.ts'

before(async () => {
  await ensureTemporal()
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
