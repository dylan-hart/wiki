/**
 * How long a `?q=` search-query value is allowed to be before `Search.vue`'s route watcher
 * truncates it. The route watcher assigns straight from `route.query.q` -- attacker-controlled
 * and, before this cap, unbounded -- into `siteStore.search`, which `syncTags()` and
 * `performSearch()` then scan for `#tag` tokens on every route change. 2000 characters is far
 * past anything a real search box would produce, so nothing legitimate is truncated.
 *
 * See `extractTags()` below for why the scan itself no longer needs this cap to stay cheap; the
 * cap exists for the handful of other places a long `q` is read (e.g. rendering it back into the
 * page), not to keep this file's own regex linear.
 */
export const MAX_QUERY_LENGTH = 2000

/**
 * Matches one `#tag` token. The same character class `Search.vue`'s old `tagsInQueryRgx` used,
 * minus its trailing lookahead -- nothing here backtracks.
 */
const TAG_TOKEN_RGX = /#[a-z0-9-㐀-䶿一-鿿]+/g

/**
 * Extracts every `#tag` token in `query` that lies outside a double-quoted phrase, in linear
 * time.
 *
 * This replaces `/#[a-z0-9-㐀-䶿一-鿿]+(?=(?:[^"]*(?:")[^"]*(?:"))*[^"]*$)/g`,
 * whose trailing lookahead backtracks the outer `(?:...)*` group once per quote pair on every
 * failed attempt -- quadratic in the number of quotes for a query with an odd quote count (see
 * `docs/audit-2026-08-24/security/09-dos-resource.md` §13).
 *
 * The old regex's lookahead succeeded at a candidate tag's end position exactly when the number
 * of `"` characters remaining to the end of the string was even. Splitting `query` on `"` turns
 * that into a parity check on the segment index: a segment at index `j` qualifies iff
 * `j <= totalQuotes (mod 2)` -- i.e. the even-indexed (normally-unquoted) segments qualify when
 * the string has an even total of quotes, exactly as expected, but for an ODD total the *odd*-
 * indexed segments qualify instead. That flip for an unmatched trailing quote is a pre-existing
 * quirk of the old regex, preserved here rather than "fixed": this rewrite's job is to reproduce
 * today's extraction results, not redefine them.
 */
export function extractTags(query) {
  if (!query) {
    return []
  }
  const segments = query.split('"')
  const totalQuotes = segments.length - 1
  const startParity = totalQuotes % 2
  const tags = []
  for (let i = startParity; i < segments.length; i += 2) {
    for (const match of segments[i].matchAll(TAG_TOKEN_RGX)) {
      tags.push(match[0].substring(1))
    }
  }
  return tags
}
