<template>
  <div class="w-scroll-area overflow-auto">
    <slot />
  </div>
</template>

<script setup>
/**
 * Scrollable region. Its own scrollbar styling is deliberately gone (OpenProject #3006) -- it used
 * to hardcode a flat grey `scrollbar-width`/`scrollbar-color` + `::-webkit-scrollbar*` treatment
 * here, but Vue's scoped-style `[data-v-xxx]` attribute gave `.w-scroll-area[data-v-xxx]
 * ::-webkit-scrollbar*` higher specificity than the global, aesthetic-scoped `.body--ledger
 * ::-webkit-scrollbar*` / `.body--cobalt ::-webkit-scrollbar*` rules in `_base.scss`, so every
 * `<w-scroll-area>` region (the reader/admin sidebars among them) silently kept the old grey bar no
 * matter which aesthetic was active. `<body>` always carries exactly one of `body--ledger` /
 * `body--cobalt` (`composables/aesthetic.js`'s mutually-exclusive toggle), so leaving no local rule
 * here is what lets those global rules reach this element instead.
 *
 * Simplification: the component this replaces rendered a virtual scrollbar out of real DOM nodes,
 * configured through `thumb-style` / `bar-style` objects, and exposed imperative scroll methods.
 * Nothing here used the scroll API, so this is a plain native scroll container, which behaves
 * better (keyboard, momentum, accessibility) than a synthetic one.
 *
 * Callers set the height themselves, exactly as before.
 */
</script>
