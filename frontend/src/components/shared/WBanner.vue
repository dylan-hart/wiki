<template>
  <div
    class="w-banner flex gap-3 rounded-control px-3 py-2.5 text-body2"
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
 * Carries no colour of its own: a caller sets the surface with a utility class. The three variants
 * are a hairline box on `--color-tint` for information, a `--color-warning-fill` block under
 * `--color-ink` for a caution, and `--color-negative` under white for a refusal.
 */
defineProps({
  dense: {
    type: Boolean,
    default: false
  },
  inlineActions: {
    type: Boolean,
    default: false
  }
})
</script>
