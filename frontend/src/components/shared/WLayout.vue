<template>
  <div class="w-layout" :class="container ? 'w-layout--container' : 'w-layout--page'">
    <slot />
  </div>
</template>

<script setup>
/**
 * Application shell, replacing the `view="hHh Lpr lff"` layout engine whose nine letters encoded a
 * 3x3 grid resolved at runtime into inline offsets on every child. Every layout here uses one of
 * two arrangements, which a CSS grid states declaratively: `WHeader`, `WDrawer`, `WPageContainer`
 * and `WFooter` stay flat siblings placing themselves by grid area, and an absent drawer collapses
 * its column to zero width with nothing conditional in the template.
 *
 * The footer row is for a bar that stays put while the page scrolls behind it -- a status bar. The
 * site footer belongs at the bottom of the CONTENT, so it goes inside `WPageContainer` instead,
 * which scrolls the two together.
 */
defineProps({
  /** Scope the layout to its parent box rather than the viewport, as overlays and dialogs need. */
  container: {
    type: Boolean,
    default: false
  }
})
</script>

<style scoped>
.w-layout {
  display: grid;
  /* -> Drawer columns are sized by their content, so an empty one takes no space at all */
  grid-template-columns: auto 1fr auto;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    'header header header'
    'ldrawer main rdrawer'
    'ldrawer footer rdrawer';
  width: 100%;
  /* -> Lets the shell shrink below its content when it is itself a grid or flex item */
  min-height: 0;
}

/*
  The shell is exactly the viewport and the page cell inside it is what scrolls. `min-height: 100vh`
  instead scrolls the whole document, pushing the header, the drawers and anything anchored to the
  bottom of a column (the sidebar's action bar, the page's action rail) off the screen.
*/
.w-layout--page {
  height: 100vh;
  overflow: hidden;
}

.w-layout--container {
  height: 100%;
  overflow: hidden;
}

/*
  The layout is bounded either way -- by the viewport or by the dialog holding it -- so the page
  cell is what scrolls, leaving the header and drawers in place. `min-height: 0` is what makes that
  work at all: a grid item's automatic minimum size is its content, so without it the `1fr` row
  grows to fit and there is nothing left to scroll. `:deep()` because the page cell is a child
  component.
*/
.w-layout :deep(> .w-page-container) {
  min-height: 0;
  overflow: auto;
}
</style>
