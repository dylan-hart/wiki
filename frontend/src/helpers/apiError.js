/**
 * The message a failed API request should be reported with.
 *
 * The server's own, when it sent one — every `/_api` failure comes back as
 * `{ ok, error, statusCode, message }` — and ky's description of the request otherwise, which is all
 * there is for a failure that never reached a route.
 *
 * Read off `err.data`, never `err.response`: ky parses the body itself to fill `data` before it throws,
 * and that consumes it, so `err.response.json()` fails with "Body has already been read". Caught and
 * discarded — as it was everywhere this replaces — that failure is indistinguishable from a response
 * with no message, and the server's explanation gets quietly replaced by ky's generic "Request failed
 * with status code 503". Which is why a wrong password, a name already taken and a missing extension
 * all used to read the same.
 *
 * Synchronous, unlike the per-file helpers it replaces: with the body already parsed there is nothing
 * left to wait for, so callers read it straight out of the catch.
 *
 * @param {Error} err The thrown error — ky's `HTTPError`, or anything else that reached the catch
 * @param {string} [fallback] Shown when neither the server nor ky offered anything
 * @returns {string|undefined} What to put in front of the user
 */
export function apiErrorMessage(err, fallback) {
  return err?.data?.message || err?.message || fallback
}

/**
 * The parsed response body a failed API request came with, if any.
 *
 * Same `err.data`, not `err.response`, rule as {@link apiErrorMessage}: ky has already parsed the
 * body into `data` before throwing, and `err.response`'s own body stream is already consumed by
 * then, so a call site reaching for `err.response.json()` gets a rejected promise (or, if awaited
 * and swallowed, silently reads as `undefined`) instead of the envelope the server actually sent.
 *
 * @param {Error} err The thrown error — ky's `HTTPError`, or anything else that reached the catch
 * @returns {object|undefined} The server's parsed JSON body, when there was one
 */
export function apiErrorBody(err) {
  return err?.data
}
