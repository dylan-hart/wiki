/**
 * Hand-mirrored from `backend/helpers/network.ts`'s `isValidOriginPattern`: `frontend/` and
 * `backend/` are independently-installed workspaces with no shared-code mechanism, so the two
 * definitions have to be kept in sync by hand.
 *
 * A `*.` host prefix matches exactly one subdomain label -- the TLS-wildcard convention.
 * Deliberately narrower than `new URL()`: userinfo (`user:pass@host`) has no business in a stored
 * allowlist entry, and `URL`'s own parser would silently accept and discard it.
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
// -> Bracketed, matching how `URL.prototype.hostname` always renders an IPv6-literal authority
//    (`new URL('http://[::1]/').hostname === '[::1]'`).
const domainIpv6 = '\\[(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\\]'
const schemePattern = '[hH][tT][tT][pP][sS]?'

const originPattern = new RegExp(
  `^${schemePattern}:\\/\\/(?:${domainIpv6}|(?:\\*\\.)?${domainHostname})(?::[0-9]{1,5})?(?:\\/[^?#]*)?$`
)
