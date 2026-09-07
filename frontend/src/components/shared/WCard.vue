<template>
  <!--
    The surface colours live on `.w-card` in `@layer components` (see `css/tailwind.css`), not here.
    As utilities they outranked the `bg-negative` / `bg-info` the admin pages tint their notice cards
    with, since two background utilities are ordered within the layer rather than by who wrote them.
  -->
  <div
    class="w-card relative rounded-card border border-hairline shadow-card dark:border-hairline-dark"
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
 * The hairline border itself stays a plain Tailwind `border-hairline`/`dark:border-hairline-dark`
 * pair rather than the new `--border-card` token: that token has no dark-mode-specific value (it is
 * declared once, in bare `:root`, as `1px solid var(--color-hairline)` -- the LIGHT hairline), so
 * consuming it here would silently paint Ledger's dark cards with the light hairline colour.
 * Flagged for follow-up rather than fixed, since a safe fix needs `--border-card` to become
 * dark-aware in `tailwind.css` itself, which is out of this task's file ownership this round.
 */
defineProps({
  /** Lays sections out in a row instead of stacked. */
  horizontal: {
    type: Boolean,
    default: false
  }
})
</script>
