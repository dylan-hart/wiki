<template>
  <div class="api-key-scope-picker rounded border border-grey-4 dark:border-grey-8">
    <div
      v-for="group in groups"
      :key="group.verb"
      class="api-key-scope-picker__group border-b border-grey-4 last:border-b-0 dark:border-grey-8">
      <div class="flex items-center gap-2 px-2 py-1.5">
        <w-checkbox
          :model-value="groupState(group) === 'all'"
          :indeterminate="groupState(group) === 'mixed'"
          :aria-label="group.verb"
          @update:model-value="onGroupToggle(group, $event)" />
        <button
          type="button"
          class="api-key-scope-picker__group-toggle flex flex-1 items-center gap-2 text-left"
          :aria-expanded="String(isExpanded(group.verb))"
          @click="toggleExpanded(group.verb)">
          <span class="text-caption font-medium">{{ group.verb }}</span>
          <span class="text-caption text-grey-6"
            >{{ selectedCount(group) }}/{{ group.scopes.length }}</span
          >
          <w-icon
            name="mdi:chevron-down"
            size="1em"
            class="api-key-scope-picker__arrow ml-auto"
            :class="isExpanded(group.verb) ? 'rotate-180' : ''" />
        </button>
      </div>
      <div v-show="isExpanded(group.verb)" class="api-key-scope-picker__scopes pb-1 ps-8">
        <div v-for="scope in group.scopes" :key="scope" class="py-0.5">
          <w-checkbox
            :model-value="modelValue"
            :val="scope"
            :label="scope"
            @update:model-value="$emit('update:modelValue', $event)" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive } from 'vue'
import { API_KEY_SCOPES, groupScopesByVerb } from '@/helpers/apiKeyScopes'

/**
 * The PAT scope field (OpenProject #1272): a two-level, verb-grouped tree of the closed scope
 * vocabulary, replacing the earlier flat `w-select multiple use-chips` field. Level 1 is one node
 * per verb (`access`, `manage`, `read`, `write`, `delete`, `review`, derived from the actual scope
 * list rather than hard-coded, so a verb with a single member -- `review` currently has only
 * `review:pages` -- still renders as its own single-item group) with a tri-state group checkbox
 * (`WCheckbox`'s `indeterminate`, task #1271) that selects or deselects every scope under it in one
 * click. Level 2 is the individual `verb:resource` scopes, independently checkable, under an
 * expandable/collapsible group body.
 *
 * The wire shape is unchanged: `modelValue` is (and `update:modelValue` emits) a flat array of
 * `verb:resource` scope strings, exactly what `keyScope` always was -- this is a picker UX change
 * only. Shared by both `ApiKeyCreateDialog.vue` and `ProfileApiKeyCreateDialog.vue`.
 */
const props = defineProps({
  modelValue: {
    type: Array,
    default: () => []
  },
  /** Override for testing; defaults to the full closed scope vocabulary. */
  scopes: {
    type: Array,
    default: () => API_KEY_SCOPES
  }
})

const emit = defineEmits(['update:modelValue'])

const groups = groupScopesByVerb(props.scopes)

// -> Collapsed by default: a scope entry a caller has no reason to open stays out of the way, and
//    there is no server-side or route state to restore an open group from across a re-mount.
const expandedVerbs = reactive(new Set())

function isExpanded(verb) {
  return expandedVerbs.has(verb)
}

function toggleExpanded(verb) {
  if (expandedVerbs.has(verb)) {
    expandedVerbs.delete(verb)
  } else {
    expandedVerbs.add(verb)
  }
}

function selectedCount(group) {
  return group.scopes.filter((scope) => props.modelValue.includes(scope)).length
}

function groupState(group) {
  const checked = selectedCount(group)
  if (checked === 0) return 'none'
  if (checked === group.scopes.length) return 'all'
  return 'mixed'
}

/**
 * The group checkbox's own `modelValue` is `groupState(group) === 'all'` (a plain boolean), so
 * `WCheckbox`'s own click handler emits the flip of that: `true` when the group was 'none' or
 * 'mixed' (select every child -- the tri-state convention task #1271 documents), `false` when it
 * was fully 'all' (deselect every child).
 */
function onGroupToggle(group, selectAll) {
  const withoutGroup = props.modelValue.filter((scope) => !group.scopes.includes(scope))
  emit('update:modelValue', selectAll ? [...withoutGroup, ...group.scopes] : withoutGroup)
}
</script>
