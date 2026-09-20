<template>
  <button
    type="button"
    role="checkbox"
    :aria-checked="indeterminate ? 'mixed' : String(isOn)"
    :aria-label="label ? undefined : ariaLabel"
    :disabled="isDisabled"
    class="w-checkbox w-unstyled inline-flex flex-nowrap items-center gap-2 outline-offset-2 focus-visible:outline-2"
    :class="isDisabled ? 'pointer-events-none opacity-60' : 'cursor-pointer'"
    @click="toggle">
    <!--
      Indeterminate fills the same as checked (an empty box reads as unchecked, not as a third
      state) but shows a dash rather than the tick, so all three states stay distinct.

      The tick stays WHITE in both themes rather than taking dark ink on a lightened accent: `color`
      is one themeable custom property with a single value for both themes, so the fill under this
      glyph is identical on ink and on paper, and white clears the contrast floor on it where dark
      ink does not.
    -->
    <span
      class="w-checkbox__box inline-flex shrink-0 items-center justify-center rounded-mark border transition-colors"
      :class="[
        dense ? 'size-3' : 'size-[13px]',
        isOn || indeterminate
          ? 'w-checkbox__box--on text-white'
          : 'border-slate-pale dark:border-disabled-dark'
      ]"
      :style="
        isOn || indeterminate
          ? { backgroundColor: `var(--color-${color})`, borderColor: `var(--color-${color})` }
          : undefined
      ">
      <w-icon v-if="indeterminate" name="tabler:minus" :size="dense ? '0.75em' : '0.85em'" />
      <w-icon v-else-if="isOn" name="tabler:check" :size="dense ? '0.75em' : '0.85em'" />
    </span>
    <!--
      Explicit dark-mode-aware colour, not `color: inherit` from `.w-unstyled` on the root button:
      inside a container that sets no text colour of its own (`body` sets none) inherit leaves this
      black in dark mode.
    -->
    <span v-if="label" class="pt-px text-caption text-ink dark:text-text-dark">{{ label }}</span>
  </button>
</template>

<script setup>
import { computed } from 'vue'
import { useToggleModel } from '@/composables/toggleModel'

const props = defineProps({
  modelValue: {
    type: [Boolean, Array],
    default: false
  },
  label: {
    type: String,
    default: null
  },
  /** Required when there is no `label`. */
  ariaLabel: {
    type: String,
    default: null
  },
  color: {
    type: String,
    default: 'primary'
  },
  dense: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  /**
   * Tri-state "mixed" rendering, for a group checkbox standing in for partly-selected children.
   * Purely visual: it adds no click semantics, so a click still emits `toggle()`'s plain boolean
   * flip and the parent decides what that means (conventionally "select every child").
   */
  indeterminate: {
    type: Boolean,
    default: false
  },
  /** The value this box contributes when `modelValue` is an array. */
  val: {
    type: null,
    default: undefined
  }
})

const emit = defineEmits(['update:modelValue'])

const { isOn, toggle } = useToggleModel(props, emit)

const isDisabled = computed(() => props.disabled)
</script>

<style scoped>
.w-checkbox__box {
  /* -> Sits on the surface it is drawn on, rather than carrying a well colour of its own */
  background-color: transparent;
}
</style>
