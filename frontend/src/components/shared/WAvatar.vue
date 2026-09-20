<template>
  <!--
    `relative` so a floating badge in the slot pins to THIS box; without it the badge finds the
    surrounding card and lands in that card's corner instead of on the avatar.

    Deliberately NOT `overflow-hidden`, for the same reason: a floating badge is meant to overhang
    the corner, and a clipping avatar would cut it in half. An image is instead clipped by taking
    this box's own radius -- `.w-avatar > img` in `css/tailwind.css`.
  -->
  <div
    class="w-avatar relative inline-flex shrink-0 items-center justify-center align-middle"
    :class="shapeClass"
    :style="styles">
    <w-icon v-if="icon" :name="icon" />
    <slot />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { resolveSize } from './metrics'

const props = defineProps({
  /**
   * Any CSS length, or one of the named sizes. Omitted, the size comes from CSS, which is what lets
   * a context set it -- an avatar in an item's flanking section is smaller. An explicit value
   * renders as an inline style and beats both.
   */
  size: {
    type: String,
    default: null
  },
  color: {
    type: String,
    default: null
  },
  textColor: {
    type: String,
    default: null
  },
  icon: {
    type: String,
    default: null
  },
  square: {
    type: Boolean,
    default: false
  },
  rounded: {
    type: Boolean,
    default: false
  },
  fontSize: {
    type: String,
    default: null
  }
})

const shapeClass = computed(() => {
  if (props.square) {
    return 'rounded-none'
  }
  if (props.rounded) {
    return 'rounded'
  }
  return 'rounded-full'
})

const styles = computed(() => {
  const size = props.size ? resolveSize(props.size) : null
  return {
    width: size ?? undefined,
    height: size ?? undefined,
    // -> Keeps an icon or initials proportional to the avatar without a second prop at every site.
    fontSize: props.fontSize ?? (size ? `calc(${size} * 0.6)` : undefined),
    backgroundColor: props.color ? `var(--color-${props.color})` : undefined,
    color: props.textColor ? `var(--color-${props.textColor})` : undefined
  }
})
</script>

<style scoped>
/* In CSS rather than inline so a context (WItemSection) can override it. */
.w-avatar {
  width: 48px;
  height: 48px;
  font-size: 28.8px;
}
</style>
