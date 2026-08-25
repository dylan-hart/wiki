/**
 * Server-side validation for every field or query parameter that ends up in a `Location` header or a
 * `window.location` assignment: group/site login/logout redirect fields, the provider-login
 * `authorize` endpoint's `redirect` query parameter, and navigation item targets. The same rule
 * `frontend/src/helpers/pageRedirect.js#isFollowable` already enforces for a redirection PAGE's
 * stored target — this is that rule's server-side twin, for every OTHER place a redirect target is
 * accepted from a request rather than authored as page content.
 *
 * OpenProject #1360/#2208, 2026-08-24 security audit (`security/08-frontend-client.md` §2, §3, §6, §8,
 * §9): none of these sinks checked the scheme of what they were handed. `'//evil.example'.startsWith
 * ('/')` is `true`, and a browser normalizes a leading `/\` to `//` before resolving it, so a naive
 * "starts with a slash" check (what `api/authentication.ts`'s `authorize` route used) does not stop an
 * off-origin redirect; `javascript:` parses as a valid `URL` against any base, so a check that merely
 * constructs one and reads `.protocol` has to actually look at what it got back.
 */

/**
 * Whether `value` is safe to hand a browser as a same-origin navigation target: a rooted path that
 * does not begin `//` or `/\` (both resolve to a scheme-relative, i.e. off-origin, URL), or, when
 * `allowExternal` is true, a complete `http://`/`https://` URL to anywhere.
 *
 * `allowExternal` defaults to `true` — matching every current caller except the login/logout-redirect
 * fields, which pass `security.disallowOpenRedirect` as `!allowExternal` (see
 * `helpers/security.ts`'s callers) so an operator may deliberately allow those three fields to leave
 * the wiki's own origin, e.g. to land on an external identity provider's own logged-out page.
 *
 * Deliberately stricter than a bare `new URL(value, base)` parse: that would accept `javascript:` (a
 * `URL` happily parses one against any base — its `.protocol` just comes back `'javascript:'`, which
 * is exactly why every caller of this function must go through it rather than rolling their own
 * `try { new URL(...) } catch {}`), and would accept `//host/path` as "relative", which browsers
 * resolve to an absolute, off-origin URL rather than treating the leading `//` as two slashes of a
 * path.
 */
export function isFollowableRedirect(value: unknown, { allowExternal = true } = {}): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const target = value.trim()
  if (target.length < 1) {
    return false
  }
  if (allowExternal && /^https?:\/\/\S/i.test(target)) {
    return true
  }
  return target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\')
}
