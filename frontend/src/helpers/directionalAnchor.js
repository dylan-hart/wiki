/**
 * `composables/anchoredPosition.js` places floating elements in raw viewport pixels and knows
 * nothing about text direction, so a fixed `anchor`/`self` pair always pops the same visual way and
 * points out of its container under `dir="rtl"`. Callers state their layout once, in LTR terms, and
 * get the mirrored pair for free.
 *
 * @param {'ltr' | 'rtl'} direction Usually `document.documentElement.dir`.
 * @param {string} ltrAnchor e.g. `'center right'`.
 * @param {string} ltrSelf e.g. `'center left'`.
 * @returns {{ anchor: string, self: string }}
 */
export function directionalAnchor(direction, ltrAnchor, ltrSelf) {
  if (direction !== 'rtl') {
    return { anchor: ltrAnchor, self: ltrSelf }
  }
  return { anchor: mirrorHorizontal(ltrAnchor), self: mirrorHorizontal(ltrSelf) }
}

function mirrorHorizontal(spec) {
  return spec
    .split(' ')
    .map((word) => (word === 'left' ? 'right' : word === 'right' ? 'left' : word))
    .join(' ')
}
