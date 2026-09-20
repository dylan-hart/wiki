/**
 * A redirection is an ordinary page authored with the `redirect` editor: a path, a title and a place
 * in the tree, and nothing to read. Where it points is its content, as JSON — the backend's
 * `normalizeRedirectContent` (`models/pages.ts`) is the authority on that shape and refuses a save
 * that does not match it. This file is the same reading, in front of the author.
 */

import { localizedPagePath, parseLocalePrefix } from './pagePaths'

/**
 * Long enough to read one line and see where they are going, short enough that nobody waits on it.
 */
export const REDIRECT_INTERSTITIAL_MS = 2500

/**
 * Never throws: content that is missing or unparseable comes back as an empty redirection, which
 * the editor opens on and the page view reports as having nowhere to go.
 */
export function parseRedirect(content) {
  let parsed = null
  try {
    parsed = JSON.parse(content ?? '')
  } catch {
    // -> An empty redirection is the answer
  }
  return {
    kind: parsed?.kind === 'url' ? 'url' : 'page',
    target: typeof parsed?.target === 'string' ? parsed.target.trim() : '',
    showInterstitial: parsed?.showInterstitial === true
  }
}

export function serializeRedirect({ kind, target, showInterstitial } = {}) {
  return JSON.stringify({
    kind: kind === 'url' ? 'url' : 'page',
    target: (target ?? '').trim(),
    showInterstitial: showInterstitial === true
  })
}

/**
 * Page-kind targets only -- a URL-kind redirection has no page locale to carry.
 *
 * A target already carrying an active-locale prefix is left exactly as written: `LinkPickerDialog`
 * prefixes for the locale it was picked in, so the author addressed a specific translation and
 * re-prefixing would double up or override that choice. A bare slash-leading target has no locale
 * of its own to have meant, so it is localized to the reader's current one like any other in-app
 * link. A malformed target -- not even slash-leading -- passes through untouched: slicing a leading
 * slash that isn't there would eat a real character and mangle the caption a broken redirect shows,
 * and `isFollowable` refuses it either way.
 */
export function resolveRedirectTarget(target, activeLocaleCodes, currentLocale, siteLocales) {
  if (
    !target ||
    parseLocalePrefix(target, activeLocaleCodes, siteLocales?.aliases) ||
    !target.startsWith('/')
  ) {
    return target
  }
  return localizedPagePath(target.slice(1), currentLocale, siteLocales)
}

/**
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

/**
 * `isFollowable`'s kind-agnostic twin, for a single string that could be EITHER shape — a login/
 * logout redirect target, rather than a redirection page's own stored `{ kind, target }`. A rooted
 * path must not begin `//` or `/\`: both resolve to a scheme-relative, i.e. off-origin, URL.
 *
 * The frontend twin of `backend/helpers/redirectTarget.ts#isFollowableRedirectTarget`. A target the
 * backend validated on the way in is still re-checked here before `window.location.replace()`: that
 * guarantee covers only values written after the validation existed, and this is the sink a stale
 * one would otherwise reach unchecked. `new URL(value, base)` cannot decide this on its own — it
 * parses `javascript:…` without throwing (`.protocol` comes back `'javascript:'`), so a caller
 * asking only "did it parse" would let it through.
 */
export function isFollowableRedirectTarget(value) {
  const target = (value ?? '').trim()
  if (target.length < 1) {
    return false
  }
  if (/^https?:\/\/\S/i.test(target)) {
    return true
  }
  return target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\')
}
