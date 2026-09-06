/**
 * The one derivation of avatar initials from a display name, for every surface that draws a person
 * as a lettered plate rather than an uploaded image -- `AccountMenu.vue`, `CollabPresence.vue` and
 * `PageComments.vue` today. It lives here rather than in any one of them because it had already
 * drifted: two of those three took the first and last word while the third took the first two, so
 * `Dylan James Hart` read `DH` in the header and `DJ` on a comment. A second copy of this rule is
 * the regression this file exists to prevent.
 */

/**
 * Up to two letters standing in for an avatar: the first letter of the FIRST and LAST
 * whitespace-separated parts of the name, uppercased. `Ada Lovelace` gives `AL` and
 * `Dylan James Hart` gives `DH` -- the middle is dropped, not the end, which is what the design's
 * plates draw. A mononym gives its single letter rather than doubling it, and a name with no
 * letters to take at all gives a neutral `?` rather than an empty plate.
 *
 * @param {string | null | undefined} name Display name, in whatever shape the caller holds it.
 * @returns {string} One or two uppercase characters, or `'?'`.
 */
export function initials(name) {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return '?'
  }
  const first = words[0][0]
  const last = words.length > 1 ? words.at(-1)[0] : ''
  return `${first}${last}`.toUpperCase()
}
