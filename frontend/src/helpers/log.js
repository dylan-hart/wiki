/* oxlint-disable no-console -- This IS the console wrapper `no-console` exists to funnel every other
   file through; the rule is on for all of `frontend/src` and this file is its single exemption. */

import { getActivePinia } from 'pinia'

/**
 * Deliberately not shared with the backend's own scope list: `frontend/` never imports from
 * `backend/`, and the two answer different questions — the backend's names subsystems a server
 * operator reasons about, this one names the parts of the app a developer with the console open is
 * looking at. Closed, like the backend's: a new subsystem is a detail in the message or the error,
 * never another scope.
 */
export const LOG_SCOPES = [
  'api',
  'auth',
  'page',
  'site',
  'editor',
  'collab',
  'nav',
  'search',
  'graph',
  'dialog',
  'app',
  'analytics',
  'locale',
  'flags'
]

const SCOPES = new Set(LOG_SCOPES)

/**
 * A production build stays quiet unless an administrator has turned the site's `experimental` flag
 * on, so a live instance stays diagnosable without every ordinary reader's console carrying the
 * app's internal chatter.
 *
 * The flag is read off pinia's state tree rather than through `useFlagsStore()`: `stores/flags.js`
 * logs through this helper, so instantiating its store here would be a module cycle whose setup can
 * log, which asks for the flag again. A store that was never created reads as `undefined`, the same
 * "no flag set" a freshly-created one answers.
 */
function shouldSpeak() {
  if (import.meta.env.DEV) {
    return true
  }
  try {
    return getActivePinia()?.state?.value?.flags?.experimental === true
  } catch {
    // -> No pinia before boot, so no flag to consult; a production build's default is quiet
    return false
  }
}

/**
 * The error is passed through as the object it is, never stringified and never `err.message`: that
 * is what gets the browser's own expandable stack rather than a single flattened line.
 */
function line(scope, message, rest) {
  if (import.meta.env.DEV && !SCOPES.has(scope)) {
    console.warn(`[cardinal:app] log() called with an unknown scope: ${scope}`)
  }
  return [`[cardinal:${scope}] ${message}`, ...rest.filter((entry) => entry !== undefined)]
}

/**
 * The one way `frontend/src` writes to the console.
 *
 * Phrase the message as the lowercase fragment naming what was being attempted — "could not load the
 * site configuration", not "Failed to load the site configuration!" — and put the failure itself in
 * the error argument rather than interpolating `err.message` into the sentence.
 */
export const log = {
  warn(scope, message, err) {
    if (!shouldSpeak()) {
      return
    }
    console.warn(...line(scope, message, [err]))
  },

  error(scope, message, err) {
    console.error(...line(scope, message, [err]))
  },

  debug(scope, message, ...rest) {
    if (!shouldSpeak()) {
      return
    }
    console.debug(...line(scope, message, rest))
  }
}
