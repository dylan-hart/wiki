<template>
  <div class="w-table relative" :class="flat ? '' : 'rounded shadow-card'">
    <table class="w-full border-collapse text-start">
      <thead v-if="!hideHeader">
        <tr>
          <th
            v-for="col of columns"
            :key="col.name"
            :style="col.headerStyle ?? col.style"
            class="w-table__cell px-4 py-2 text-body2 font-medium text-black/54 dark:text-white/70"
            :class="[alignClass(col), col.sortable ? 'cursor-pointer select-none' : '']"
            :aria-sort="ariaSort(col)"
            @click="col.sortable ? sortBy(col) : undefined">
            {{ col.label }}
            <w-icon
              v-if="col.sortable"
              name="tabler:arrow-up"
              size="14px"
              class="align-middle transition-[opacity,transform]"
              :class="[
                sort.name === col.name ? 'opacity-100' : 'opacity-0',
                sort.name === col.name && sort.descending ? 'rotate-180' : ''
              ]" />
          </th>
        </tr>
      </thead>
      <tbody>
        <!--
          `h-[52px]` is a floor, not a fixed height: on a table row CSS treats `height` as a minimum
          and taller content still expands it. Without one, a row carrying action buttons stands
          taller than a row whose actions are hidden.
        -->
        <tr
          v-for="(row, rowIndex) of visibleRows"
          :key="rowKey ? row[rowKey] : rowIndex"
          class="w-table__row h-[52px]">
          <template v-for="col of columns" :key="col.name">
            <slot
              :name="`body-cell-${col.name}`"
              :row="row"
              :col="col"
              :value="cellValue(row, col)">
              <w-td :props="{ col }">{{ cellValue(row, col) }}</w-td>
            </slot>
          </template>
        </tr>
      </tbody>
    </table>
    <!--
      Guarded on `$slots['no-data']` so a call site drawing its own empty block gets no extra markup
      at all, rather than an empty padded div sitting above its own text.
    -->
    <div
      v-if="$slots['no-data'] && visibleRows.length === 0 && !loading"
      class="w-table__no-data p-4 text-center text-grey">
      <slot name="no-data" :rows-count="rows.length" :filter="filter" />
    </div>
    <w-inner-loading :showing="loading" />
  </div>
</template>

<script setup>
import { computed, reactive } from 'vue'
import { CELL_ALIGN } from './metrics'

/**
 * Simplifications against the table this replaces: no pagination, no selection, no virtual
 * scrolling, no top/bottom slots -- every call site asked for "all rows, no footer". Sorting stays,
 * since several tables mark columns sortable.
 *
 * The `#no-data` slot's `rowsCount` is the `rows` prop's own length, i.e. the count BEFORE this
 * component's `filter` narrows it, so a caller can tell "nothing exists yet" from "nothing
 * matched". It describes only filtering this component itself performed: a caller whose `rows` are
 * already narrowed server-side has to draw that distinction from its own search state.
 */
const props = defineProps({
  rows: {
    type: Array,
    default: () => []
  },
  /** `[{ name, label, field, align, sortable, format, style, headerStyle }]` */
  columns: {
    type: Array,
    default: () => []
  },
  rowKey: {
    type: String,
    default: null
  },
  flat: {
    type: Boolean,
    default: false
  },
  hideHeader: {
    type: Boolean,
    default: false
  },
  loading: {
    type: Boolean,
    default: false
  },
  /** Free-text filter, matched against every column's rendered value. */
  filter: {
    type: String,
    default: ''
  }
})

const sort = reactive({ name: null, descending: false })

function alignClass(col) {
  return CELL_ALIGN[col.align] ?? CELL_ALIGN.left
}

function ariaSort(col) {
  if (!col.sortable) {
    return undefined
  }
  if (sort.name !== col.name) {
    return 'none'
  }
  return sort.descending ? 'descending' : 'ascending'
}

function rawValue(row, col) {
  return typeof col.field === 'function' ? col.field(row) : row[col.field]
}

function cellValue(row, col) {
  const value = rawValue(row, col)
  return col.format ? col.format(value, row) : value
}

/**
 * Cycles ascending -> descending -> unsorted on repeated clicks of the same column header; a
 * different column always starts at ascending.
 */
function sortBy(col) {
  if (sort.name === col.name) {
    if (sort.descending) {
      sort.name = null
      sort.descending = false
    } else {
      sort.descending = true
    }
  } else {
    sort.name = col.name
    sort.descending = false
  }
}

const filteredRows = computed(() => {
  const needle = props.filter?.trim().toLowerCase()
  if (!needle) {
    return props.rows
  }
  return props.rows.filter((row) =>
    props.columns.some((col) =>
      String(cellValue(row, col) ?? '')
        .toLowerCase()
        .includes(needle)
    )
  )
})

const visibleRows = computed(() => {
  const col = props.columns.find((c) => c.name === sort.name)
  if (!col) {
    return filteredRows.value
  }

  const direction = sort.descending ? -1 : 1
  // -> Copy first: sorting the prop array in place would mutate the caller's state
  return [...filteredRows.value].sort((a, b) => {
    const left = rawValue(a, col)
    const right = rawValue(b, col)
    if (left === right) {
      return 0
    }
    if (left == null) {
      return -direction
    }
    if (right == null) {
      return direction
    }
    return (
      (typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right))) * direction
    )
  })
})
</script>

<style scoped>
/*
  Scaled pseudo-elements rather than a border, as in `.w-hairline`: a plain 1px border lands on a
  fractional device row under display scaling and paints unevenly. The cells are the positioning
  context (WTd sets `position: relative`) -- a <tr> is not a reliable containing block for an
  absolutely positioned child.
*/
.w-table__row + .w-table__row :deep(td)::before,
thead + tbody .w-table__row:first-child :deep(td)::before {
  content: '';
  position: absolute;
  top: 0;
  inset-inline-start: 0;
  inset-inline-end: 0;
  height: 1px;
  background-color: rgb(0 0 0 / 0.12);
  transform: scaleY(calc(1 / var(--w-dpr, 1)));
  transform-origin: top left;
  pointer-events: none;
}

:global(body.body--dark .w-table__row + .w-table__row td::before),
:global(body.body--dark thead + tbody .w-table__row:first-child td::before) {
  background-color: rgb(255 255 255 / 0.15);
}
</style>
