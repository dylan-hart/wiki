/**
 * The one spelling a page path has.
 *
 * Mirrors `normalizePagePath` in the backend's `helpers/common.ts`, so that a path typed into a
 * dialog is corrected in front of the person typing it rather than silently changed by the server
 * after they hit save. Whether what comes out is *allowed* is still each field's own rule — this only
 * settles casing and spaces.
 */
export function normalizePagePath(input) {
  return (input ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replaceAll(/\s+/g, '-')
    .toLowerCase()
}

/**
 * Drop a site's page extension from the end of a URL path.
 *
 * The server redirects these too, but a link inside page content is followed by the router without
 * ever asking it — so `/foo/bar.md` written into a page has to resolve to `/foo/bar` here as well.
 * Mirrors `stripPageExtension` in the backend's `helpers/common.ts`.
 *
 * @param extensions Lowercase and without the dot, as `siteStore.pageExtensions` holds them
 * @returns The path without the extension, or null if it does not end in one of them
 */
export function stripPageExtension(urlPath, extensions) {
  if (!extensions?.length) {
    return null
  }
  const dot = urlPath.lastIndexOf('.')
  if (dot < 1 || urlPath[dot - 1] === '/' || urlPath.lastIndexOf('/') > dot) {
    return null
  }
  if (!extensions.includes(urlPath.slice(dot + 1).toLowerCase())) {
    return null
  }
  return urlPath.slice(0, dot)
}

/**
 * Split the recognized leading locale segment off a URL path.
 *
 * Mirrors `stripLocalePrefix` in the backend's `helpers/common.ts` — a locale-prefixed URL
 * (`/fr/some/page`) and an ordinary one (`/some/page`) are the same shape, and the only thing that
 * tells them apart is whether the first segment happens to be one of the site's active locale codes.
 * The router's catch-all route matches both alike, so the app has to make this call itself before it
 * can treat the rest of the path as a page path. Matching is case-insensitive (`/FR/page` still
 * counts), but the code returned is always the one as stored in `activeLocaleCodes`, never the
 * request's casing.
 *
 * Takes the bare code list rather than the full `locales` config object the backend helper does,
 * since the frontend already keeps `siteStore.locales.active` as descriptor objects — the caller
 * maps those down to codes once, rather than this helper reaching into a shape it does not need.
 *
 * @param activeLocaleCodes The site's active locale codes, as `siteStore.locales.active` stores them
 * @returns The matched locale code and the path with it removed, or null if the first segment isn't
 *   one of `activeLocaleCodes`
 */
export function parseLocalePrefix(path, activeLocaleCodes) {
  if (!activeLocaleCodes?.length) {
    return null
  }
  const segments = path.split('/')
  const firstSegment = segments[1] ?? ''
  if (!firstSegment) {
    return null
  }
  const match = activeLocaleCodes.find((code) => code.toLowerCase() === firstSegment.toLowerCase())
  if (!match) {
    return null
  }
  const rest = '/' + segments.slice(2).join('/')
  return { locale: match, path: rest === '/' ? '/' : rest }
}

/**
 * Whether a link addressed at `locale` should carry a locale segment, under a site's locale-prefix
 * rules.
 *
 * Mirrors the decision `localePrefixRedirectTarget` makes server-side, but as a link-building
 * question rather than a redirect check: the site's PRIMARY locale is left unprefixed and every
 * other active locale is prefixed, so that a link generated for the common case -- reading the
 * primary locale -- is not cluttered with a code nobody chose to see. `forcePrefix` turns that off
 * and prefixes the primary locale too, so every link the site hands out unambiguously names which
 * translation it points at. A site with only one active locale (`useLocales` false) never prefixes --
 * there is nothing to disambiguate.
 *
 * @param locale The link's own locale -- not necessarily the reader's current one, e.g. a breadcrumb
 *   built from a page loaded in a locale other than the site's default
 * @param siteLocales `{ useLocales, primary, forcePrefix }`, the fields of `siteStore` this depends
 *   on -- taken apart rather than the whole store so this stays a pure function
 */
export function shouldPrefixLocale(locale, siteLocales) {
  if (!siteLocales?.useLocales) {
    return false
  }
  return locale !== siteLocales.primary || Boolean(siteLocales.forcePrefix)
}

/**
 * Build an in-app link to a bare page path, prefixed with its locale segment when
 * `shouldPrefixLocale` calls for one.
 *
 * The inverse of `parseLocalePrefix`.
 *
 * @param path Bare page path, with no leading slash, as `pageStore.path` / `item.path` / `node.path`
 *   store it
 * @param locale The path's own locale -- see `shouldPrefixLocale`
 * @param siteLocales `{ useLocales, primary, forcePrefix }` -- see `shouldPrefixLocale`
 * @returns The slash-leading path to link to
 */
export function localizedPagePath(path, locale, siteLocales) {
  const bare = `/${path}`
  return shouldPrefixLocale(locale, siteLocales) ? `/${locale}${bare}` : bare
}
