<template>
  <!--
    The surface colours live on `.w-card` in `@layer components`, not here: as utilities they
    outrank the `bg-*` a caller tints its notice card with, utilities being ordered within the
    layer rather than by who wrote them.
  -->
  <div
    class="w-card relative rounded-card shadow-card"
    :class="horizontal ? 'flex flex-nowrap' : ''">
    <slot />
  </div>
</template>

<script setup>
/**
 * Pair with `WCardSection` / `WCardActions` for its internal bands.
 *
 * There is no `flat` prop: a card is separated from its ground with a hairline, never elevation.
 * `--radius-card`/`--shadow-card`/`--border-card` carry the whole per-theme difference, so the edge
 * can be a real border under one theme and a hairline ring drawn by the shadow under another
 * without an aesthetic branch here. Reading it through the token rather than a
 * `border-hairline`/`dark:border-hairline-dark` utility pair is what lets the dark value differ.
 */
defineProps({
  horizontal: {
    type: Boolean,
    default: false
  }
})
</script>

<style scoped>
.w-card {
  border: var(--border-card);
}
</style>
