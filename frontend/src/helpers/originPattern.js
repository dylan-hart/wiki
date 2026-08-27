/**
 * Whether `value` is syntactically a valid `allowedDomains` entry for a block credential.
 *
 * Mirrors `backend/helpers/network.ts`'s `isValidOriginPattern` (and, through it,
 * `originMatchesAllowlist`'s own matching rules) by hand rather than by import: `frontend/` and
 * `backend/` are independently-installed workspaces with no shared-code mechanism between them (see
 * root `CLAUDE.md`'s workspace layout), so this is the same "one canonical pattern, copied with a
 * pointer back to the source of truth" approach `siteValidation.js`'s `hostnamePattern` already uses
 * for the site-hostname schema. Keep the two definitions in sync by hand if either one changes
 * (OpenProject #2185, replacing the hostname-only `domainPattern.js` this superseded).
 *
 * Accepts a full origin -- scheme (`http:`/`https:`), host (a plain hostname, a `*.`-prefixed
 * wildcard matching exactly one subdomain label -- the TLS-wildcard convention, or a `[`/`]`-bracketed
 * IPv6 literal), and an optional `:port` -- plus an optional path prefix, with no query string or
 * fragment (`https://api.example.com/v1` is valid, `https://api.example.com/v1?x=1` is not).
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidOriginPattern(value) {
  return originPattern.test(value)
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
