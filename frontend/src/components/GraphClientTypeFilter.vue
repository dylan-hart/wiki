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
        color="segment-selected"
        @update:model-value="$emit('update:modelValue', $event)" />
    </div>
  </div>
</template>

<script setup>
/**
 * Shared by the edit-volume and visit-volume node-sizing metrics, which need the same "which
 * source(s) count" control over different value domains -- hence `options` as a prop.
 */
defineProps({
  modelValue: {
    type: Array,
    required: true
  },
  label: {
    type: String,
    required: true
  },
  /** `{ value, label }` pairs. */
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

  /*
    Sits in a transparent overlay over the graph canvas, with no page-level ancestor supplying a
    dark-aware text color, and the `w-checkbox` labels are colorless by design -- without a color
    declared here both fall back to browser-default black, illegible in dark mode.
  */
  .body--light & {
    color: rgba(0, 0, 0, 0.8);
  }
  .body--dark & {
    color: #fff;
  }
}

/*
  Keep in sync with `.graph-view-control-caption` in Graph.vue: the mono, letter-spaced overline
  every other graph-control label uses, so this caption reads as one of them.
*/
.graph-client-type-filter-caption {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;

  .body--light & {
    color: var(--color-text-caption);
  }
  .body--dark & {
    color: var(--color-text-caption-dark);
  }
}

/*
  `flex-wrap` is a fallback for a locale whose labels overflow the panel width, not the expected
  layout; `justify-content: flex-end` keeps any wrapped remainder aligned with the right-aligned
  control panel.
*/
.graph-client-type-filter-options {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 4px 12px;
}
</style>
