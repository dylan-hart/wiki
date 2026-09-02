import { CustomError } from './common.ts'

/**
 * A site's `config.locales` shape, as far as URL routing cares about it.
 */
export interface LocaleRoutingConfig {
  primary: string
  active: string[]
  forcePrefix?: boolean
}

/**
 * The locale content belongs to when a request does not say.
 *
 * A site always has a primary locale, and an instance that never turned locales on has exactly that
 * one — so this is the answer for most requests rather than a fallback. The single source for what
 * used to be three separately-maintained copies (`api/tree.ts`, `api/pages.ts`,
 * `models/pages.ts#defaultLocale`).
 */
export function defaultLocale(siteId: string): string {
  return WIKI.sites[siteId]?.config?.locales?.primary ?? 'en'
}

/**
 * Refuse a locale the site does not have enabled.
 *
 * A locale that used to be enabled and got turned off is not a valid target for content — not for a
 * page created there, not for one moved there, and not for one the deletion-recovery flow
 * (`pageHistory.recoverDeletedPage`) puts back. A site with no `active` list configured has exactly
 * its primary locale, which is why the fallback is that one code rather than "anything goes".
 *
 * @throws CustomError `pageInvalidLocale` (400) when the locale is not enabled on this site
 */
export function assertLocaleActive(siteId: string, locale: string): void {
  const activeLocales: string[] = WIKI.sites[siteId]?.config?.locales?.active ?? [
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

/**
 * Refuse a page path whose FIRST segment is an installed locale code.
 *
 * `stripLocalePrefix` takes a locale code off the first segment of a URL and nowhere else, so a page
 * at `fr/guide` would be unreachable — every request for it would be read as `/guide` in French.
 * Only the first segment can collide; `guide/fr` is fine.
 *
 * @throws CustomError `pageReservedLocaleSegment` (400) when the first segment is an installed code
 */
export async function assertPathNotReservedLocale(path: string): Promise<void> {
  const firstSegment = path.split('/')[0] ?? ''
  if (await WIKI.models.locales.isReservedLocaleCode(firstSegment)) {
    throw new CustomError(
      'pageReservedLocaleSegment',
      `"${firstSegment}" is an installed locale code and cannot begin a page path.`,
      400
    )
  }
}

/**
 * Find a candidate locale code's canonically-cased form within a site's active list, matching
 * case-insensitively. A link or query string can carry a code in any casing (`/FR/page`,
 * `?locale=FR`), but everything downstream — storage, comparison, the path a redirect lands on —
 * works off the casing `active` itself stores, never the request's own. Returns null when nothing
 * in `active` matches.
 */
export function matchLocaleCode(candidate: string, active?: string[] | null): string | null {
  if (!active || active.length < 1) {
    return null
  }
  const lower = candidate.toLowerCase()
  return active.find((code) => code.toLowerCase() === lower) ?? null
}

/**
 * Split the recognized leading locale segment off a URL path.
 *
 * A locale-prefixed URL (`/fr/some/page`) and an ordinary one (`/some/page`) are the same shape —
 * the only thing that tells them apart is whether the first segment happens to be one of the site's
 * active locale codes, which is why this takes the site's `locales` config rather than trying to
 * recognize a locale code on its own. Matching is case-insensitive (a link typed as `/FR/page` still
 * counts), but the code returned is always the one as stored in `active`, never the request's casing.
 *
 * Only the presence of a match is decided here — what to do about it (redirect, strip, neither) is
 * the caller's call, same division as `stripPageExtension`.
 *
 * @returns The matched locale code and the path with it removed, or null if the first segment isn't
 *   one of `active`'s codes
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
  const match = matchLocaleCode(firstSegment, locales.active)
  if (!match) {
    return null
  }
  const rest = '/' + segments.slice(2).join('/')
  return { locale: match, path: rest === '/' ? '/' : rest }
}

/**
 * Whether a page URL should be redirected to carry its site's forced locale prefix, and if so, where.
 *
 * A site with more than one active locale can require every page URL to name one up front
 * (`locales.forcePrefix`), so a link copied out of the address bar unambiguously encodes which
 * translation it points at. There is nothing to disambiguate with a single active locale, and a site
 * with `forcePrefix` off has chosen to leave its primary locale unprefixed — both cases return null
 * without even asking `stripLocalePrefix` whether the path already names one.
 *
 * @returns The path to redirect to (query string still needs reattaching, as with
 *   `stripPageExtension`'s result), or null if no redirect is warranted
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
  return `/${locales.primary}${urlPath === '/' ? '' : urlPath}`
}

/**
 * Whether a page URL carries a locale prefix it should not (or spells one wrong), and if so, where
 * to redirect.
 *
 * The other half of `localePrefixRedirectTarget`: that one ADDS the prefix `forcePrefix` requires;
 * this one REMOVES an explicit prefix the site's rules leave bare (`/en/page` and `/page` are
 * otherwise two URLs for the same document — the sitemap, hreflang and caches all want exactly
 * one), and re-cases a recognized-but-mis-cased prefix to the code as stored in `active`. Returns
 * null when the URL is already canonical.
 *
 * @returns The canonical path to redirect to (query string reattached by the caller), or null
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
    const canonical = `/${stripped.locale}${stripped.path === '/' ? '' : stripped.path}`
    return canonical === urlPath ? null : canonical
  }
  return stripped.path
}

/**
 * Whether a link addressed at `locale` should carry a locale segment, under a site's locale-prefix
 * rules.
 *
 * The link-building counterpart to `localePrefixRedirectTarget`'s redirect check, and the backend
 * mirror of the frontend's `shouldPrefixLocale` in `helpers/pagePaths.js`: the site's primary locale
 * is left unprefixed and every other active locale is prefixed, so a link built for the common case
 * -- the primary locale -- isn't cluttered with a code nobody chose to see. `forcePrefix` turns that
 * off and prefixes the primary locale too. There is nothing to disambiguate with a single active
 * locale (or none configured), same as `localePrefixRedirectTarget`, so that case never prefixes
 * either -- this is `active.length` standing in for the frontend's `useLocales` flag, which this
 * config shape has no field for.
 *
 * @param locale The link's own locale
 * @param locales The site's locale routing config
 */
export function shouldPrefixLocale(locale: string, locales?: LocaleRoutingConfig | null): boolean {
  if (!locales?.active || locales.active.length <= 1) {
    return false
  }
  return locale !== locales.primary || Boolean(locales.forcePrefix)
}

/**
 * Build a link to a bare page path, prefixed with its locale segment when `shouldPrefixLocale`
 * calls for one. The backend mirror of `localizedPagePath` in `frontend/src/helpers/pagePaths.js`,
 * and the inverse of `stripLocalePrefix`.
 *
 * @param path Bare page path, without a leading slash, as `pages.path` stores it
 * @param locale The path's own locale
 * @returns The slash-leading path to link to
 */
export function localizedPagePath(
  path: string,
  locale: string,
  locales?: LocaleRoutingConfig | null
): string {
  const bare = `/${path}`
  return shouldPrefixLocale(locale, locales) ? `/${locale}${bare}` : bare
}
