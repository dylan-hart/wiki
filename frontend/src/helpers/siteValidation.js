/**
 * The one hostname pattern the frontend validates against, matching the backend JSON schema
 * (`backend/api/sites.ts`) exactly: either the catch-all wildcard `*`, or a fully-qualified domain
 * name — lowercase letters, digits, `.` and `-` only, no colon or port, as
 * `admin.sites.hostnameHint` and `admin.general.siteHostnameHint` both promise.
 */
export const hostnamePattern = /^(\*|[a-z0-9.-]+)$/

export function isValidHostname(value) {
  return hostnamePattern.test(value)
}
