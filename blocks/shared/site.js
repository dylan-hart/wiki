/**
 * The current site's id and locale config, and the current page's locale/path -- for a block that
 * has neither threaded down to it (OpenProject #1969).
 *
 * A block sitting in page content has no siteId of its own -- markdown authors write props, not
 * ids -- but a server-side-fetching block needs one to address `/_api/sites/:siteId/...`. Read off
 * the same public, hostname-routed `GET /_api/sites/current` `../shared/config.js`'s `getBlockConfig`
 * already uses, so a page needs no siteId threaded down to it and no gated route is ever called from
 * a reader's browser. Cached the same way and for the same reason: one request per page load, shared
 * by every block instance that asks.
 *
 * **This is the one convention every block uses to reach the API and learn its site id** --
 * `getSiteId()` plus plain `fetch`, never `globalThis.API_CLIENT` / `globalThis.WIKI_STATE`. Those
 * SPA globals exist only inside the app shell (`frontend/src/boot/externals.js`); a block that reads
 * them cannot run in a context that mounts blocks without it -- the page-level pre-rendering
 * `docs/variances.md` describes as a future task, concretely. `block-live-data` and `block-map`
 * (via `../shared/config.js`) were the first to follow this; `block-index` and `block-include`
 * (OpenProject #1975) were converted to it, and so was `block-checklist` (#1978) for its site id,
 * page id and data fetching.
 *
 * The one thing this convention does NOT cover is a signed-in reader's own permissions.
 * `block-checklist`'s "may I check an item off" control used to read `WIKI_STATE.user.can(...)`,
 * which has no public equivalent -- there is no `GET /_api/users/me/permissions` a page's own reader
 * could call without a gate of some kind. Its public equivalent instead is **the page itself**:
 * `GET /_api/sites/:siteId/pages/:hash` is the same publicly-readable, per-page-rule-checked route
 * the page view itself loads a page through, and its response already carries
 * `viewer.permissions` -- the reader's OWN page-rule permissions on THIS page, resolved server-side
 * against their session cookie, not something a block would have to ask a gated, group-wide route
 * for. `getCurrentPageAccess()` below resolves it. A block that needs a permission with no page-rule
 * equivalent at all -- there is none of that shape yet -- has no convention to follow here and should
 * get one written down before landing, the same way this file's history did.
 */

/** The site-info payload, once fetched. Holds the promise, so concurrent callers share one request. */
let sitePromise = null

/**
 * The public site-info payload, fetched at most once per page load.
 *
 * The single cache behind everything a block learns about the site it is being read on: its id and
 * locales (below), and its per-block config and blocks index (`./config.js`, which imports this
 * rather than keeping a second cache over the same request -- BLK-F5). A page with a map and a
 * checklist on it asks the server for this once, not once per module that wants a piece of it.
 *
 * `null` for a request that failed or was refused: every caller here treats a missing payload as the
 * block falling back to its own defaults, not as the block breaking.
 *
 * @returns {Promise<object | null>}
 */
export function fetchSite() {
  if (!sitePromise) {
    sitePromise = fetch('/_api/sites/current')
      .then((resp) => (resp.ok ? resp.json() : null))
      .catch(() => {
        // Don't let a transient failure (offline, a dropped connection) poison every later
        // caller on the page for good -- clear the cache so the next call gets a fresh fetch.
        sitePromise = null
        return null
      })
  }
  return sitePromise
}

/**
 * @returns {Promise<string | null>} The current site's id, or `null` if the request failed.
 */
export async function getSiteId() {
  const site = await fetchSite()
  return site?.id ?? null
}

/**
 * The site's locale-routing config -- the same shape `Site#/properties/locales` documents
 * (`backend/api/schemas/site.ts`): `{ primary, active, forcePrefix, showMenu }`.
 *
 * @returns {Promise<{ primary?: string, active?: string[], forcePrefix?: boolean, showMenu?: boolean } | null>}
 */
export async function getSiteLocales() {
  const site = await fetchSite()
  return site?.locales ?? null
}

/**
 * The current page's locale and bare path, read off the browser's own address bar rather than a
 * store this block has no access to.
 *
 * This IS knowable without asking the server -- the reader is looking at this page, and its URL is
 * right there in `location.pathname`. The only thing the server has to say is which locale codes are
 * active, to tell a locale-prefixed path (`/fr/some/page`) apart from an ordinary one -- mirrors
 * `parseLocalePrefix` in `frontend/src/helpers/pagePaths.js`, which a block cannot import (a
 * separate, unrelated-at-build-time workspace). A path segment is decoded, the way a real page path
 * with non-ASCII or space characters shows up URL-encoded in `location.pathname`.
 *
 * @returns {Promise<{ locale: string | null, path: string }>}
 */
export async function getCurrentPage() {
  const locales = await getSiteLocales()
  const active = locales?.active ?? []
  const segments = location.pathname.split('/').map(decodeURIComponent)
  const first = segments[1] ?? ''
  const matched = active.find((code) => code.toLowerCase() === first.toLowerCase())
  return {
    locale: matched ?? locales?.primary ?? null,
    path: (matched ? segments.slice(2) : segments.slice(1)).join('/')
  }
}

/**
 * Fast, non-cryptographic 53-bit hash of a page path, as a URL-safe hex string.
 *
 * Mirrors `generatePathHash` in the backend's `helpers/common.ts` and `pagePathHash` in the
 * frontend's `helpers/pagePaths.js` bit for bit -- a page is addressed by this hash
 * (`GET sites/:siteId/pages/:pageIdOrHash`), so all three must stay in lockstep. The caller
 * normalizes the path first; this only hashes whatever string it is given.
 */
function pagePathHash(path, seed = 0) {
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
 * The current page's own id and this reader's page-rule permissions on it -- the public equivalent
 * of `WIKI_STATE.page.id` plus `WIKI_STATE.user.can(...)` (see this file's header).
 *
 * Resolves the page addressed by the current URL through the same route the page view itself loads
 * a page through (`GET /_api/sites/:siteId/pages/:hash`), which is readable without a session and
 * carries `viewer.permissions` -- this reader's own page-rule permissions on this exact page, checked
 * server-side against their session cookie. `null`/`[]` on any failure (no site, page not found, or a
 * network error): a block guarding a control with this should fail closed, the same way a missing
 * `WIKI_STATE` used to leave `_canCheck` false.
 *
 * @returns {Promise<{ siteId: string | null, pageId: string | null, permissions: string[] }>}
 */
export async function getCurrentPageAccess() {
  const [siteId, current] = await Promise.all([getSiteId(), getCurrentPage()])
  if (!siteId) {
    return { siteId: null, pageId: null, permissions: [] }
  }
  const params = new URLSearchParams()
  if (current.locale) {
    params.set('locale', current.locale)
  }
  try {
    const resp = await fetch(
      `/_api/sites/${siteId}/pages/${pagePathHash(current.path || 'home')}?${params}`
    )
    if (!resp.ok) {
      return { siteId, pageId: null, permissions: [] }
    }
    const page = await resp.json()
    return { siteId, pageId: page.id, permissions: page.viewer?.permissions ?? [] }
  } catch {
    return { siteId, pageId: null, permissions: [] }
  }
}

/**
 * Test-only: forgets the cached site-info fetch, so the next call issues a fresh request.
 *
 * The one reset hook for the one cache -- `./config.js`'s `getBlockConfig`/`getBlockImportUrl` read
 * off the same `fetchSite()` above, so this clears them too. The module-level cache is deliberate in
 * production but would otherwise leak one test's mocked response into the next.
 */
export function _resetSiteCache() {
  sitePromise = null
}
