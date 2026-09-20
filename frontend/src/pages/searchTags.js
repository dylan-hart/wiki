/**
 * `Search.vue`'s route watcher truncates to this before assigning `route.query.q` --
 * attacker-controlled and otherwise unbounded -- into `siteStore.search`, which is read on every
 * route change. 2000 characters is far past anything a real search box produces, so nothing
 * legitimate is truncated.
 */
export const MAX_QUERY_LENGTH = 2000

/** One `#tag` token, with no lookahead of any kind -- nothing here backtracks. */
const TAG_TOKEN_RGX = /#[a-z0-9-㐀-䶿一-鿿]+/g

/**
 * Every `#tag` token in `query` that lies outside a double-quoted phrase, in linear time. The
 * lookahead-based alternative backtracks its outer group once per quote pair on every failed
 * attempt -- quadratic in the number of quotes for a query with an odd quote count.
 *
 * A lookahead of that kind succeeds at a candidate tag's end exactly when an even number of `"`
 * remains to the end of the string, so splitting on `"` turns it into a parity check on the
 * segment index: a segment qualifies iff its index matches `totalQuotes` mod 2. For an ODD total
 * that selects the odd-indexed (normally quoted) segments instead -- a quirk on an unmatched
 * trailing quote, kept deliberately so extraction results stay what they are rather than being
 * redefined here.
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
