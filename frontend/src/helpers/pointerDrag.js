/**
 * Press-and-drag wiring, shared by the two controls dragged along a surface — `WColorPicker`'s
 * saturation/value field and hue strip, and `WRange`'s rail.
 */

/**
 * Route the rest of a pointer gesture to one element, reporting every move until it ends.
 *
 * Both capture calls are guarded because capture throws when the event did not come from a real
 * pointer -- which is the case for a synthetic `PointerEvent`. The drag itself works either way, so
 * a failure there must not abort it.
 *
 * @param {PointerEvent} ev The `pointerdown` that started the gesture.
 * @param {Element} el The element to capture on and listen to.
 * @param {(ev: PointerEvent) => void} onMove Called for each `pointermove` until release.
 */
export function trackPointerDrag(ev, el, onMove) {
  const move = (e) => onMove(e)
  const up = () => {
    el.removeEventListener('pointermove', move)
    try {
      el.releasePointerCapture(ev.pointerId)
    } catch {}
  }
  try {
    el.setPointerCapture(ev.pointerId)
  } catch {}
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up, { once: true })
  el.addEventListener('pointercancel', up, { once: true })
}
