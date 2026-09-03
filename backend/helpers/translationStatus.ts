/**
 * Per-locale translation staleness/missing status against a primary-locale page (Feature #2439's
 * "translation staleness is queryable but never surfaced to users"), joined on the shared
 * `(siteId, path)` identity `pages_siteId_locale_path_idx` makes real -- see
 * `docs/decisions/locale-translation-linking.md`. Staleness is always
 * `translation.updatedAt < primary.updatedAt`; nothing here needs a translation-group id, since same
 * path within a site already IS the translation link.
 *
 * Deliberately DB-free: the join itself (which rows exist for a path, across every locale) is a
 * plain query the caller runs first (`models/pages.ts#listTranslationStatusRows` /
 * `#getTranslationRows`), kept separate from this pure compare so the interesting logic is
 * unit-testable with no database, per this repo's stated preference.
 *
 * Two call shapes exist because two different consumers each needed a different one, and both are
 * genuinely live -- neither supersedes the other:
 *
 * - `computeTranslationStatus` -- the locale-switcher badge (OpenProject #2475,
 *   `api/pages/read.ts`'s `translationStatus` route / `LocaleSelectorMenu.vue`): one page's own
 *   per-locale `{ exists, stale }` pair, the smallest shape that question needs.
 * - `translationStatusForPath` / `computeTranslationStatuses` -- the admin pages view's staleness/
 *   missing column (OpenProject #2476, `api/pages/read.ts`'s search route's `attachLocaleStatus`):
 *   a richer `{ state, updatedAt }` per locale (folding "missing" and "stale" into one four-value
 *   state alongside "primary"/"current"), batched over every distinct path in a page of search
 *   results in one pass rather than one query per row.
 */

/** One page row's identity for the purposes of this comparison — locale plus when it last changed. */
export interface TranslationStatusRow {
  locale: string
  updatedAt: Date
}

/** This locale's status relative to the primary-locale page at the same path. */
export interface TranslationStatus {
  locale: string
  /** Whether a page exists in this locale at all. */
  exists: boolean
  /**
   * Whether the existing translation's `updatedAt` predates the primary-locale page's own —
   * always `false` for the primary locale itself (nothing to compare it against), and always
   * `false` when it does not exist (that is `exists: false`'s job to say, not this one's).
   */
  stale: boolean
}

/**
 * Build one `TranslationStatus` per active locale.
 *
 * `rows` is whatever the caller has already fetched AND filtered down to what the current reader
 * may see — this never widens that set. When the primary locale's own row is missing from `rows`
 * (unreadable to this caller, or genuinely deleted), there is no baseline to compare anything
 * against, so every non-primary locale still reports `exists` accurately but `stale` is always
 * `false` rather than guessing at a comparison that cannot be made.
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
