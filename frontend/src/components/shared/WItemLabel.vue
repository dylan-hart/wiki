<template>
  <component :is="header ? 'div' : 'span'" :class="classes" :style="clampStyle">
    <slot />
  </component>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  caption: {
    type: Boolean,
    default: false
  },
  header: {
    type: Boolean,
    default: false
  },
  /** Clamp to this many lines, ellipsising the overflow. */
  lines: {
    type: [String, Number],
    default: null
  }
})

const classes = computed(() => [
  'w-item-label',
  props.header ? 'w-item-label--header p-4 text-body2 text-black/54 dark:text-white/70' : '',
  props.caption && !props.header
    ? 'w-item-label--caption text-caption text-black/54 dark:text-white/70'
    : '',
  !props.caption && !props.header ? 'text-body2' : '',
  Number(props.lines) === 1 ? 'truncate' : ''
])

/**
 * Inline rather than a `line-clamp-<n>` utility: the count comes from a prop, and Tailwind can only
 * generate a class it can see as literal text in the source.
 */
const clampStyle = computed(() =>
  Number(props.lines) > 1
    ? {
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: String(props.lines),
        overflow: 'hidden'
      }
    : undefined
)
</script>
