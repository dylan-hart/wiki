<template>
  <div
    class="w-bar flex w-full flex-nowrap items-center"
    :class="dense ? 'w-bar--dense' : 'w-bar--standard'">
    <slot />
  </div>
</template>

<script setup>
/** Metrics are taken from Quasar's own variables, so migrated chrome keeps its exact size. */
defineProps({
  dense: {
    type: Boolean,
    default: false
  }
})
</script>

<style scoped>
.w-bar {
  background: rgb(0 0 0 / 0.2);
}

.w-bar--standard {
  height: 32px;
  padding: 0 12px;
  font-size: 18px;
}

.w-bar--dense {
  height: 24px;
  padding: 0 8px;
  font-size: 14px;
}

/*
  Quasar sized buttons inside a bar well below the bar's own font size; reproduced so a bar full of
  buttons keeps its compact look.
*/
.w-bar--standard :deep(.w-btn) {
  font-size: 11px;
}

.w-bar--dense :deep(.w-btn) {
  font-size: 8px;
}

.w-bar :deep(> * + *) {
  margin-inline-start: 2px;
}
</style>
