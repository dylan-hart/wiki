/**
 * Per-locale staleness/missing status against a primary-locale page (OpenProject #2475, part of
 * Feature #2439's "translation staleness is queryable but never surfaced to users").
 *
 * Staleness is `translation.updatedAt < primary.updatedAt` on their shared `(siteId, path)` join
 * (see `docs/decisions/locale-translation-linking.md` — same path within a site IS the translation
 * link), and "missing" is simply the extreme case of that: no row at all. Per Feature #2439's
 * resolved scope ("missing-translation discovery gets the same treatment — one signal covers both
 * states"), both are folded into one `{ exists, stale }` pair per locale rather than two separate
 * computations, so a caller only has to run one query (whatever rows it already has permission to
 * see) and one pass over the active locale list.
 *
 * Kept pure and DB-free on purpose: the caller (`api/pages/read.ts`'s translationStatus route) is
 * the one that knows the request's permission/visibility rules and fetches accordingly — this
 * function never re-derives them, and never queries anything itself.
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
