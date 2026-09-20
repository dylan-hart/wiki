<template>
  <div
    class="w-card-actions flex flex-nowrap items-center gap-2 border-t border-hairline p-2.5 dark:border-hairline-dark"
    :class="alignClass">
    <slot />
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  align: {
    type: String,
    default: 'left',
    validator: (v) => ['left', 'center', 'right', 'between', 'around'].includes(v)
  },
  vertical: {
    type: Boolean,
    default: false
  }
})

const ALIGN = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
  between: 'justify-between',
  around: 'justify-around'
}

const alignClass = computed(() => [
  ALIGN[props.align] ?? ALIGN.left,
  props.vertical ? 'flex-col items-stretch' : ''
])
</script>
