/**
 * Translation staleness/missing status via the shared `(siteId, path)` join
 * `docs/decisions/locale-translation-linking.md` already frames as trivial: a translation is
 * `'stale'` when its `updatedAt` predates the primary-locale page's, `'missing'` when the active
 * locale has no row at all for that path, and `'current'` otherwise. This is the one computation
 * behind two surfaces (OpenProject #2439/#2477) -- a locale-switcher badge for a single page, and
 * an admin pages-view column across a whole site's listing -- so it takes rows already fetched by
 * whichever caller's own query scope (`models/pages.ts#getTranslationStaleness`) and does no I/O
 * itself.
 */

export type TranslationStalenessStatus = 'current' | 'stale' | 'missing'

/** One `pages` row, as `models/pages.ts#getTranslationStaleness` selects it. */
export interface TranslationStalenessRow {
  path: string
  locale: string
  updatedAt: Date
}

/** One active, non-primary locale's status for one path. */
export interface TranslationStalenessEntry {
  path: string
  locale: string
  status: TranslationStalenessStatus
  /** The translation's own `updatedAt`, or `null` when `status` is `'missing'`. */
  updatedAt: Date | null
}

/**
 * Compute staleness/missing status for every active, non-primary locale of every path that has a
 * primary-locale row among `rows`.
 *
 * A path with no primary-locale row is skipped entirely -- there is nothing to compare a
 * translation against, and reporting one as "stale" or "current" against a primary that does not
 * exist would be meaningless. `primaryLocale` itself never appears in the output: there is no
 * such thing as the primary page being stale relative to itself.
 *
 * `activeLocales` may repeat a code or include `primaryLocale`; both are handled defensively
 * (deduped, and `primaryLocale` filtered out) since the caller reads this straight off a site's
 * config, not a value this function controls.
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
