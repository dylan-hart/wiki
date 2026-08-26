/**
 * The current site's id, for blocks (`block-live-data`, the first).
 *
 * A block sitting in page content has no siteId of its own -- markdown authors write props, not
 * ids -- but a server-side-fetching block needs one to address `/_api/sites/:siteId/...`. Read off
 * the same public, hostname-routed `GET /_api/sites/current` `../shared/config.js`'s `getBlockConfig`
 * already uses, so a page needs no siteId threaded down to it and no gated route is ever called from
 * a reader's browser. Cached the same way and for the same reason: one request per page load, shared
 * by every block instance that asks.
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
      .catch(() => {
        // Don't let a transient failure (offline, a dropped connection) poison every later
        // caller on the page for good -- clear the cache so the next call gets a fresh fetch.
        siteIdPromise = null
        return null
      })
  }
  return siteIdPromise
}

/**
 * Test-only: forgets the cached fetch, so a new `getSiteId` call issues a fresh request. Mirrors
 * `../shared/config.js`'s `_resetBlockConfigCache` for the same reason -- the module-level cache is
 * deliberate in production but would otherwise leak one test's mocked response into the next.
 */
export function _resetSiteIdCache() {
  siteIdPromise = null
}
