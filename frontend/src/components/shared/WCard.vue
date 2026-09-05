<template>
  <!--
    The surface colours live on `.w-card` in `@layer components` (see `css/tailwind.css`), not here.
    As utilities they outranked the `bg-negative` / `bg-info` the admin pages tint their notice cards
    with, since two background utilities are ordered within the layer rather than by who wrote them.
  -->
  <div
    class="w-card relative border border-hairline dark:border-hairline-dark"
    :class="horizontal ? 'flex flex-nowrap' : ''">
    <slot />
  </div>
</template>

<script setup>
/**
 * Surface container: a square white (or, in dark, panel-toned) box with a hairline edge. Pair with
 * `WCardSection` / `WCardActions` for its internal bands.
 */
defineProps({
  /**
   * @deprecated Inert. Cardinal separates a card from its ground with a hairline, never with
   *   elevation, so there is no shadow left to drop. Kept only until the call sites are swept.
   */
  flat: {
    type: Boolean,
    default: false
  },
  /** Lays sections out in a row instead of stacked. */
  horizontal: {
    type: Boolean,
    default: false
  }
})
</script>
