/**
 * What a redirection page holds instead of a body.
 *
 * A redirection is an ordinary page authored with the `redirect` editor: it has a path, a title and a
 * place in the tree, and nothing to read. Where it points is its content, as JSON — see
 * `normalizeRedirectContent` in the backend's `models/pages.ts`, which is the authority on the shape
 * and refuses a save that does not match it. This file is the same reading, in front of the author:
 * the editor round-trips through it, and the page view follows what it returns.
 */

import { localizedPagePath, parseLocalePrefix } from './pagePaths'

/**
 * How long the interstitial is shown before the reader is taken on, in milliseconds.
 *
 * Long enough to read one line and see where they are going, short enough that nobody waits on it.
 */
export const REDIRECT_INTERSTITIAL_MS = 2500

/** An empty redirection, which is what a page being created starts as. */
export function emptyRedirect() {
  return { kind: 'page', target: '', showInterstitial: false }
}

/**
 * Read a stored redirection. Never throws: content that is missing or unparseable comes back as an
 * empty redirection, which the editor opens on and the page view reports as having nowhere to go.
 */
export function parseRedirect(content) {
  let parsed = null
  try {
    parsed = JSON.parse(content ?? '')
  } catch {
    // -> An empty redirection is the answer; see above
  }
  return {
    kind: parsed?.kind === 'url' ? 'url' : 'page',
    target: typeof parsed?.target === 'string' ? parsed.target.trim() : '',
    showInterstitial: parsed?.showInterstitial === true
  }
}

/** The canonical spelling of a redirection, which is what gets saved. */
export function serializeRedirect({ kind, target, showInterstitial } = {}) {
  return JSON.stringify({
    kind: kind === 'url' ? 'url' : 'page',
    target: (target ?? '').trim(),
    showInterstitial: showInterstitial === true
  })
}

/**
 * Resolve a parsed page-kind redirection's `target` to what should actually be followed and shown --
 * either left exactly as authored, or, for a bare in-app path with no locale prefix of its own,
 * localized to the reader's current locale.
 *
 * `PageRedirect.vue`'s only caller: pulled out here so the one tricky case (a malformed, non-slash-
 * leading stored target) has a unit test rather than only a component one. The author picks a target
 * through `LinkPickerDialog`, which already prefixes it for the locale it was chosen in -- so a target
 * that already carries an active-locale prefix (`parseLocalePrefix` matches it) is left exactly as
 * written; the author addressed a specific translation, and re-prefixing it would double up or
 * override that choice. A bare, WELL-FORMED target (slash-leading, no locale prefix -- content saved
 * before locale scoping existed, or written by hand) has no locale of its own to have meant, so it is
 * localized to the reader's current locale, the same rule any other in-app link in this app follows.
 * A MALFORMED target -- doesn't even start with `/` -- is passed through completely untouched:
 * stripping a leading slash that isn't there would eat a real character and mangle the diagnostic
 * caption a broken redirect shows for it, and `isFollowable` already refuses to follow anything that
 * doesn't start with `/`, so leaving it as-is changes nothing about whether it's followed.
 *
 * A URL-kind redirection has no page locale to carry and is never passed through this.
 *
 * @param target The parsed redirection's own `target` (`parseRedirect(...).target`)
 * @param activeLocaleCodes The site's active locale codes, as `parseLocalePrefix` takes them
 * @param currentLocale The locale to localize an unprefixed bare target into
 * @param siteLocales The site's locale routing config, as `localizedPagePath` takes it
 */
export function resolveRedirectTarget(target, activeLocaleCodes, currentLocale, siteLocales) {
  if (!target || parseLocalePrefix(target, activeLocaleCodes) || !target.startsWith('/')) {
    return target
  }
  return localizedPagePath(target.slice(1), currentLocale, siteLocales)
}

/**
 * Whether a redirection can actually be followed.
 *
 * The same two rules the server enforces: a page target is a rooted path within this wiki, and a URL
 * target is a complete `http(s)` address — anything else is either not a destination or, for
 * `javascript:`, a link nobody chose to follow.
 */
export function isFollowable({ kind, target } = {}) {
  const value = (target ?? '').trim()
  if (value.length < 1) {
    return false
  }
  return kind === 'url'
    ? /^https?:\/\/\S/i.test(value)
    : value.startsWith('/') && !value.startsWith('//')
}
