/**
 * Mirrors the backend's `normalizePagePath` (`helpers/common.ts`), so a path typed into a dialog is
 * corrected in front of the person typing it rather than silently changed by the server after they
 * hit save. Settles casing and spacing only; whether the result is *allowed* is each field's rule.
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
 * The home path is a convention, never a configurable field: `''` is the tree root's placeholder
 * before a real path is chosen, and `home` is where a freshly-seeded site's root page lands. Both
 * count, so a guard catches anyone about to delete or move the page every visitor lands on.
 */
export function isHomePath(path) {
  return path === '' || path === 'home'
}

/**
 * Mirrors the backend's `generatePathHash` (`helpers/common.ts`) bit for bit — a page is addressed
 * by this hash (`GET sites/:siteId/pages/:pageIdOrHash`), so the two must never drift apart. Hashes
 * whatever string it is given; callers normalize first with `normalizePagePath`.
 */
export function pagePathHash(path, seed = 0) {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < path.length; i++) {
    const ch = path.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/**
 * The server redirects these too, but a link inside page content is followed by the router without
 * ever asking it — so `/foo/bar.md` written into a page has to resolve to `/foo/bar` here as well.
 * Mirrors the backend's `stripPageExtension` (`helpers/common.ts`).
 *
 * @param extensions Lowercase and without the dot, as `siteStore.pageExtensions` holds them
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
 * A locale-prefixed URL (`/fr/some/page`) and an ordinary one (`/some/page`) are the same shape,
 * and the router's catch-all matches both alike, so the app has to decide for itself which it has
 * before treating the rest as a page path. Matching is case-insensitive (`/FR/page` counts), but
 * the code returned is always the one as stored in `activeLocaleCodes`, never the request's casing.
 * An alias is tried before the canonical code, so a link `localizedPagePath` emits always parses
 * back; the returned code is the canonical one. Mirrors the backend's `stripLocalePrefix`
 * (`helpers/localeRouting.ts`).
 */
export function parseLocalePrefix(path, activeLocaleCodes, aliases) {
  if (!activeLocaleCodes?.length) {
    return null
  }
  const segments = path.split('/')
  const firstSegment = segments[1] ?? ''
  if (!firstSegment) {
    return null
  }
  const match =
    matchLocaleAlias(firstSegment, activeLocaleCodes, aliases) ??
    matchLocaleCode(firstSegment, activeLocaleCodes)
  if (!match) {
    return null
  }
  const rest = '/' + segments.slice(2).join('/')
  return { locale: match, path: rest === '/' ? '/' : rest }
}

export function matchLocaleCode(candidate, activeLocaleCodes) {
  if (!candidate || !activeLocaleCodes?.length) {
    return null
  }
  return activeLocaleCodes.find((code) => code.toLowerCase() === candidate.toLowerCase()) ?? null
}

export function matchLocaleAlias(candidate, activeLocaleCodes, aliases) {
  if (!candidate || !activeLocaleCodes?.length || !aliases) {
    return null
  }
  const lower = candidate.toLowerCase()
  for (const [code, alias] of Object.entries(aliases)) {
    if (alias && alias.toLowerCase() === lower) {
      const active = matchLocaleCode(code, activeLocaleCodes)
      if (active) {
        return active
      }
    }
  }
  return null
}

export function localeUrlSegment(locale, aliases) {
  const alias = aliases?.[locale]
  if (alias) {
    return alias
  }
  const key = Object.keys(aliases ?? {}).find((k) => k.toLowerCase() === locale?.toLowerCase())
  return (key && aliases[key]) || locale
}

/**
 * Resolves `pageStore.locale` for a navigation, before the page itself is known.
 *
 * An app route (anything starting `/_`) is not a page and has no locale segment to read, with one
 * exception: `/_create` writes a NEW page, defaulting to the locale of the page the reader was just
 * looking at. That locale has nowhere else to travel — the route names an editor, not a page — so
 * `pageStore.pageCreate` carries it forward as `?locale=` on the URL it pushes. Every other app
 * route has no reader-facing locale, so an absent or unrecognized query value falls back to the
 * site's primary exactly as an unprefixed path does.
 */
export function resolveRouteLocale(path, query, activeLocaleCodes, primary, aliases) {
  if (path.startsWith('/_')) {
    return matchLocaleCode(query?.locale, activeLocaleCodes) ?? primary
  }
  return parseLocalePrefix(path, activeLocaleCodes, aliases)?.locale ?? primary
}

/**
 * The link-building side of the server's `localePrefixRedirectTarget`: the primary locale is left
 * unprefixed so a link for the common case is not cluttered with a code nobody chose to see, and
 * `forcePrefix` turns that off so every link unambiguously names which translation it points at.
 *
 * @param locale The link's own locale -- not necessarily the reader's current one, e.g. a breadcrumb
 *   built from a page loaded in a locale other than the site's default
 * @param siteLocales `{ useLocales, primary, forcePrefix, aliases }`, from `siteStore`
 */
export function shouldPrefixLocale(locale, siteLocales) {
  if (!siteLocales?.useLocales) {
    return false
  }
  return locale !== siteLocales.primary || Boolean(siteLocales.forcePrefix)
}

/**
 * @param path Bare page path, with no leading slash, as `pageStore.path` / `item.path` /
 *   `node.path` store it
 * @param siteLocales `{ useLocales, primary, forcePrefix, aliases }`, from `siteStore`
 */
export function localizedPagePath(path, locale, siteLocales) {
  const bare = `/${path}`
  return shouldPrefixLocale(locale, siteLocales)
    ? `/${localeUrlSegment(locale, siteLocales.aliases)}${bare}`
    : bare
}
