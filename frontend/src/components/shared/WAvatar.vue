<template>
  <!--
    `relative` so a `<w-badge floating>` in the slot pins to THIS box. Without it the badge kept
    looking for a positioned ancestor and found the surrounding card, which put the blueprint icon's
    indicator dot in the card's far top-right corner instead of on the icon.

    Deliberately NOT `overflow-hidden`, for the same reason: a floating badge is meant to overhang
    the corner, and a clipping avatar would cut it in half. An image is instead clipped by taking
    this box's own radius, as the avatar this replaces did -- see `.w-avatar > img` in
    `css/tailwind.css`.
  -->
  <div
    class="w-avatar relative inline-flex shrink-0 items-center justify-center align-middle"
    :class="[shapeClass, identityClasses]"
    :style="styles">
    <w-icon v-if="icon" :name="icon" />
    <slot />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { resolveSize } from './metrics'

/**
 * Circular (or squared) container for an image, icon or initials.
 */
const props = defineProps({
  /**
   * Any CSS length, or one of the named sizes. Omit it to take the default from CSS, which is what
   * lets a context set the size -- an avatar in an item's flanking section is smaller. An explicit
   * value renders as an inline style and beats both.
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
  /** Square with sharp corners. */
  square: {
    type: Boolean,
    default: false
  },
  /** Square with rounded corners. */
  rounded: {
    type: Boolean,
    default: false
  },
  /**
   * Opt in to the aesthetic's own avatar shape: `--radius-avatar`, which is square in Ledger and a
   * disc in Cobalt, where the other shape props are fixed in both. Never a default -- about 25
   * callers rely on `rounded-full`.
   *
   * - `initials` is the header mark's treatment (`.account-initials`): tracked Barlow Condensed on
   *   the `--color-account-avatar-bg` tone.
   * - `plate` is an icon tile in a list row: the `--size-avatar-plate` box (36px Ledger, 26px
   *   Cobalt). Pass `color`/`text-color` for its tone, but not `size`/`font-size`, which would
   *   override the aesthetic's size inline.
   */
  identity: {
    type: String,
    default: null,
    validator: (value) => ['initials', 'plate'].includes(value)
  },
  /** Glyph size within the avatar; defaults to 60% of `size`. */
  fontSize: {
    type: String,
    default: null
  }
})

const shapeClass = computed(() => {
  // -> `rounded-full` is a utility and would beat the token radius, so an identity avatar takes none
  if (props.identity) {
    return null
  }
  if (props.square) {
    return 'rounded-none'
  }
  if (props.rounded) {
    return 'rounded'
  }
  return 'rounded-full'
})

const identityClasses = computed(() =>
  props.identity ? ['w-avatar--identity', `w-avatar--${props.identity}`] : null
)

const styles = computed(() => {
  const size = props.size ? resolveSize(props.size) : null
  return {
    width: size ?? undefined,
    height: size ?? undefined,
    // -> Keeps an icon or initials proportional to the avatar without a second prop at every site
    fontSize: props.fontSize ?? (size ? `calc(${size} * 0.6)` : undefined),
    backgroundColor: props.color ? `var(--color-${props.color})` : undefined,
    color: props.textColor ? `var(--color-${props.textColor})` : undefined
  }
})
</script>

<style scoped>
/* Default size, in CSS rather than inline so a context (see WItemSection) can override it. */
.w-avatar {
  width: 48px;
  height: 48px;
  font-size: 28.8px;
}

/*
  The list-row plate's size is a per-aesthetic token, so it cannot be inline. It lives HERE, in the
  same unlayered scoped sheet as the default above, because that default beats anything written in
  `@layer components`. `WItemSection`'s flanking-avatar rule excludes `--plate` for the same reason.
*/
.w-avatar.w-avatar--plate {
  width: var(--size-avatar-plate);
  height: var(--size-avatar-plate);
  font-size: calc(var(--size-avatar-plate) * 0.5);
}
</style>
