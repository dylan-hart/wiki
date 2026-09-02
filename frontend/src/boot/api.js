import ky from 'ky'

import { useUserStore } from '@/stores/user'

/**
 * Request paths (relative to the `/_api` prefix) whose own 401 is an ordinary, expected answer
 * rather than the session having expired -- handling either as a session expiry would misfire.
 *
 * `sites/:siteId/auth/login` answers a bad password with a `400` (`ERR_LOGIN_FAILED`), not a `401`
 * -- see `backend/api/auth/site.ts` -- but is exempted anyway as a defensive belt-and-braces
 * measure per OpenProject #2096, since a `401` from the login screen's own request is never a
 * session that just expired and redirecting it back to `/login` would only loop.
 *
 * `sites/:siteId/pages/:pageIdOrHash/unlock` genuinely does answer a wrong page password with a
 * `401` (`backend/api/pages/read.ts`), which `PageUnlockDialog.vue` reports inline as
 * `common.page.lockedWrongPassword` -- treating it as a session expiry would bounce the reader off
 * the very page they were trying to unlock instead of leaving the dialog up to try again.
 */
const SESSION_EXPIRY_EXEMPT_PATH_PATTERNS = [/\/auth\/login$/, /\/pages\/[^/]+\/unlock$/]

/**
 * Whether a 401 from `url` (the request's full URL, as ky's `beforeError` hook hands it via
 * `request.url`) should be treated as the session having expired, rather than left for the caller's
 * own `catch` to handle as an ordinary rejected-credentials answer.
 *
 * A pure function, exported so the routing decision is testable with no `ky` or mounted app around
 * it -- mirrors `bootstrapFailureRedirectFor` in `helpers/bootstrap.js`.
 */
export function isSessionExpiryUrl(url) {
  const { pathname } = new URL(url)
  return !SESSION_EXPIRY_EXEMPT_PATH_PATTERNS.some((pattern) => pattern.test(pathname))
}

/**
 * A session that was valid when this tab loaded, or when the reader last acted, no longer is -- some
 * `preHandler` on the backend answered a plain `401` to an otherwise ordinary request (OpenProject
 * #2096). Left unhandled, `userStore` keeps showing the profile loaded at boot -- the header still
 * says signed in, the admin nav still renders -- right up until the next click fails the same way.
 *
 * Patches the store back to guest and sends the reader to sign back in, carrying the page they were
 * on as `?redirect=` so a plain form login can return them to it -- a router push rather than a full
 * reload, so any state elsewhere in the SPA survives the trip. Nothing to do if this tab is already
 * showing as a guest (a second 401 racing in after the first already handled it) or is already on
 * `/login` (nothing under that path should ever reach here given the exemption above, but costs
 * nothing to guard against a redirect loop directly too).
 */
function handleSessionExpiry(router) {
  const userStore = useUserStore()
  if (!userStore.authenticated) {
    return
  }
  userStore.setToGuest()
  const current = router.currentRoute.value
  if (current.path === '/login') {
    return
  }
  router.push({ path: '/login', query: { redirect: current.fullPath } })
}

/**
 * The HTTP client every call to the API goes through, exposed as the `API_CLIENT` global.
 *
 * Nothing is attached to a request beyond the session cookie: authentication is the
 * `__Host-wikiSession` cookie the server sets, sent because of `credentials`. There used to be a
 * `beforeRequest` hook here
 * that refreshed a JWT and set an `Authorization` header — a leftover from when 3.x authenticated
 * with tokens. The user store it read has had no token since sessions replaced them, so the hook only
 * ever set an empty header. API keys still use bearer tokens, but those belong to callers outside
 * this app.
 *
 * @param router The app's router instance (see `main.js`), so a 401 for an already-established
 *               session can send the reader back to `/login` -- see `handleSessionExpiry`. Passed in
 *               rather than reached for as a singleton: `main.js` already builds one before this
 *               boots, and it is what makes the hook testable with a stub router and no mounted app.
 */
export function initializeApi(router) {
  const client = ky.create({
    prefix: '/_api',
    credentials: 'same-origin',
    throwHttpErrors: true,
    hooks: {
      beforeError: [
        ({ request, error }) => {
          if (error.response?.status === 401 && isSessionExpiryUrl(request.url)) {
            handleSessionExpiry(router)
          }
          return error
        }
      ]
    }
  })

  window.API_CLIENT = client
}
