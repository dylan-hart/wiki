/**
 * Whether `value` is syntactically a valid `allowedOrigins` entry for a block credential: an
 * `http:`/`https:` origin (hostname or bracketed IPv6 literal, optional port) plus an optional path
 * prefix, with no query string or fragment -- e.g. `https://api.example.com/v1`.
 *
 * Mirrors `backend/helpers/network.ts`'s `isValidOriginPrefixPattern` (and, through it,
 * `originMatchesAllowlist`'s own matching rules) by hand rather than by import: `frontend/` and
 * `backend/` are independently-installed workspaces with no shared-code mechanism between them (see
 * root `CLAUDE.md`'s workspace layout), so this is the same "one canonical pattern, copied with a
 * pointer back to the source of truth" approach `siteValidation.js`'s `hostnamePattern` already uses
 * for the site-hostname schema. Keep the two definitions in sync by hand if either one changes
 * (OpenProject #2195/#2198).
 *
 * A bare hostname (no scheme) -- the old `allowedDomains` shape -- is rejected: it can never match
 * `originMatchesAllowlist`'s scheme+host+port comparison at resolve time.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidOriginPrefixPattern(value) {
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
//    authority (`new URL('http://[::1]/').hostname === '[::1]'`). Kept in sync with
//    `backend/helpers/network.ts`'s `DOMAIN_IPV6` (OpenProject #1099 follow-up, carried forward).
const domainIpv6 = '\\[(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\\]'

const originPattern = new RegExp(
  `^https?://(?:${domainHostname}|${domainIpv6})(?::[0-9]{1,5})?(?:/[^?#]*)?$`
)
