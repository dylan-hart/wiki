/**
 * The current site's id, for blocks (`block-live-data`, the first).
 *
 * A block sitting in page content has no siteId of its own -- markdown authors write props, not
 * ids -- but a server-side-fetching block needs one to address `/_api/sites/:siteId/...`. Read off
 * the same public, hostname-routed `GET /_api/sites/current` `../shared/config.js`'s `getBlockConfig`
 * already uses, so a page needs no siteId threaded down to it and no gated route is ever called from
 * a reader's browser. Cached the same way and for the same reason: one request per page load, shared
 * by every block instance that asks.
 *
 * **This is the convention**: a block reaching the API or learning its site id uses `getSiteId()`
 * plus a bare `fetch` against the public, hostname-routed surface (this file and `./config.js`'s
 * `fetchSite()` are the two current examples) -- never `globalThis.API_CLIENT` /
 * `globalThis.WIKI_STATE`. Those SPA globals only exist inside the app shell; a block sitting in
 * transcluded content, a future standalone embed, or anywhere else the SPA never booted has no
 * access to them, while a public, hostname-routed `fetch` works everywhere a block can be placed.
 * `block-checklist`, `block-index` and `block-include` predate this decision and still read the
 * SPA globals directly -- converting them is tracked separately, not a license to add a fourth.
 *
 * The one case the public API has no equivalent for is a permission check --
 * `block-checklist`'s `WIKI_STATE.user.can('write:pages')` gate, for instance. Until a public,
 * anonymous-safe permissions endpoint exists, a block that genuinely needs one keeps reading
 * `globalThis.WIKI_STATE?.user?.can?.(...)` directly (optional-chained, since the global may be
 * absent outside the SPA) and treats an absent or `false` read as "not permitted" -- hiding or
 * disabling the gated control rather than throwing, so the block still renders, just without that
 * one affordance, anywhere the SPA globals aren't present. It does not fall back to `fetch` for
 * this one case, because there is nothing public to fetch.
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
 * Test-only: forgets the cached fetch, so a new `getSiteId` call issues a fresh request. Mirrors
 * `../shared/config.js`'s `_resetBlockConfigCache` for the same reason -- the module-level cache is
 * deliberate in production but would otherwise leak one test's mocked response into the next.
 */
export function _resetSiteIdCache() {
  siteIdPromise = null
}
