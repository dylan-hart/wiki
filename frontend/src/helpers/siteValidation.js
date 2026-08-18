/**
 * The single canonical hostname pattern for a site, shared by every place the frontend validates one.
 *
 * Matches the backend JSON schema (`backend/api/sites.ts`) exactly: either the catch-all wildcard
 * `*`, or a fully-qualified domain name — lowercase letters, digits, `.` and `-` only. No colon/port,
 * whatever `admin.sites.hostnameHint` and `admin.general.siteHostnameHint` both promise. Two inline
 * regexes used to disagree with this (and with each other) — one mis-grouped so its anchors didn't
 * bind the alternation, and both wrongly allowing a colon — this is the one source of truth for both.
 */
export const hostnamePattern = /^(\*|[a-z0-9.-]+)$/

/**
 * Whether `value` is a valid site hostname per {@link hostnamePattern}.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidHostname(value) {
  return hostnamePattern.test(value)
}
