import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTranslationStaleness } from './translationStaleness.ts'

const OLD = new Date('2026-01-01T00:00:00Z')
const NEW = new Date('2026-06-01T00:00:00Z')

describe('computeTranslationStaleness', () => {
  test('flags a translation older than the primary page as stale', () => {
    const entries = computeTranslationStaleness(
      [
        { path: 'guides/x', locale: 'en', updatedAt: NEW },
        { path: 'guides/x', locale: 'fr', updatedAt: OLD }
      ],
      { primaryLocale: 'en', activeLocales: ['en', 'fr'] }
    )

    assert.deepEqual(entries, [{ path: 'guides/x', locale: 'fr', status: 'stale', updatedAt: OLD }])
  })

  test('marks a translation at least as new as the primary page as current', () => {
    const entries = computeTranslationStaleness(
      [
        { path: 'guides/x', locale: 'en', updatedAt: OLD },
        { path: 'guides/x', locale: 'fr', updatedAt: NEW }
      ],
      { primaryLocale: 'en', activeLocales: ['en', 'fr'] }
    )

    assert.deepEqual(entries, [
      { path: 'guides/x', locale: 'fr', status: 'current', updatedAt: NEW }
    ])
  })

  test('a translation exactly as new as the primary page is current, not stale', () => {
    const same = new Date('2026-03-01T00:00:00Z')
    const entries = computeTranslationStaleness(
      [
        { path: 'guides/x', locale: 'en', updatedAt: same },
        { path: 'guides/x', locale: 'fr', updatedAt: same }
      ],
      { primaryLocale: 'en', activeLocales: ['en', 'fr'] }
    )

    assert.equal(entries[0]!.status, 'current')
  })

  test('reports missing when an active locale has no row at all for the path', () => {
    const entries = computeTranslationStaleness(
      [{ path: 'guides/x', locale: 'en', updatedAt: NEW }],
      { primaryLocale: 'en', activeLocales: ['en', 'fr'] }
    )

    assert.deepEqual(entries, [
      { path: 'guides/x', locale: 'fr', status: 'missing', updatedAt: null }
    ])
  })

  test('skips a path with no primary-locale row entirely, even if a translation exists', () => {
    const entries = computeTranslationStaleness(
      [{ path: 'guides/orphan', locale: 'fr', updatedAt: NEW }],
      { primaryLocale: 'en', activeLocales: ['en', 'fr'] }
    )

    assert.deepEqual(entries, [])
  })

  test('never reports a status for the primary locale itself', () => {
    const entries = computeTranslationStaleness(
      [{ path: 'guides/x', locale: 'en', updatedAt: NEW }],
      {
        primaryLocale: 'en',
        activeLocales: ['en']
      }
    )

    assert.deepEqual(entries, [])
  })

  test('a site with only its primary locale active reports nothing, without inspecting rows', () => {
    const entries = computeTranslationStaleness(
      [{ path: 'guides/x', locale: 'en', updatedAt: NEW }],
      { primaryLocale: 'en', activeLocales: ['en'] }
    )

    assert.deepEqual(entries, [])
  })

  test('dedupes a repeated active-locale code instead of double-reporting it', () => {
    const entries = computeTranslationStaleness(
      [
        { path: 'guides/x', locale: 'en', updatedAt: NEW },
        { path: 'guides/x', locale: 'fr', updatedAt: OLD }
      ],
      { primaryLocale: 'en', activeLocales: ['en', 'fr', 'fr'] }
    )

    assert.equal(entries.length, 1)
  })

  test('covers every path present, one entry per active non-primary locale', () => {
    const older = new Date('2025-12-01T00:00:00Z')
    const entries = computeTranslationStaleness(
      [
        { path: 'guides/a', locale: 'en', updatedAt: NEW },
        { path: 'guides/a', locale: 'fr', updatedAt: OLD },
        { path: 'guides/b', locale: 'en', updatedAt: OLD },
        { path: 'guides/b', locale: 'fr', updatedAt: NEW },
        { path: 'guides/b', locale: 'de', updatedAt: older }
      ],
      { primaryLocale: 'en', activeLocales: ['en', 'fr', 'de'] }
    )

    assert.deepEqual(
      entries.map((e) => `${e.path}:${e.locale}:${e.status}`),
      ['guides/a:fr:stale', 'guides/a:de:missing', 'guides/b:fr:current', 'guides/b:de:stale']
    )
  })
})
