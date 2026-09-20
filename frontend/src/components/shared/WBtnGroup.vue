<template>
  <div class="w-btn-group inline-flex flex-nowrap align-middle">
    <slot />
  </div>
</template>

<script setup>
/**
 * No `unelevated` prop and no corner-squaring rules: both existed to reconcile a rounded, SHADOWED
 * button with the run it sits in -- the group had to be able to switch off a drop shadow that would
 * otherwise show through the seams. A Cardinal button casts nothing, so a run of them already reads
 * as one control, and the only thing left to say is where one ends and the next begins.
 */
</script>

<style scoped>
/*
  `:deep` because the buttons come from the consumer's slot content and carry that component's
  scope attribute rather than this one's.
*/
.w-btn-group :deep(> .w-btn:not(:last-child)) {
  border-inline-end: 1px solid var(--color-hairline);
}

:global(body.body--dark .w-btn-group > .w-btn:not(:last-child)) {
  border-inline-end-color: var(--color-hairline-dark);
}
</style>
