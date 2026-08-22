/**
 * Whether `value` is syntactically a valid `allowedDomains` entry for a block credential.
 *
 * Mirrors `backend/helpers/network.ts`'s `isValidDomainPattern` (and, through it,
 * `hostnameMatchesAllowlist`'s own matching rules) by hand rather than by import: `frontend/` and
 * `backend/` are independently-installed workspaces with no shared-code mechanism between them (see
 * root `CLAUDE.md`'s workspace layout), so this is the same "one canonical pattern, copied with a
 * pointer back to the source of truth" approach `siteValidation.js`'s `hostnamePattern` already uses
 * for the site-hostname schema. Keep the two definitions in sync by hand if either one changes
 * (OpenProject #1099).
 *
 * Accepts: a plain hostname (`api.example.com`), a `*.`-prefixed wildcard (`*.example.com`, matching
 * exactly one subdomain label -- the TLS-wildcard convention), an IPv4 literal (already covered by the
 * hostname branch -- each octet is just digits, a valid DNS label on its own), or an IPv6 literal.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidDomainPattern(value) {
  return domainPattern.test(value)
}

const domainLabel = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const domainHostname = `${domainLabel}(?:\\.${domainLabel})*`
const domainIpv6 = '(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}'

const domainPattern = new RegExp(`^(?:\\*\\.)?${domainHostname}$|^${domainIpv6}$`)
