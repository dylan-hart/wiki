/* oxlint-disable no-console -- This IS the console wrapper `no-console` exists to funnel every other
   file through; the rule is on for all of `frontend/src` and this file is its single exemption. */

import { getActivePinia } from 'pinia'

/**
 * The scopes a frontend log line may carry — a short closed list, mirroring the backend's own
 * (`backend/core/logScopes.ts`, Epic #2643) where the two vocabularies happen to agree.
 *
 * Deliberately NOT imported from the backend: `frontend/` never imports from `backend/`, and the two
 * lists answer different questions — the backend's names subsystems a server operator reasons about,
 * this one names the parts of the app a developer with the console open is looking at.
 *
 * Closed, like the backend's: a new subsystem is a detail in the message or the error, never a
 * fifteenth scope.
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
 * Whether a `warn`/`debug` line should reach the console at all.
 *
 * Development always speaks. A production build stays quiet unless an administrator has turned the
 * site's `experimental` flag on — which is what lets someone diagnose a live instance without every
 * ordinary reader's console carrying the app's internal chatter.
 *
 * Read straight off pinia's own state tree rather than through `useFlagsStore()`, and deliberately
 * so: `stores/flags.js` logs through this helper, so importing its store here would be a module
 * cycle — and one with teeth, since resolving the flag would then run the store's own setup, which
 * can log, which asks for the flag again. `getActivePinia()` imports only pinia itself, instantiates
 * nothing, and answers the same question. A store that has never been created reads as `undefined`,
 * which is the same "no flag set" a freshly-created one would have answered.
 *
 * The `try`/`catch` covers the pre-boot window, where there is no pinia at all yet.
 *
 * @returns {boolean} True when the line should print
 */
function shouldSpeak() {
  if (import.meta.env.DEV) {
    return true
  }
  try {
    return getActivePinia()?.state?.value?.flags?.experimental === true
  } catch {
    // -> No pinia yet: before boot there is no flag to consult, and a production build's default is
    //    quiet
    return false
  }
}

/**
 * The console arguments one line becomes.
 *
 * The error is passed through as the object it is, never stringified and never `err.message`: that is
 * what gets the browser's own expandable stack rather than a single flattened line. `undefined` is
 * dropped rather than printed as a trailing `undefined`.
 *
 * @param {string} scope One of {@link LOG_SCOPES}
 * @param {string} message What was being attempted, as a lowercase fragment
 * @param {Array} rest The error, or whatever else the caller wanted alongside it
 * @returns {Array} The arguments to hand the console method
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
 * `[cardinal:<scope>] <message>`, then the error object itself. Three levels, two gates:
 *
 * - `error` always prints — something the reader will notice went wrong.
 * - `warn` and `debug` print in development, or when the site's `experimental` flag is on.
 *
 * Phrase the message as the lowercase fragment naming what was being attempted — "could not load the
 * site configuration", not "Failed to load the site configuration!" — and put the failure itself in
 * the error argument rather than interpolating `err.message` into the sentence.
 */
export const log = {
  /**
   * @param {string} scope One of {@link LOG_SCOPES}
   * @param {string} message What was being attempted
   * @param {Error|object} [err] The failure — or whatever else is worth inspecting — passed
   *   through unstringified
   */
  warn(scope, message, err) {
    if (!shouldSpeak()) {
      return
    }
    console.warn(...line(scope, message, [err]))
  },

  /**
   * @param {string} scope One of {@link LOG_SCOPES}
   * @param {string} message What was being attempted
   * @param {Error|object} [err] The failure — or whatever else is worth inspecting — passed
   *   through unstringified
   */
  error(scope, message, err) {
    console.error(...line(scope, message, [err]))
  },

  /**
   * @param {string} scope One of {@link LOG_SCOPES}
   * @param {string} message What happened
   * @param {...any} rest Anything worth inspecting alongside it
   */
  debug(scope, message, ...rest) {
    if (!shouldSpeak()) {
      return
    }
    console.debug(...line(scope, message, rest))
  }
}
