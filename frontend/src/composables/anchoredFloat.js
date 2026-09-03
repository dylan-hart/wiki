import { nextTick, onMounted, ref } from 'vue'

import { anchoredPosition } from '@/composables/anchoredPosition'

/**
 * The glue both teleported floating elements need — `WMenu` and `WTooltip`.
 *
 * Each leaves a hidden placeholder `<span>` at its own position in the tree and teleports its real
 * panel to `<body>`; this owns the two things that follow from that shape: finding the control the
 * placeholder stands beside, and placing the panel against it through `anchoredPosition()`.
 *
 * @param {object} options
 * @param {import('vue').Ref<Element|null>} options.placeholderEl The hidden marker's ref.
 * @param {import('vue').Ref<Element|null>} options.floatEl The teleported panel's ref.
 * @param {string} options.closest Selector for the real control the placeholder sits inside.
 * @param {() => string} options.anchor The anchor point on the trigger, e.g. `bottom left`.
 * @param {() => string} options.self The matching point on the panel.
 * @param {() => [number, number]} [options.offset] Extra `[x, y]` displacement.
 * @param {(floatEl: Element, triggerEl: Element) => DOMRect|void} [options.beforeMeasure] Run just
 *   before measuring, for a caller that has to size the panel first (`WMenu`'s `fit`/`maxHeight`).
 *   May return a rect to place against instead of the trigger's own — which is how a context menu
 *   opens at the pointer rather than at the element.
 * @returns {{ triggerEl: import('vue').Ref<Element|null>, floatStyle: import('vue').Ref<object>,
 *   reposition: () => Promise<void> }}
 */
export function useAnchoredFloat({
  placeholderEl,
  floatEl,
  closest,
  anchor,
  self,
  offset,
  beforeMeasure
}) {
  const triggerEl = ref(null)
  /*
    `left`/`top` here are raw viewport pixels from `anchoredPosition()`'s own bounding-rect math,
    not a CSS gutter -- reviewed under OpenProject #1590's physical-positioning triage and left
    physical: making the `anchor`/`self` corner keywords ("top left", "bottom right", …)
    direction-aware is a redesign of that whole API, not a mechanical swap.
  */
  const floatStyle = ref({ left: '0px', top: '0px' })

  onMounted(() => {
    /*
      Climb to the real control rather than stopping at the immediate parent. WBtn wraps its slot in
      an inner <span> (so the label can be hidden while loading), so the naive parent would be that
      span -- and clicking the button's padding, which is outside it, would do nothing.
    */
    const host = placeholderEl.value?.parentElement ?? null
    triggerEl.value = host?.closest(closest) ?? host
  })

  async function reposition() {
    await nextTick()
    if (!floatEl.value || !triggerEl.value) {
      return
    }

    const rect =
      beforeMeasure?.(floatEl.value, triggerEl.value) ?? triggerEl.value.getBoundingClientRect()

    const { left, top } = anchoredPosition(
      rect,
      { width: floatEl.value.offsetWidth, height: floatEl.value.offsetHeight },
      { anchor: anchor?.(), self: self?.(), offset: offset?.() }
    )
    floatStyle.value = { left: `${left}px`, top: `${top}px` }
  }

  return { triggerEl, floatStyle, reposition }
}
