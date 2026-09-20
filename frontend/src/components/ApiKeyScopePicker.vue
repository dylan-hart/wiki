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
            name="tabler:chevron-down"
            size="1em"
            class="api-key-scope-picker__arrow ms-auto"
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
 * A two-level, verb-grouped tree over the closed scope vocabulary. The verbs are derived from the
 * scope list rather than hard-coded, so a verb with a single member still renders as its own group.
 * `modelValue` stays a flat array of `verb:resource` strings -- the grouping is presentation only.
 */
const props = defineProps({
  modelValue: {
    type: Array,
    default: () => []
  },
  /** Override for testing; the default is the full closed vocabulary. */
  scopes: {
    type: Array,
    default: () => API_KEY_SCOPES
  }
})

const emit = defineEmits(['update:modelValue'])

const groups = groupScopesByVerb(props.scopes)

// -> Collapsed by default, and expansion is local: there is no server or route state to restore an
//    open group from across a re-mount.
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
 * The group checkbox's own `modelValue` is the plain boolean `groupState(group) === 'all'`, so
 * `WCheckbox`'s click handler emits the flip of that: `true` when the group was 'none' or 'mixed'
 * (select every child), `false` when it was fully 'all' (deselect every child).
 */
function onGroupToggle(group, selectAll) {
  const withoutGroup = props.modelValue.filter((scope) => !group.scopes.includes(scope))
  emit('update:modelValue', selectAll ? [...withoutGroup, ...group.scopes] : withoutGroup)
}
</script>
