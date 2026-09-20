<template>
  <div
    ref="listEl"
    class="w-tabs flex flex-nowrap items-stretch gap-1 overflow-x-auto rounded-lg bg-grey-2 p-1 dark:bg-dark-5"
    role="tablist"
    @keydown="onKeydown">
    <slot />
  </div>
</template>

<script setup>
import { computed, provide, ref } from 'vue'

/**
 * Panels are either a `WTabPanels` or plain `v-if` on the same model.
 *
 * The track fill is a utility rather than a rule in this file's stylesheet, so a caller putting the
 * strip on a surface of its own can still override it with a class like `alt-card`: an SFC
 * stylesheet is emitted unlayered and would outrank any such class.
 *
 * Simplification: no scroll arrows and no overflow menu -- the strip simply scrolls if it cannot
 * fit.
 */
const props = defineProps({
  modelValue: {
    type: [String, Number],
    default: null
  },
  noCaps: {
    type: Boolean,
    default: false
  },
  inlineLabel: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:modelValue'])

const listEl = ref(null)

provide('wTabs', {
  current: computed(() => props.modelValue),
  noCaps: computed(() => props.noCaps),
  inlineLabel: computed(() => props.inlineLabel),
  select: (name) => emit('update:modelValue', name)
})

/** On the strip rather than on each tab: only the strip knows what a tab's neighbours are. */
function onKeydown(ev) {
  const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' }
  const move = keys[ev.key]
  if (move === undefined) {
    return
  }
  const tabs = [...listEl.value.querySelectorAll('[role="tab"]:not(:disabled)')]
  if (tabs.length === 0) {
    return
  }
  ev.preventDefault()
  const at = tabs.indexOf(document.activeElement)
  const next =
    move === 'first'
      ? 0
      : move === 'last'
        ? tabs.length - 1
        : (Math.max(at, 0) + move + tabs.length) % tabs.length
  tabs[next].focus()
  tabs[next].click()
}
</script>
