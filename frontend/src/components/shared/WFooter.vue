<template>
  <footer class="w-footer w-full" :class="elevated ? 'shadow-card' : ''">
    <slot />
  </footer>
</template>

<script setup>
/**
 * Bottom bar of a `WLayout`. Where it goes decides what it means, and both placements are used:
 *
 * - As a child of the `WLayout` itself it takes the shell's footer row, beside the drawers rather
 *   than under them, and is PINNED -- the shell is the viewport, so the bar stays put while the
 *   page scrolls behind it (what a status bar wants).
 * - As the last child of a `WPageContainer` it is part of the content that scrolls, coming to rest
 *   at the bottom of the page rather than the window (what the site footer wants).
 *
 * Nothing here has to switch between the two: `grid-area` places it in the shell's grid and does
 * not apply in a flex column, where the bar simply stacks last. It is only inert in a parent that
 * is NOT a grid, though -- dropped into a grid with no area by that name, the spec has every
 * implicit line answer to the unmatched name, so the bar lands in an implicit COLUMN beside the
 * page rather than under it.
 */
defineProps({
  elevated: {
    type: Boolean,
    default: false
  }
})
</script>

<style scoped>
.w-footer {
  grid-area: footer;
  /* -> In a flex column the bar is a fixed-size item, not something to squeeze to fit the content */
  flex-shrink: 0;
}
</style>
