/**
 * Whether `value` is syntactically a valid `allowedOrigins` entry for a block credential.
 *
 * Mirrors `backend/helpers/network.ts`'s `isValidOriginPattern` (and, through it,
 * `originMatchesAllowlist`'s own matching rules) by hand rather than by import: `frontend/` and
 * `backend/` are independently-installed workspaces with no shared-code mechanism between them (see
 * root `CLAUDE.md`'s workspace layout), so this is the same "one canonical pattern, copied with a
 * pointer back to the source of truth" approach `siteValidation.js`'s `hostnamePattern` already uses
 * for the site-hostname schema. Keep the two definitions in sync by hand if either one changes
 * (OpenProject #2185/#2195, replacing the hostname-only `domainPattern.js` this superseded).
 *
 * Accepts a full origin -- scheme (`http:`/`https:`), host (a plain hostname, a `*.`-prefixed
 * wildcard matching exactly one subdomain label -- the TLS-wildcard convention, or a `[`/`]`-bracketed
 * IPv6 literal), and an optional `:port` -- plus an optional path prefix, with no query string or
 * fragment (`https://api.example.com/v1` is valid, `https://api.example.com/v1?x=1` is not).
 *
 * Deliberately narrower than what `new URL()` itself would accept: no userinfo (`user:pass@host`),
 * since that has no business in a stored allowlist entry and `URL`'s own parser would silently
 * accept and discard it (OpenProject #2198).
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidOriginPattern(value) {
  if (!originPattern.test(value)) {
    return false
  }
  try {
    const url = new URL(value)
    return !url.username && !url.password
  } catch {
    return false
  }
}

const domainLabel = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const domainHostname = `${domainLabel}(?:\\.${domainLabel})*`
// -> `[`/`]`-bracketed, matching how `URL.prototype.hostname` always renders an IPv6-literal
//    authority (`new URL('http://[::1]/').hostname === '[::1]'`) -- kept in sync with
//    `backend/helpers/network.ts`'s `DOMAIN_IPV6`.
const domainIpv6 = '\\[(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\\]'
const schemePattern = '[hH][tT][tT][pP][sS]?'

const originPattern = new RegExp(
  `^${schemePattern}:\\/\\/(?:${domainIpv6}|(?:\\*\\.)?${domainHostname})(?::[0-9]{1,5})?(?:\\/[^?#]*)?$`
)
