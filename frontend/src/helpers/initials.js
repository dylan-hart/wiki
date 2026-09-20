/**
 * Every lettered avatar plate derives its initials here; a second copy of the rule, drifting from
 * this one, is the regression this file exists to prevent.
 *
 * FIRST and LAST word, so `Dylan James Hart` gives `DH`. A mononym gives one letter rather than
 * doubling it, and a name with no letters gives `?` rather than an empty plate.
 *
 * @param {string | null | undefined} name
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
