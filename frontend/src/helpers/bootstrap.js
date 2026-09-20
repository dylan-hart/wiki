/**
 * Page-shaped paths that survive a failed bootstrap. Everything under a leading `/_` is the app
 * shell rather than content and needs no listing; `/login` is the exception, being the only way to
 * obtain the session `/_admin` needs in order to re-enable a disabled site. Mirrors
 * `SITE_RESOLUTION_EXEMPT_SEGMENTS` in `backend/index.ts`: the fix path for a disabled or unknown
 * site has to survive the very thing it exists to correct.
 */
const EXEMPT_PATHS = new Set(['/login'])

/**
 * Where `App.vue`'s route guard sends a navigation when the `bootstrap` request itself failed, or
 * `null` to leave the navigation alone. `GET /_api/bootstrap` tells the two site-lifecycle failures
 * apart by status: `404` when no site answers this hostname at all, `403` when one does but is
 * disabled. Anything else — a network error, a `500` — has nothing more specific to say than
 * whatever the current route already renders.
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
