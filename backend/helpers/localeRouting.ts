import { CustomError } from './common.ts'
import { reservedTwoSegmentPrefix } from './reservedPagePaths.ts'

/** The part of a site's `config.locales` that URL routing reads. */
export interface LocaleRoutingConfig {
  primary: string
  active: string[]
  forcePrefix?: boolean
  aliases?: Record<string, string>
}

export function defaultLocale(siteId: string): string {
  return CARDINAL.sites[siteId]?.config?.locales?.primary ?? 'en'
}

/**
 * A site with no `active` list configured has exactly its primary locale, which is why the fallback
 * is that one code rather than "anything goes".
 */
export function assertLocaleActive(siteId: string, locale: string): void {
  const activeLocales: string[] = CARDINAL.sites[siteId]?.config?.locales?.active ?? [
    defaultLocale(siteId)
  ]
  if (!activeLocales.includes(locale)) {
    throw new CustomError(
      'pageInvalidLocale',
      `This site does not have the "${locale}" locale enabled.`,
      400
    )
  }
}

export function isConfiguredLocaleAlias(siteId: string | undefined, segment: string): boolean {
  if (!siteId || !segment) {
    return false
  }
  const aliases = CARDINAL.sites[siteId]?.config?.locales?.aliases
  if (!aliases || typeof aliases !== 'object') {
    return false
  }
  const lower = segment.toLowerCase()
  return Object.values(aliases).some(
    (alias) => typeof alias === 'string' && alias.toLowerCase() === lower
  )
}

export function reservedLocaleSegmentLabel(siteId: string | undefined, segment: string): string {
  return isConfiguredLocaleAlias(siteId, segment) ? 'a locale alias' : 'an installed locale code'
}

/**
 * `stripLocalePrefix` takes a locale code, or a configured alias of the site (`siteId`), off the
 * first segment of a URL and nowhere else, so a page at `fr/guide` would be unreachable — every
 * request for it would be read as `/guide` in French. Only the first segment can collide;
 * `guide/fr` is fine.
 */
export async function assertPathNotReservedLocale(path: string, siteId?: string): Promise<void> {
  const firstSegment = path.split('/')[0] ?? ''
  if (await CARDINAL.models.locales.isReservedLocaleCode(firstSegment, siteId)) {
    throw new CustomError(
      'pageReservedLocaleSegment',
      `"${firstSegment}" is ${reservedLocaleSegmentLabel(siteId, firstSegment)} and cannot begin a page path.`,
      400
    )
  }
}

export function assertPathNotReservedAppRoute(path: string): void {
  const prefix = reservedTwoSegmentPrefix(path)
  if (prefix) {
    throw new CustomError(
      'pageReservedAppRoute',
      `"${path}" is reserved for the app's own "/${prefix}/..." routes and cannot be a page path.`,
      400
    )
  }
}

/**
 * Returns the code as `active` stores it: a link or query string can carry any casing (`/FR/page`,
 * `?locale=FR`), but storage, comparison and redirect targets all work off the stored casing.
 */
export function matchLocaleCode(candidate: string, active?: string[] | null): string | null {
  if (!active || active.length < 1) {
    return null
  }
  const lower = candidate.toLowerCase()
  return active.find((code) => code.toLowerCase() === lower) ?? null
}

function matchLocaleAlias(candidate: string, locales: LocaleRoutingConfig): string | null {
  if (!locales.aliases) {
    return null
  }
  const lower = candidate.toLowerCase()
  const entry = Object.entries(locales.aliases).find(
    ([code, alias]) => alias.toLowerCase() === lower && locales.active.includes(code)
  )
  return entry?.[0] ?? null
}

export function localeUrlSegment(locale: string, locales?: LocaleRoutingConfig | null): string {
  return locales?.aliases?.[locale] || locale
}

/**
 * A locale-prefixed URL (`/fr/some/page`) and an ordinary one (`/some/page`) are the same shape —
 * only the site's active locale codes tell them apart, which is why this takes the `locales` config
 * rather than recognizing a locale code on its own. What to do about a match (redirect, strip,
 * neither) is the caller's call.
 */
export function stripLocalePrefix(
  urlPath: string,
  locales?: LocaleRoutingConfig | null
): { locale: string; path: string } | null {
  if (!locales?.active || locales.active.length < 1) {
    return null
  }
  const segments = urlPath.split('/')
  const firstSegment = segments[1] ?? ''
  if (!firstSegment) {
    return null
  }
  const match =
    matchLocaleAlias(firstSegment, locales) ?? matchLocaleCode(firstSegment, locales.active)
  if (!match) {
    return null
  }
  const rest = '/' + segments.slice(2).join('/')
  return { locale: match, path: rest === '/' ? '/' : rest }
}

/**
 * Where to redirect a page URL that lacks the locale prefix `forcePrefix` requires, or null. There
 * is nothing to disambiguate with a single active locale, so that case never redirects.
 *
 * @returns The path only — the caller reattaches the query string
 */
export function localePrefixRedirectTarget(
  urlPath: string,
  locales?: LocaleRoutingConfig | null
): string | null {
  if (!locales?.forcePrefix || !locales.active || locales.active.length <= 1) {
    return null
  }
  if (stripLocalePrefix(urlPath, locales)) {
    return null
  }
  return `/${localeUrlSegment(locales.primary, locales)}${urlPath === '/' ? '' : urlPath}`
}

/**
 * The other half of `localePrefixRedirectTarget`: REMOVES an explicit prefix the site's rules leave
 * bare (`/en/page` and `/page` are otherwise two URLs for the same document — the sitemap, hreflang
 * and caches all want exactly one), and rewrites a mis-cased or canonical-code prefix to the URL
 * spelling (the alias when the locale has one). Null when the URL is already canonical.
 *
 * @returns The path only — the caller reattaches the query string
 */
export function localePrefixStripTarget(
  urlPath: string,
  locales?: LocaleRoutingConfig | null
): string | null {
  const stripped = stripLocalePrefix(urlPath, locales)
  if (!stripped) {
    return null
  }
  if (shouldPrefixLocale(stripped.locale, locales)) {
    const canonical = `/${localeUrlSegment(stripped.locale, locales)}${stripped.path === '/' ? '' : stripped.path}`
    return canonical === urlPath ? null : canonical
  }
  return stripped.path
}

/**
 * Backend mirror of the frontend's `shouldPrefixLocale` in `helpers/pagePaths.js` -- keep in sync.
 * `active.length` stands in for the frontend's `useLocales` flag, which this config shape has no
 * field for.
 */
export function shouldPrefixLocale(locale: string, locales?: LocaleRoutingConfig | null): boolean {
  if (!locales?.active || locales.active.length <= 1) {
    return false
  }
  return locale !== locales.primary || Boolean(locales.forcePrefix)
}

/**
 * Backend mirror of `localizedPagePath` in `frontend/src/helpers/pagePaths.js`, and the inverse of
 * `stripLocalePrefix`.
 *
 * @param path Bare page path, without a leading slash, as `pages.path` stores it
 */
export function localizedPagePath(
  path: string,
  locale: string,
  locales?: LocaleRoutingConfig | null
): string {
  const bare = `/${path}`
  return shouldPrefixLocale(locale, locales) ? `/${localeUrlSegment(locale, locales)}${bare}` : bare
}
