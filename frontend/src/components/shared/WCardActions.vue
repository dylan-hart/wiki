<template>
  <div
    class="w-card-actions flex flex-nowrap items-center gap-2 border-t border-hairline p-2.5 dark:border-hairline-dark"
    :class="alignClass">
    <slot />
  </div>
</template>

<script setup>
import { computed } from 'vue'

/**
 * The action bar at the foot of a `WCard`, ruled off from the body above it by a hairline -- which
 * is how Cardinal separates every band inside a card, the dialogs included.
 */
const props = defineProps({
  /** Horizontal alignment of the buttons. */
  align: {
    type: String,
    default: 'left',
    validator: (v) => ['left', 'center', 'right', 'between', 'around'].includes(v)
  },
  /** Stacks the actions vertically. */
  vertical: {
    type: Boolean,
    default: false
  }
})

const ALIGN = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
  between: 'justify-between',
  around: 'justify-around'
}

const alignClass = computed(() => [
  ALIGN[props.align] ?? ALIGN.left,
  props.vertical ? 'flex-col items-stretch' : ''
])
</script>
