<template>
  <!--
    `leading-tight` rather than the inherited body line-height: a chip is a single nowrap line, so
    its height is its line box plus padding. Tight still clears the glyph box, which matters because
    the label span clips its overflow -- any less and descenders would be cut.
  -->
  <div
    class="w-chip inline-flex max-w-full flex-nowrap items-center gap-1.5 leading-tight align-middle"
    :class="classes"
    :style="styles"
    :tabindex="clickable ? 0 : undefined"
    :role="clickable ? 'button' : undefined"
    :title="title"
    @click="clickable && $emit('click', $event)"
    @keydown.enter.prevent="clickable && $emit('click', $event)">
    <w-icon v-if="icon" :name="icon" class="shrink-0" />
    <span class="truncate">
      <slot>{{ label }}</slot>
    </span>
    <button
      v-if="removable"
      type="button"
      class="w-unstyled shrink-0 cursor-pointer opacity-70 hover:opacity-100"
      :aria-label="resolvedRemoveLabel"
      @click.stop="$emit('remove')">
      <w-icon name="tabler:x" />
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useDictText } from '@/composables/i18nText'

const props = defineProps({
  label: {
    type: [String, Number],
    default: null
  },
  icon: {
    type: String,
    default: null
  },
  color: {
    type: String,
    default: null
  },
  textColor: {
    type: String,
    default: null
  },
  /** `xs` | `sm` | `md` | `lg`, or a CSS font-size. */
  size: {
    type: String,
    default: 'md'
  },
  dense: {
    type: Boolean,
    default: false
  },
  clickable: {
    type: Boolean,
    default: false
  },
  removable: {
    type: Boolean,
    default: false
  },
  removeLabel: {
    type: String,
    default: null
  },
  title: {
    type: String,
    default: null
  }
})

defineEmits(['click', 'remove'])

const dictText = useDictText()
const resolvedRemoveLabel = computed(
  () => props.removeLabel ?? dictText('common.chip.remove', 'Remove')
)

const SIZES = { xs: '10px', sm: '12px', md: '14px', lg: '16px' }

/*
  An uncoloured chip is an OUTLINE (surface with a hairline edge), not a grey fill: a tag row then
  reads as a row of small documents, and the solid fill stays free to mean "selected".
*/
const classes = computed(() => [
  'rounded-pill',
  props.dense ? 'px-1.5 py-0.5' : 'px-2 py-[3px]',
  props.clickable ? 'cursor-pointer hover:brightness-110' : '',
  props.color
    ? ''
    : 'border border-hairline bg-surface text-slate dark:border-border-dark dark:bg-dark-3 dark:text-text-secondary-dark'
])

const styles = computed(() => ({
  fontSize: SIZES[props.size] ?? props.size,
  backgroundColor: props.color ? `var(--color-${props.color})` : undefined,
  color: props.textColor ? `var(--color-${props.textColor})` : undefined
}))
</script>

<style scoped>
/*
  An avatar inside a chip is sized by the chip, not by the size it takes standing on its own, which
  would swallow the row. Relative rather than fixed px because a chip's font size is a prop and the
  avatar has to track it; `font-size: inherit` is what keeps these `em` lengths chip-ems.

  1.25em matches the `leading-tight` line box, so the avatar sits WITHIN the label's line instead of
  becoming the tallest thing in the box and growing the chip around it.

  A descendant selector, not a child one: everything slotted lands inside the truncating span, so a
  slotted avatar is a grandchild. That also puts it inline with the label rather than in the chip's
  own flex row, so the gap between them has to be this margin.
*/
.w-chip :deep(.w-avatar) {
  width: 1.25em;
  height: 1.25em;
  font-size: inherit;
  margin-inline-end: 0.45em;
}

.w-chip :deep(.w-avatar > .w-icon) {
  font-size: 0.85em;
}
</style>
