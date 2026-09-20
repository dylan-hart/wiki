<template>
  <div class="w-toolbar flex min-h-[50px] w-full flex-nowrap items-center px-3">
    <slot />
  </div>
</template>

<script setup>
/**
 * Metrics match the toolbar this replaces (`min-height: 50px`, `padding: 0 12px`) and crucially
 * carry NO gap: spacing between items comes from the items' own margins, so adding a gap here
 * silently widens every header.
 */
</script>
