<template>
  <div
    class="w-toolbar-title min-w-0 grow overflow-hidden ps-3 text-lg leading-6 text-ellipsis whitespace-nowrap">
    <slot />
  </div>
</template>

<script setup>
/**
 * The title cell of a `WToolbar`: takes the free space and truncates rather than wrapping.
 * Metrics match the toolbar title this replaces (`font-size: 1.25rem`, `padding-left: 12px`), the
 * leading-edge padding expressed as `ps-3` so it stays on the correct side under RTL.
 */
</script>
