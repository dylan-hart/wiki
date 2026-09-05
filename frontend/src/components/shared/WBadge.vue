<template>
  <!--
    A count in Roboto Mono, which is what Cardinal sets every number in -- a notification count, a
    version cursor, a row tally. At 9px/600 it matches the design's own badge; the proportional
    12px it replaced made two- and three-digit counts jump about in width as they changed.

    `min-h-3.5` is what makes a badge with no label a dot rather than a 14x4 sliver: the only child
    here is often a tooltip, which renders nothing inline, so the box would otherwise be pure
    padding -- 14px wide from `px-1.5` but only 4px tall. 14px matches the width, so it comes out
    square (or, with `rounded`, circular). A badge that does carry a label is taller than this on
    its own and is unaffected.
  -->
  <div
    class="w-badge inline-flex min-h-3.5 items-center justify-center px-1.5 py-0.5 font-mono text-[9px] leading-none font-semibold"
    :class="classes"
    :style="styles"
    :title="title">
    <slot>{{ label }}</slot>
  </div>
</template>

<script setup>
import { computed } from 'vue'

/**
 * Small count or status marker.
 */
const props = defineProps({
  label: {
    type: [String, Number],
    default: null
  },
  color: {
    type: String,
    default: 'primary'
  },
  textColor: {
    type: String,
    default: null
  },
  /** Border and text in `color`, with no fill. */
  outline: {
    type: Boolean,
    default: false
  },
  /** Pill rather than the default slightly-rounded rectangle. */
  rounded: {
    type: Boolean,
    default: false
  },
  /** Pins the badge to the top-right of the nearest positioned ancestor. */
  floating: {
    type: Boolean,
    default: false
  },
  /** Native tooltip. */
  title: {
    type: String,
    default: null
  }
})

const classes = computed(() => [
  // -> Square unless a caller explicitly asks for the pill; see WChip for the same reasoning
  props.rounded ? 'rounded-full' : 'rounded-none',
  props.outline ? 'border border-current bg-transparent' : '',
  // -> `right-0` (not `end-0`) is deliberate, reviewed under OpenProject #1590's
  //    physical-positioning triage: the straddle is `translate-x-1/2`, a physical transform that
  //    never mirrors under RTL, so swapping only the `right` half to `end` would pull the badge
  //    the wrong way off its corner under RTL rather than the right way -- correcting the pair
  //    together (an `end-0` position plus a direction-aware straddle) is future work, not a
  //    mechanical swap. See `frontend/src/physicalPositioning.test.js`.
  props.floating ? 'absolute top-0 right-0 translate-x-1/2 -translate-y-1/3' : ''
])

const styles = computed(() =>
  props.outline
    ? { color: `var(--color-${props.color})` }
    : {
        backgroundColor: `var(--color-${props.color})`,
        color: `var(--color-${props.textColor ?? 'white'})`
      }
)
</script>
