<template>
  <div
    role="separator"
    :aria-orientation="vertical ? 'vertical' : 'horizontal'"
    class="w-separator w-hairline shrink-0"
    :class="classes"
    :style="styles" />
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  vertical: {
    type: Boolean,
    default: false
  },
  /** Forces the light-on-dark colour, for a rule on an always-dark surface. */
  dark: {
    type: Boolean,
    default: false
  },
  inset: {
    type: Boolean,
    default: false
  },
  /** `sm`/`md`/`lg`, a CSS length, or `true` for `sm`. */
  spaced: {
    type: [Boolean, String],
    default: false
  }
})

const SPACING = { sm: '8px', md: '16px', lg: '24px' }

/*
  A horizontal rule is a plain block and takes its width from the flow. It must NOT be `w-full`:
  combined with the `inset` margins that is 100% width *plus* 32px of margin, so the rule overhangs
  its container on the right by exactly the right-hand inset.
*/
const classes = computed(() => [
  props.vertical ? 'h-auto w-px self-stretch' : 'block h-px',
  /*
    A vertical rule has to scale on the OTHER axis: the hairline trick thins the painted line with a
    transform, and the base rule scales Y from `transform-origin: top left`, which on a vertical rule
    squashes it towards the top of its box instead. Invisible at a device pixel ratio of 1, where the
    scale is 1 and nothing moves, and visible on a fractionally scaled display.
  */
  props.vertical ? 'w-hairline--vertical' : '',
  props.dark ? 'w-hairline--dark' : '',
  props.inset ? (props.vertical ? 'my-2' : 'mx-4') : ''
])

const styles = computed(() => {
  if (!props.spaced) {
    return undefined
  }
  const v = props.spaced === true ? 'sm' : props.spaced
  const size = SPACING[v] ?? v
  // -> Margin runs along the rule's cross axis, so it flips with the orientation
  return props.vertical ? { marginInline: size } : { marginBlock: size }
})
</script>
