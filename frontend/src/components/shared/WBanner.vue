<template>
  <div
    class="w-banner flex gap-3 px-3 py-2.5 text-body2"
    :class="[dense ? 'py-1.5' : '', inlineActions ? 'flex-nowrap items-center' : 'flex-wrap']">
    <div v-if="$slots.avatar" class="flex shrink-0 items-center">
      <slot name="avatar" />
    </div>
    <div class="min-w-0 flex-1">
      <slot />
    </div>
    <div
      v-if="$slots.action"
      class="flex shrink-0 flex-nowrap items-center gap-2"
      :class="inlineActions ? '' : 'ms-auto'">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup>
/**
 * Prominent inline message with an optional leading icon and trailing actions.
 *
 * Square and unpadded-looking by Cardinal's standards -- 12px in from each edge, no radius, no
 * shadow. Carries no colour of its own: callers set the surface with a utility class, which is how
 * the existing banners are already written, and the design's three variants are exactly that --
 * a hairline box on `--color-tint` for information, a `--color-warning-fill` block under
 * `--color-ink` for a caution, and `--color-negative` under white for a refusal.
 */
defineProps({
  dense: {
    type: Boolean,
    default: false
  },
  /** Keeps the actions on the same row rather than wrapping them below. */
  inlineActions: {
    type: Boolean,
    default: false
  }
})
</script>
