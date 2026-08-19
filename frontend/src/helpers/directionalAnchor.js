/**
 * `WTooltip`/`WMenu` place themselves in raw viewport pixels
 * (`composables/anchoredPosition.js`), which knows nothing about `direction` -- an `anchor`/`self`
 * pair like `"center right"`/`"center left"` always pops the floating element out toward the visual
 * right, whichever way the reader's text flows. That is correct for a trigger sitting on the
 * reading-START edge of its container in LTR, but wrong once `dir="rtl"` moves that edge (and
 * whatever the trigger is sitting in) to the visual right: the tooltip would then pop away from the
 * container instead of back into it.
 *
 * This picks the LTR-correct pair, or its mirror image, from the document's own direction -- so a
 * caller states its layout once, in LTR terms, and gets the RTL-correct pair for free.
 *
 * @param {'ltr' | 'rtl'} direction Usually `document.documentElement.dir`.
 * @param {string} ltrAnchor The `anchor` this trigger would use under LTR, e.g. `'center right'`.
 * @param {string} ltrSelf The matching `self`, e.g. `'center left'`.
 * @returns {{ anchor: string, self: string }}
 */
export function directionalAnchor(direction, ltrAnchor, ltrSelf) {
  if (direction !== 'rtl') {
    return { anchor: ltrAnchor, self: ltrSelf }
  }
  return { anchor: mirrorHorizontal(ltrAnchor), self: mirrorHorizontal(ltrSelf) }
}

/** Swaps `left`/`right` within an `"<vertical> <horizontal>"` anchor spec; leaves `middle`/`center` alone. */
function mirrorHorizontal(spec) {
  return spec
    .split(' ')
    .map((word) => (word === 'left' ? 'right' : word === 'right' ? 'left' : word))
    .join(' ')
}
