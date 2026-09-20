/**
 * The server's own message when it sent one — every `/_api` failure comes back as
 * `{ ok, error, statusCode, message }` — and ky's description of the request otherwise.
 *
 * Read off `err.data`, never `err.response`: ky parses the body to fill `data` before it throws, and
 * that consumes the stream, so `err.response.json()` rejects with "Body has already been read". A
 * call site that catches and discards that cannot tell it from a response with no message, and
 * replaces the server's explanation with ky's generic "Request failed with status code 503".
 */
export function apiErrorMessage(err, fallback) {
  return err?.data?.message || err?.message || fallback
}

/** Same `err.data`, not `err.response`, rule as {@link apiErrorMessage}. */
export function apiErrorBody(err) {
  return err?.data
}
