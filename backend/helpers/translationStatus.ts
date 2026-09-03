/**
 * Per-locale translation staleness/missing status, joined on the shared `(siteId, path)` identity
 * `pages_siteId_locale_path_idx` makes real -- see `docs/decisions/locale-translation-linking.md`.
 * Staleness is `translation.updatedAt < primary.updatedAt`; nothing here needs a translation-group
 * id, since same path within a site already IS the translation link.
 *
 * Deliberately DB-free: the join itself (which rows exist for a path, across every locale) is a
 * plain query (`models/pages.ts#getTranslationRows`), kept separate from this pure compare so the
 * interesting logic is unit-testable with no database, per this repo's stated preference. First
 * consumer is the admin pages view's staleness/missing column (OpenProject #2476); written to be
 * reused rather than re-derived by the locale-switcher badge (#2475) and the standalone shared
 * helper WP (#2477) when either lands.
 */

/**
 * `primary` -- this IS the site's primary-locale page for the path (the anchor; nothing to compare
 * it against). `current` -- a non-primary translation exists and is at least as fresh as the primary
 * page (or the primary page doesn't exist at all, so nothing can call it stale). `stale` -- a
 * non-primary translation exists but predates the primary page's own last update. `missing` -- no
 * page exists at this locale for the path at all.
 */
export type TranslationState = 'primary' | 'current' | 'stale' | 'missing'

export interface TranslationStatusEntry {
  locale: string
  state: TranslationState
  /** The translation's own `updatedAt`, ISO-formatted to millisecond precision. `null` when missing. */
  updatedAt: string | null
}

/** One page row, as far as staleness comparison cares: which locale, and when it last changed. */
export interface TranslationRow {
  locale: string
  updatedAt: Date
}

/**
 * The full per-locale status breakdown for one path's translations, across a site's active locale
 * list. `rows` need not include every locale, or even the primary one -- a locale with no matching
 * row reports `missing`. `activeLocales` decides which locales are reported at all (a disabled
 * locale's page, if any somehow still exists, is simply not asked about); the primary locale is
 * always reported first, then the rest of `activeLocales` in their given order, deduplicated.
 */
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
    // -> No primary translation to compare against at all: nothing can be called stale relative to
    //    a page that doesn't exist, so this reports as merely current rather than a false positive.
    if (!primaryRow) {
      return { locale, state: 'current', updatedAt }
    }
    const state = row.updatedAt.getTime() < primaryRow.updatedAt.getTime() ? 'stale' : 'current'
    return { locale, state, updatedAt }
  })
}

/**
 * `translationStatusForPath`, batched over every path in `rowsByPath` -- what the admin pages
 * view's search results actually need, one page of results at a time.
 */
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
