<template>
  <div class="w-page-container min-w-0">
    <slot />
  </div>
</template>

<script setup>
/**
 * `min-width: 0` is load-bearing: without it a wide child (a table, a code block) would blow the grid
 * column out rather than scrolling inside it.
 *
 * The classic sticky-footer column, so a `WFooter` written as the last child comes to rest at the
 * bottom of the CONTENT rather than the window, and both scroll together. Every part of `flex: 1 0
 * auto` matters: an `auto` basis starts from the page's OWN height, so a page taller than this box
 * extends it (a grid `1fr` row could not -- its item is stretched to the track, and anything longer
 * spilled out of the bottom); grow fills the leftover height under a short page; no shrink keeps a
 * long one from being squeezed to make room for the footer. `min-height: 0` overrides `WPage`'s own
 * `min-height: 100%`, which measures the WHOLE box: the page would claim the footer's height as well
 * and every short page would scroll a little.
 *
 * Specificity: `:not()` counts its argument, so `> :not(.w-footer)` outweighs `WPage`'s own rule
 * rather than depending on which stylesheet Vite happens to inject first.
 */
</script>

<style scoped>
.w-page-container {
  grid-area: main;
  display: flex;
  flex-direction: column;
}

.w-page-container :deep(> :not(.w-footer)) {
  flex: 1 0 auto;
  min-height: 0;
}
</style>
