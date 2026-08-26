/**
 * Whether a redirect target is safe to hand a browser: a rooted, same-origin path, or a complete
 * `http(s)` URL — nothing else.
 *
 * Mirrors `frontend/src/helpers/pageRedirect.js#isFollowable`'s rule, extended for a server-side
 * emitter: a leading `//` is an unambiguous scheme-relative URL, but a leading `/\` is *also* an
 * open redirect — browsers normalise it to `//` before ever treating it as a same-origin path — and
 * `isFollowable`'s own `startsWith('/')` check alone would wave both through. Anything that isn't a
 * complete `https?://` URL and isn't a rooted, non-`//`/`/\`-leading path is refused, `javascript:`
 * and `data:` included: neither starts with `/` or matches the URL pattern, so both fall through to
 * the final `false` with no scheme-specific check needed.
 */
export function isSafeRedirectTarget(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const trimmed = value.trim()
  if (trimmed.length < 1) {
    return false
  }
  if (/^https?:\/\/\S/i.test(trimmed)) {
    return true
  }
  return trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')
}

/**
 * Resolve a caller- or admin-supplied redirect target to something safe to emit as a `Location`
 * header, falling back to `fallback` (default `/`) when it isn't.
 */
export function sanitizeRedirectTarget(value: unknown, fallback = '/'): string {
  return isSafeRedirectTarget(value) ? value : fallback
}
