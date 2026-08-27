/**
 * Whether `value` is syntactically a valid `allowedOrigins` entry for a block credential.
 *
 * Mirrors `backend/helpers/network.ts`'s `isValidOriginPrefixPattern` by hand rather than by import:
 * `frontend/` and `backend/` are independently-installed workspaces with no shared-code mechanism
 * between them (see root `CLAUDE.md`'s workspace layout), so this is the same "one canonical
 * pattern, copied with a pointer back to the source of truth" approach `siteValidation.js`'s
 * `hostnamePattern` already uses for the site-hostname schema. Keep the two definitions in sync by
 * hand if either one changes (OpenProject #2195).
 *
 * Accepts an absolute `http:`/`https:` URL naming an origin (scheme + host + optional port) plus a
 * path prefix, with no userinfo, query string, or fragment -- any of those would leave "does this
 * request URL fall under the allowed prefix" ambiguous, so all three are refused up front rather
 * than silently ignored at match time.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidOriginPrefixPattern(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  )
}
