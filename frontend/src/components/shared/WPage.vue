<template>
  <main id="w-page-main" tabindex="-1" class="w-page" :class="padding ? 'p-4' : ''">
    <slot />
  </main>
</template>

<script setup>
/**
 * The `id` and `tabindex="-1"` are what `MainLayout`'s skip link targets: a `<main>` is not naturally
 * focusable, and a fragment link only moves the reader's SCROLL position without a focus target at
 * the far end. `-1` keeps the container out of the ordinary tab order.
 */
defineProps({
  padding: {
    type: Boolean,
    default: false
  }
})
</script>

<style scoped>
/*
  A plain block is only as tall as its content, so anything inside sized `flex: 1` or `height: 100%`
  has nothing to grow into. `min-height` rather than `height` so a page taller than the viewport still
  grows, and on the page cell rather than the container so a container holding something other than a
  page (the search screen's floating card) is left alone. A page sitting DIRECTLY in a
  `WPageContainer` is grown by flex there instead -- a percentage would also claim the height of a
  footer sharing that box.
*/
.w-page {
  min-height: 100%;
}
</style>
