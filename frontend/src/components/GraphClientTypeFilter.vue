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

<style lang="scss" scoped>
.graph-client-type-filter {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;

  /*
    Sits in a transparent overlay directly over the graph canvas, with no page-level ancestor
    supplying a dark-aware text color -- both this caption and the `w-checkbox` option labels
    below it (deliberately colorless by design, per WCheckbox's own doc comment) inherit from
    here. Without this, both fall back to browser-default black in both themes, illegible only in
    dark mode (OpenProject #2522). Matches `.graph-view-control-caption`'s values in Graph.vue.
  */
  @at-root .body--light & {
    color: rgba(0, 0, 0, 0.8);
  }
  @at-root .body--dark & {
    color: #fff;
  }
}

.graph-client-type-filter-caption {
  font-size: 11px;
  opacity: 0.7;
}

/*
  `align-items: flex-start`, not `flex-end` like the caption above -- each `w-checkbox` is one flex
  item bundling its checkbox square and label together, so right-aligning the whole item lets a
  longer label ("Browser") push its checkbox glyph further left than a shorter one ("MCP")
  (OpenProject #1290). Left-aligning instead anchors every row's checkbox square (a fixed size) at
  the same x-offset, with the variable-width label trailing it -- the same effect a two-column grid
  (fixed checkbox column, label column) would give, without reaching into `WCheckbox`'s own layout.
*/
.graph-client-type-filter-options {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
</style>
