import ky from 'ky'

import { useUserStore } from '@/stores/user'

/**
 * Request paths (relative to the `/_api` prefix) whose own 401 is an ordinary, expected answer
 * rather than the session having expired.
 *
 * The login route answers a bad password with a `400` (`ERR_LOGIN_FAILED`), not a `401`, and is
 * exempted defensively -- a `401` from the login screen's own request could only loop. A page's
 * unlock route genuinely does answer a wrong page password with a `401`, which
 * `PageUnlockDialog.vue` reports inline; redirecting would bounce the reader off the page they are
 * trying to unlock.
 */
const SESSION_EXPIRY_EXEMPT_PATH_PATTERNS = [/\/auth\/login$/, /\/pages\/[^/]+\/unlock$/]

/**
 * `url` must be a full URL, as ky's `beforeError` hook hands it via `request.url`. Exported so the
 * routing decision is testable with no `ky` or mounted app around it.
 */
export function isSessionExpiryUrl(url) {
  const { pathname } = new URL(url)
  return !SESSION_EXPIRY_EXEMPT_PATH_PATTERNS.some((pattern) => pattern.test(pathname))
}

/**
 * Left unhandled, `userStore` keeps showing the profile loaded at boot -- the header still says
 * signed in, the admin nav still renders -- right up until the next click fails the same way.
 *
 * A router push rather than a full reload, so state elsewhere in the SPA survives the trip;
 * `?redirect=` is what a plain form login returns the reader by. The already-guest guard covers a
 * second 401 racing in behind the first, and the `/login` one is a redundant loop guard -- the
 * exemption list above should already keep that path from reaching here.
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
 * Nothing is attached to a request beyond the session cookie: authentication is the
 * `__Host-wikiSession` cookie the server sets, sent because of `credentials`. API keys still use
 * bearer tokens, but those belong to callers outside this app.
 *
 * @param router Passed in rather than reached for as a singleton: `main.js` already builds one
 *               before this boots, and it is what makes the hook testable with a stub router and no
 *               mounted app.
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
