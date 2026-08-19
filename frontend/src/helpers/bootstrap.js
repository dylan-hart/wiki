/**
 * First path a genuine page navigation is not — everything under a leading `/_` is the app shell
 * itself rather than content (`/_admin`, `/_error` included) and needs no listing here. `/login` is
 * the one page-shaped exception, since it is the only way to obtain the session `/_admin` requires in
 * order to re-enable a disabled site — mirrors `SITE_RESOLUTION_EXEMPT_SEGMENTS` in `backend/index.ts`
 * exactly, and for the same reason: the fix path for a disabled or unknown site has to survive the
 * very thing it exists to correct.
 */
const EXEMPT_PATHS = new Set(['/login'])

/**
 * Where the site-error route guard in `App.vue` sends a navigation when the `bootstrap` request
 * itself has failed — or `null` when this navigation should be left alone.
 *
 * `GET /_api/bootstrap` (`backend/api/bootstrap.ts`) tells the two site-lifecycle failures apart by
 * status: `404` when no site answers this hostname at all, `403` when one does but has
 * `isEnabled === false` (see `guardSiteEnabled` in `backend/helpers/common.ts`). Anything else — a
 * network error, a `500` — has nothing more specific to say than whatever the current route already
 * renders, so this hands back `null` there too.
 *
 * A pure function so both the status mapping and the exemptions above can be tested without mounting
 * the app shell around them.
 *
 * @param path `to.path` from the route guard.
 * @param err  What `loadBootstrap()` caught — a `ky` `HTTPError`, or any other thrown value (a bare
 *             network failure has no `.response`).
 */
export function bootstrapFailureRedirectFor(path, err) {
  if (path.startsWith('/_') || EXEMPT_PATHS.has(path)) {
    return null
  }
  switch (err?.response?.status) {
    case 404:
      return '/_error/unknownsite'
    case 403:
      return '/_error/disabled'
    default:
      return null
  }
}
