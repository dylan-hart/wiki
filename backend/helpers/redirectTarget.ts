/**
 * Whether a redirect target is safe to follow — the single rule shared by every server-side check
 * validating a group or site redirect target (login redirect, logout redirect, page-redirect stored
 * content, ...). Mirrors `frontend/src/helpers/pageRedirect.js#isFollowable`'s two branches folded
 * into one, since a redirect target isn't always tagged with a `kind` the way a stored page
 * redirection is — an external-login-redirect setting, say, is validated against this same rule with
 * no `kind` field to dispatch on.
 *
 * Accepts exactly two shapes, nothing else:
 *  - a rooted, same-origin path: starts with a single `/`, not `//` (protocol-relative — the browser
 *    resolves it against whatever scheme the current page happens to be on, so it's an off-site
 *    redirect with no scheme of its own to check) and not `/\` either (every major browser
 *    normalises a leading `/\` to `//` before the request is ever made, so `/\evil.example` is
 *    `//evil.example` in disguise);
 *  - a complete, absolute `http:` or `https:` URL — checked by actually constructing a `URL` and
 *    reading `.protocol`, not by testing the string's prefix. `frontend/src/App.vue`'s own scheme
 *    check (`/^[a-z][a-z0-9+.-]*:\/\//i`) matches ANY scheme followed by `//`, including
 *    `javascript://%0aalert(1)`: the `//` reads as a JS line comment and the decoded `%0a` newline
 *    ends it, so `javascript:` slips straight past a check that only inspects the prefix. Parsing
 *    the whole string with `URL` and checking the scheme it actually resolved to closes that gap —
 *    `javascript:`, `data:`, and everything else that isn't `http:`/`https:` is refused regardless of
 *    how the rest of the string is dressed up.
 *
 * @param target The redirect target as authored or stored — an in-app path or an absolute URL,
 *   depending on the caller. Leading/trailing whitespace is tolerated; anything else about the shape
 *   is not.
 */
export function isFollowableRedirectTarget(target: string | null | undefined): boolean {
  const value = (target ?? '').trim()
  if (value.length < 1) {
    return false
  }
  if (value.startsWith('/')) {
    return !value.startsWith('//') && !value.startsWith('/\\')
  }
  return isAbsoluteHttpUrl(value)
}

/**
 * Whether `value` parses as a complete, absolute `http:` or `https:` URL — the URL-only half of
 * {@link isFollowableRedirectTarget}, exported on its own for a caller that only ever expects a full
 * URL (never a same-origin path), so it doesn't have to route through the path-or-URL branching
 * above. See that function's doc comment for why this parses with `URL` rather than testing the
 * string's prefix.
 */
export function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}
