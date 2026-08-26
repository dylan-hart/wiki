/**
 * How a block learns its site id and its reader's locale -- the two bits of ambient context a block
 * embedded in page content has no props for, since markdown authors write props, not ids or locales.
 *
 * `getSiteId()` is for a server-side-fetching block that needs to address `/_api/sites/:siteId/...`
 * (`block-live-data`, the first; `block-index` and `block-include` since OpenProject #1975). Read off
 * the same public, hostname-routed `GET /_api/sites/current` `../shared/config.js`'s `getBlockConfig`
 * already uses, so a page needs no siteId threaded down to it and no gated route is ever called from
 * a reader's browser. Cached the same way and for the same reason: one request per page load, shared
 * by every block instance that asks.
 *
 * `currentPageLocation()` is for a block that needs the reader's own locale or page path -- see its
 * own doc comment below.
 */

/** Holds the promise, so concurrent callers across every block instance on the page share one request. */
let siteIdPromise = null

/**
 * @returns {Promise<string | null>} The current site's id, or `null` if the request failed.
 */
export async function getSiteId() {
  if (!siteIdPromise) {
    siteIdPromise = fetch('/_api/sites/current')
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((site) => site?.id ?? null)
      .catch(() => null)
  }
  return siteIdPromise
}

/**
 * The reader's current locale and bare page path, read off the browser's own URL.
 *
 * A block has no live page store to ask (that's `frontend/`'s `pageStore.locale`/`.path`, a separate
 * workspace this one cannot import) -- but a locale-routed URL already carries the same information in
 * its leading segment, so it is read back out the same way `parseLocalePrefix` in
 * `frontend/src/helpers/pagePaths.js` does for the app itself. Kept a plain function, not cached like
 * `getSiteId` above: reading `location.pathname` is synchronous and free, so there is nothing to share
 * across callers.
 *
 * @param {string[] | undefined} activeLocaleCodes The site's active locale codes, as `GET
 *   /_api/sites/current`'s `locales.active` returns them (bare codes, e.g. `['en', 'fr']`).
 * @returns {{ locale: string | null, path: string }} `path` has no leading slash and no locale
 *   prefix. `locale` is null when the URL's leading segment doesn't match one of `activeLocaleCodes`
 *   (an unprefixed path, or a site with no locale routing).
 */
export function currentPageLocation(activeLocaleCodes) {
  const segments = window.location.pathname.replace(/^\/+/, '').split('/')
  const first = segments[0] ?? ''
  const matched = first
    ? (activeLocaleCodes ?? []).find((code) => code.toLowerCase() === first.toLowerCase())
    : undefined
  return matched
    ? { locale: matched, path: segments.slice(1).join('/') }
    : { locale: null, path: segments.join('/') }
}

/**
 * Test-only: forgets the cached fetch, so a new `getSiteId` call issues a fresh request. Mirrors
 * `../shared/config.js`'s `_resetBlockConfigCache` for the same reason -- the module-level cache is
 * deliberate in production but would otherwise leak one test's mocked response into the next.
 */
export function _resetSiteIdCache() {
  siteIdPromise = null
}
