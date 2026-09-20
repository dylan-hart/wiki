/**
 * Translations are linked by sharing `(siteId, path)` across locales, so staleness is
 * `translation.updatedAt < primary.updatedAt`. Pure compares over rows the caller already fetched.
 */

export interface TranslationStatusRow {
  locale: string
  updatedAt: Date
}

export interface TranslationStatus {
  locale: string
  exists: boolean
  /** Always `false` for the primary locale and for a locale with no page. */
  stale: boolean
}

/**
 * `rows` must already be filtered to what the reader may see. Without the primary locale's row
 * (unreadable or deleted) there is no baseline, so `stale` is `false` for every locale.
 */
export function computeTranslationStatus(
  activeLocales: string[],
  primaryLocale: string,
  rows: TranslationStatusRow[]
): TranslationStatus[] {
  const byLocale = new Map(rows.map((row) => [row.locale, row]))
  const primary = byLocale.get(primaryLocale)
  return activeLocales.map((locale) => {
    const row = byLocale.get(locale)
    const exists = Boolean(row)
    const stale =
      exists && Boolean(primary) && locale !== primaryLocale
        ? row!.updatedAt.getTime() < primary!.updatedAt.getTime()
        : false
    return { locale, exists, stale }
  })
}

export type TranslationState = 'primary' | 'current' | 'stale' | 'missing'

export interface TranslationStatusEntry {
  locale: string
  state: TranslationState
  updatedAt: string | null
}

export interface TranslationRow {
  locale: string
  updatedAt: Date
}

export function translationStatusForPath(
  rows: TranslationRow[],
  activeLocales: string[],
  primaryLocale: string
): TranslationStatusEntry[] {
  const byLocale = new Map(rows.map((row) => [row.locale, row]))
  const primaryRow = byLocale.get(primaryLocale)
  const orderedLocales = [...new Set([primaryLocale, ...activeLocales])]

  return orderedLocales.map((locale) => {
    const row = byLocale.get(locale)
    if (!row) {
      return { locale, state: 'missing', updatedAt: null }
    }
    const updatedAt = row.updatedAt.toTemporalInstant().toString({ smallestUnit: 'millisecond' })
    if (locale === primaryLocale) {
      return { locale, state: 'primary', updatedAt }
    }
    // -> No primary page to be stale against.
    if (!primaryRow) {
      return { locale, state: 'current', updatedAt }
    }
    const state = row.updatedAt.getTime() < primaryRow.updatedAt.getTime() ? 'stale' : 'current'
    return { locale, state, updatedAt }
  })
}

export function computeTranslationStatuses(
  rowsByPath: Map<string, TranslationRow[]>,
  activeLocales: string[],
  primaryLocale: string
): Map<string, TranslationStatusEntry[]> {
  const result = new Map<string, TranslationStatusEntry[]>()
  for (const [path, rows] of rowsByPath) {
    result.set(path, translationStatusForPath(rows, activeLocales, primaryLocale))
  }
  return result
}
