<template>
  <!--
    Zero-size, display:none marker left at this component's own position. The tooltip itself is
    teleported to <body>, so without this there would be nothing in the tree identifying which
    element the tooltip describes. `hidden` keeps it out of layout and out of the a11y tree.
  -->
  <span ref="placeholderEl" class="hidden" aria-hidden="true" />
  <teleport to="body">
    <transition name="w-tooltip">
      <div
        v-if="shown"
        :id="tooltipId"
        ref="floatEl"
        role="tooltip"
        class="w-tooltip pointer-events-none fixed z-[7000] max-w-xs rounded bg-black/85 px-2 py-1 text-xs text-white shadow-menu"
        :style="floatStyle">
        <slot />
      </div>
    </transition>
  </teleport>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useAnchoredFloat } from '@/composables/anchoredFloat'

/**
 * Hover/focus tooltip, written as the last child of whatever it describes:
 *
 *   <w-btn icon="tabler:settings">
 *     <w-tooltip>Settings</w-tooltip>
 *   </w-btn>
 *
 * The trigger gains `aria-describedby` (or, with `labels`, `aria-labelledby`) pointing at the
 * teleported panel while it is shown, so assistive tech associates the two despite the teleport
 * putting them nowhere near each other in the DOM.
 */
const props = defineProps({
  /** Anchor point on the trigger, e.g. `bottom middle`. */
  anchor: {
    type: String,
    default: 'bottom middle'
  },
  /** Matching point on the tooltip itself. */
  self: {
    type: String,
    default: 'top middle'
  },
  /** Extra `[x, y]` displacement in px. */
  offset: {
    type: Array,
    default: () => [0, 8]
  },
  /** Delay before showing, in ms. */
  delay: {
    type: Number,
    default: 250
  },
  /**
   * The trigger has no accessible name of its own and the tooltip text IS that name (the
   * icon-only button case) -- associate via `aria-labelledby` instead of `aria-describedby`.
   */
  labels: {
    type: Boolean,
    default: false
  }
})

const tooltipId = useId()

const shown = ref(false)
const floatEl = ref(null)
const placeholderEl = ref(null)

/*
  Trigger discovery and placement are shared with WMenu; see `composables/anchoredFloat.js`.

  `.w-badge` is in the selector to STOP the climb, not to continue it: `closest` tests the element
  itself first, so a tooltip written inside a badge resolves to that badge. Without it the climb ran
  on to the enclosing `.w-item`, and the tooltip for a 12px indicator dot was measured against the
  whole settings row -- appearing under the middle of the row rather than under the dot.
*/
const { triggerEl, floatStyle, reposition } = useAnchoredFloat({
  placeholderEl,
  floatEl,
  closest: 'button, a, .w-btn, .w-item, .w-badge',
  anchor: () => props.anchor,
  self: () => props.self,
  offset: () => props.offset
})

let timer = null
// The aria-* attribute currently applied to triggerEl (null when not associated), and whatever
// value it held before -- so hiding restores a pre-existing attribute instead of clobbering it.
let associatedAttr = null
let previousAttrValue = null

function associateTrigger() {
  if (!triggerEl.value || associatedAttr) {
    return
  }
  associatedAttr = props.labels ? 'aria-labelledby' : 'aria-describedby'
  previousAttrValue = triggerEl.value.getAttribute(associatedAttr)
  triggerEl.value.setAttribute(associatedAttr, tooltipId)
}

function disassociateTrigger() {
  if (!triggerEl.value || !associatedAttr) {
    return
  }
  if (previousAttrValue === null) {
    triggerEl.value.removeAttribute(associatedAttr)
  } else {
    triggerEl.value.setAttribute(associatedAttr, previousAttrValue)
  }
  associatedAttr = null
  previousAttrValue = null
}

function show() {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    shown.value = true
    associateTrigger()
    await reposition()
  }, props.delay)
}

function hide() {
  clearTimeout(timer)
  shown.value = false
  disassociateTrigger()
}

function onKeydown(ev) {
  if (ev.key === 'Escape') {
    hide()
  }
}

onMounted(() => {
  // -> `useAnchoredFloat`'s own `onMounted` has already resolved the trigger by this point
  if (!triggerEl.value) {
    return
  }

  triggerEl.value.addEventListener('mouseenter', show)
  triggerEl.value.addEventListener('mouseleave', hide)
  // -> Keyboard users get the same information, and Escape dismisses it (WAI-ARIA tooltip practice)
  triggerEl.value.addEventListener('focusin', show)
  triggerEl.value.addEventListener('focusout', hide)
  triggerEl.value.addEventListener('keydown', onKeydown)
  // -> Capture phase, so scrolling any ancestor container dismisses rather than leaving it detached
  window.addEventListener('scroll', hide, true)
})

onBeforeUnmount(() => {
  clearTimeout(timer)
  disassociateTrigger()
  if (triggerEl.value) {
    triggerEl.value.removeEventListener('mouseenter', show)
    triggerEl.value.removeEventListener('mouseleave', hide)
    triggerEl.value.removeEventListener('focusin', show)
    triggerEl.value.removeEventListener('focusout', hide)
    triggerEl.value.removeEventListener('keydown', onKeydown)
  }
  window.removeEventListener('scroll', hide, true)
})
</script>

<style scoped>
.w-tooltip-enter-active,
.w-tooltip-leave-active {
  transition: opacity 0.15s var(--ease-standard);
}
.w-tooltip-enter-from,
.w-tooltip-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .w-tooltip-enter-active,
  .w-tooltip-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
