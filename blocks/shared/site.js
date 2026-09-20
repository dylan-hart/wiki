/**
 * The current site's id and locale config, and the current page's locale/path, for a block that has
 * neither threaded down to it -- markdown authors write props, not ids.
 *
 * **The one convention every block uses to reach the API and learn its site id**: `getSiteId()` plus
 * plain `fetch` against the public, hostname-routed `GET /_api/sites/current`, never
 * `globalThis.API_CLIENT` / `globalThis.WIKI_STATE`. Those SPA globals exist only inside the app
 * shell (`frontend/src/boot/externals.js`), so a block reading them cannot run in a context that
 * mounts blocks without one -- page-level pre-rendering, concretely. No gated route is ever called
 * from a reader's browser either.
 */

/** Holds the promise rather than the payload, so concurrent callers share one request. */
let sitePromise = null

/**
 * The single cache behind everything a block learns about the site it is read on -- `./config.js`
 * resolves its per-block config off this rather than keeping a second cache over the same request.
 * `null` for a request that failed or was refused, which every caller treats as "fall back to the
 * block's own defaults", not as the block breaking.
 *
 * @returns {Promise<object | null>}
 */
export function fetchSite() {
  if (!sitePromise) {
    sitePromise = fetch('/_api/sites/current')
      .then((resp) => (resp.ok ? resp.json() : null))
      .catch(() => {
        // A rejected fetch (offline, a dropped connection) is transient in a way a well-formed
        // non-ok response is not, so it must not wedge the cache shut for the page's whole life.
        sitePromise = null
        return null
      })
  }
  return sitePromise
}

export async function getSiteId() {
  const site = await fetchSite()
  return site?.id ?? null
}

/**
 * The site's locale-routing config -- the shape `Site#/properties/locales` documents
 * (`backend/api/schemas/site.ts`).
 */
export async function getSiteLocales() {
  const site = await fetchSite()
  return site?.locales ?? null
}

/**
 * The current page's locale and bare path, read off `location.pathname` -- the one thing a block CAN
 * know about its own page without asking the server. Only which locale codes are active has to come
 * from the server, to tell a locale-prefixed path (`/fr/some/page`) apart from an ordinary one.
 * Mirrors `parseLocalePrefix` in `frontend/src/helpers/pagePaths.js`, which a block cannot import
 * across workspaces.
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
 * There is no public, group-wide permission route a page's own reader could call, so this asks about
 * the page instead: `GET /_api/sites/:siteId/pages/:hash` is the same publicly-readable,
 * per-page-rule-checked route the page view loads a page through, and carries `viewer.permissions`
 * -- this reader's OWN page-rule permissions on THIS page, resolved server-side against their
 * session cookie. `null`/`[]` on any failure (no site, page not found, network error), so a block
 * guarding a control with this fails closed.
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
 * Test-only. The one reset hook for the one cache: `./config.js`'s readers go through `fetchSite()`
 * too, so this clears them as well.
 */
export function _resetSiteCache() {
  sitePromise = null
}
