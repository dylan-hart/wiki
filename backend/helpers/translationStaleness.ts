/**
 * A translation is `'stale'` when its `updatedAt` predates the primary-locale page's, `'missing'`
 * when the active locale has no row at all for that path, `'current'` otherwise. Pure: it works
 * over rows the caller (`models/pages.ts#getTranslationStaleness`) has already fetched under its
 * own query scope -- one page for a locale-switcher badge, a whole site for an admin listing -- and
 * does no I/O.
 */

export type TranslationStalenessStatus = 'current' | 'stale' | 'missing'

export interface TranslationStalenessRow {
  path: string
  locale: string
  updatedAt: Date
}

export interface TranslationStalenessEntry {
  path: string
  locale: string
  status: TranslationStalenessStatus
  /** `null` exactly when `status` is `'missing'`. */
  updatedAt: Date | null
}

/**
 * A path with no primary-locale row among `rows` is skipped entirely: there is nothing to compare
 * its translations against. `primaryLocale` itself never appears in the output either.
 *
 * `activeLocales` is read straight off a site's config, so it may repeat a code or include
 * `primaryLocale`; both are deduped and filtered here rather than demanded of the caller.
 */
export function computeTranslationStaleness(
  rows: TranslationStalenessRow[],
  { primaryLocale, activeLocales }: { primaryLocale: string; activeLocales: string[] }
): TranslationStalenessEntry[] {
  const otherLocales = [...new Set(activeLocales)].filter((locale) => locale !== primaryLocale)
  if (otherLocales.length < 1) {
    return []
  }

  const byPath = new Map<string, Map<string, Date>>()
  for (const row of rows) {
    let byLocale = byPath.get(row.path)
    if (!byLocale) {
      byLocale = new Map()
      byPath.set(row.path, byLocale)
    }
    byLocale.set(row.locale, row.updatedAt)
  }

  const entries: TranslationStalenessEntry[] = []
  for (const path of [...byPath.keys()].sort()) {
    const byLocale = byPath.get(path)!
    const primaryUpdatedAt = byLocale.get(primaryLocale)
    if (!primaryUpdatedAt) {
      continue
    }
    for (const locale of otherLocales) {
      const translationUpdatedAt = byLocale.get(locale)
      if (!translationUpdatedAt) {
        entries.push({ path, locale, status: 'missing', updatedAt: null })
      } else {
        entries.push({
          path,
          locale,
          status: translationUpdatedAt < primaryUpdatedAt ? 'stale' : 'current',
          updatedAt: translationUpdatedAt
        })
      }
    }
  }
  return entries
}
