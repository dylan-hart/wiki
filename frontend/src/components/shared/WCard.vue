<template>
  <!--
    The surface colours live on `.w-card` in `@layer components` (see `css/tailwind.css`), not here.
    As utilities they outranked the `bg-negative` / `bg-info` the admin pages tint their notice cards
    with, since two background utilities are ordered within the layer rather than by who wrote them.
  -->
  <div
    class="w-card relative rounded-card shadow-card"
    :class="horizontal ? 'flex flex-nowrap' : ''">
    <slot />
  </div>
</template>

<script setup>
/**
 * Surface container: a white (or, in dark, panel-toned) box with a hairline edge. Pair with
 * `WCardSection` / `WCardActions` for its internal bands.
 *
 * There is no `flat` prop: Cardinal separates a card from its ground with a hairline, never with
 * elevation -- `--shadow-card` is `none` under Ledger for exactly that reason, and `rounded-card`
 * is `0` there too, so this renders identically to before. Cobalt's `body.body--cobalt` block
 * (OpenProject #2767/#2772) gives both a real value instead: a soft shadow and an 8px radius.
 *
 * The hairline border reads through the `--border-card` token (own `<style>` block below) rather
 * than a plain Tailwind `border-hairline`/`dark:border-hairline-dark` pair -- the same
 * `--border-card`/`--radius-card` pairing `NavEditMenu.vue` already consumes. It is `1px solid
 * var(--color-hairline)` under Ledger light, `1px solid var(--color-hairline-dark)` under Ledger
 * dark (`tailwind.css`'s `body.body--dark` block, OpenProject #2811), and `0` under Cobalt (both
 * light and dark) -- Cobalt draws its card edge with `--shadow-card` instead, per the block above.
 */
defineProps({
  /** Lays sections out in a row instead of stacked. */
  horizontal: {
    type: Boolean,
    default: false
  }
})
</script>

<style scoped>
.w-card {
  border: var(--border-card);
}
</style>
