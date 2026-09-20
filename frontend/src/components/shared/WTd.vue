<template>
  <td
    class="w-td relative px-4 py-2 align-middle"
    :class="alignClass"
    :style="props.props?.col?.style">
    <slot />
  </td>
</template>

<script setup>
import { computed } from 'vue'
import { CELL_ALIGN } from './metrics'

/**
 * Takes the body slot's own props object, so the cell inherits its column's alignment and width
 * without the call site restating them:
 *
 *   <template #body-cell-name="props">
 *     <w-td :props="props">...</w-td>
 *   </template>
 */
const props = defineProps({
  /** The `body-cell-*` slot props, i.e. `{ row, col, value }`. */
  props: {
    type: Object,
    default: null
  }
})

const alignClass = computed(() => CELL_ALIGN[props.props?.col?.align] ?? CELL_ALIGN.left)
</script>
