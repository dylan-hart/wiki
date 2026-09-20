<template>
  <div class="w-scroll-area overflow-auto">
    <slot />
  </div>
</template>

<script setup>
/**
 * Carries no scrollbar rule of its own, deliberately: Vue's scoped-style `[data-v-xxx]` attribute
 * would give one higher specificity than the aesthetic-scoped `.body--ledger`/`.body--cobalt
 * ::-webkit-scrollbar*` rules in `_base.css`, which are what theme this element.
 *
 * A plain native scroll container, not the virtual scrollbar (`thumb-style`/`bar-style`, imperative
 * scroll methods) of the component it replaces -- nothing here used that API, and native scrolling
 * behaves better for keyboard, momentum and accessibility. Callers set the height themselves.
 */
</script>
