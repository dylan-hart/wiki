<template>
  <!--
    `min-h-3` is what makes a badge with no label a round dot rather than a 12x4 sliver: the only
    child here is often a tooltip, which renders nothing inline, so the box would otherwise be pure
    padding -- 12px wide from `px-1.5` but only 4px tall. 12px matches the width, so with `rounded`
    it comes out circular. A badge that does carry a label is taller than this on its own and is
    unaffected.
  -->
  <div
    class="w-badge inline-flex min-h-3 items-center justify-center px-1.5 py-0.5 text-xs leading-none font-medium"
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
  props.rounded ? 'rounded-full' : 'rounded-sm',
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
