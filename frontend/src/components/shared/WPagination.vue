<template>
  <nav
    v-if="max > 1"
    class="w-pagination flex flex-nowrap items-center gap-1"
    :aria-label="resolvedAriaLabel">
    <button
      v-if="directionLinks"
      type="button"
      class="w-unstyled w-pagination-btn"
      :disabled="modelValue <= 1"
      :aria-label="resolvedPrevLabel"
      @click="go(modelValue - 1)">
      <w-icon name="tabler:chevron-left" />
    </button>

    <template v-for="(page, idx) of pages" :key="idx">
      <span v-if="page === GAP" class="px-1 text-black/40 dark:text-white/40" aria-hidden="true"
        >…</span
      >
      <button
        v-else
        type="button"
        class="w-unstyled w-pagination-btn"
        :class="page === modelValue ? 'w-pagination-btn--active' : ''"
        :aria-current="page === modelValue ? 'page' : undefined"
        :aria-label="`${resolvedPageLabel} ${page}`"
        @click="go(page)">
        {{ page }}
      </button>
    </template>

    <button
      v-if="directionLinks"
      type="button"
      class="w-unstyled w-pagination-btn"
      :disabled="modelValue >= max"
      :aria-label="resolvedNextLabel"
      @click="go(modelValue + 1)">
      <w-icon name="tabler:chevron-right" />
    </button>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import { useDictText } from '@/composables/i18nText'

const props = defineProps({
  modelValue: {
    type: Number,
    default: 1
  },
  max: {
    type: Number,
    required: true
  },
  maxPages: {
    type: Number,
    default: 7
  },
  boundaryNumbers: {
    type: Boolean,
    default: false
  },
  directionLinks: {
    type: Boolean,
    default: false
  },
  ariaLabel: {
    type: String,
    default: null
  },
  pageLabel: {
    type: String,
    default: null
  },
  prevLabel: {
    type: String,
    default: null
  },
  nextLabel: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:modelValue'])

const dictText = useDictText()
const resolvedAriaLabel = computed(
  () => props.ariaLabel ?? dictText('common.pagination.ariaLabel', 'Pagination')
)
const resolvedPageLabel = computed(
  () => props.pageLabel ?? dictText('common.pagination.page', 'Page')
)
const resolvedPrevLabel = computed(
  () => props.prevLabel ?? dictText('common.pagination.previousPage', 'Previous page')
)
const resolvedNextLabel = computed(
  () => props.nextLabel ?? dictText('common.pagination.nextPage', 'Next page')
)

/** A Symbol so it cannot collide with a page number. */
const GAP = Symbol('gap')

const pages = computed(() => {
  const { max, maxPages, boundaryNumbers, modelValue } = props
  if (max <= maxPages) {
    return Array.from({ length: max }, (_, i) => i + 1)
  }

  const half = Math.floor(maxPages / 2)
  let start = Math.max(1, modelValue - half)
  let end = Math.min(max, start + maxPages - 1)
  start = Math.max(1, end - maxPages + 1)

  const out = []
  for (let p = start; p <= end; p++) {
    out.push(p)
  }

  if (boundaryNumbers) {
    // -> Replace, rather than prepend, so the control keeps a stable width as the page changes
    if (out[0] !== 1) {
      out[0] = 1
      if (out[1] !== 2) {
        out[1] = GAP
      }
    }
    if (out[out.length - 1] !== max) {
      out[out.length - 1] = max
      if (out[out.length - 2] !== max - 1) {
        out[out.length - 2] = GAP
      }
    }
  }
  return out
})

function go(page) {
  const target = Math.min(props.max, Math.max(1, page))
  if (target !== props.modelValue) {
    emit('update:modelValue', target)
  }
}
</script>

<style scoped>
.w-pagination-btn {
  min-width: 2rem;
  height: 2rem;
  padding-inline: 0.375rem;
  border-radius: 0.25rem;
  font-size: 0.875rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.w-pagination-btn:hover:not(:disabled) {
  background-color: rgb(0 0 0 / 0.06);
}
:global(body.body--dark .w-pagination-btn:hover:not(:disabled)) {
  background-color: rgb(255 255 255 / 0.1);
}
.w-pagination-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.w-pagination-btn--active {
  background-color: var(--color-primary);
  color: var(--color-white);
}
.w-pagination-btn--active:hover {
  background-color: var(--color-primary);
}
</style>
