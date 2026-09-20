<template>
  <div
    class="w-toolbar-title min-w-0 grow overflow-hidden ps-3 text-lg leading-6 text-ellipsis whitespace-nowrap">
    <slot />
  </div>
</template>

<script setup>
/** Leading-edge padding as `ps-3` rather than `pl-3`, so it stays on the correct side under RTL. */
</script>
