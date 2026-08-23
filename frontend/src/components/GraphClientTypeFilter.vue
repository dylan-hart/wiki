<template>
  <div class="graph-client-type-filter">
    <span class="graph-client-type-filter-caption">{{ label }}</span>
    <div class="graph-client-type-filter-options">
      <w-checkbox
        v-for="option in options"
        :key="option.value"
        :model-value="modelValue"
        :val="option.value"
        :label="option.label"
        @update:model-value="$emit('update:modelValue', $event)" />
    </div>
  </div>
</template>

<script setup>
/**
 * A checkbox group for narrowing a graph node-sizing metric down to whichever "client type(s)"
 * should count toward it.
 *
 * Shared, not duplicated, between Feature #1141 (edit-volume sizing, filtering
 * `pageHistory.via`'s `editor`/`mcp` split) and Feature #1140 (page-visit-volume sizing, filtering
 * the pageview log's own client-type column once #1227 lands): both need the identical
 * "which source(s) count" checkbox-group control, just against a different value domain -- so the
 * domain is passed in via `options` rather than hardcoded here.
 */
defineProps({
  /** The currently-checked option values. */
  modelValue: {
    type: Array,
    required: true
  },
  label: {
    type: String,
    required: true
  },
  /** `{ value, label }` pairs -- the checkbox domain, owned by the caller. */
  options: {
    type: Array,
    required: true
  }
})
defineEmits(['update:modelValue'])
</script>

<style scoped>
.graph-client-type-filter {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.graph-client-type-filter-caption {
  font-size: 11px;
  opacity: 0.7;
}

.graph-client-type-filter-options {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
</style>
