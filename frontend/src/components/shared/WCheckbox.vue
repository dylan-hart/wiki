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
      A square box with a hairline edge, matching the switch's track: off is an empty outline in the
      palest slate, on is a solid accent square with a white tick. The recessed-well relief this
      replaces -- a rim, paired inset shadows and a cast shadow, tuned separately from the switch's
      because a 20px box shows less gradient than a 48px channel -- is gone with the rest of it.

      Indeterminate fills the same as checked (an empty box reads as unchecked, not as a third
      state) but shows a dash rather than the tick, so all three states stay distinct.

      The tick stays WHITE in both themes rather than taking dark ink on a lightened accent the way
      the design's dark sheet does: `color` is a themeable custom property with one value for both
      themes, so the fill under this glyph is the same `#c14a52` on ink as it is on paper -- and
      white on that is 4.81:1, where dark ink would be 1.9:1.
    -->
    <span
      class="w-checkbox__box inline-flex shrink-0 items-center justify-center border transition-colors"
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
      Explicit dark-mode-aware color, not `color: inherit` from `.w-unstyled` on the root button:
      a container that sets no text color of its own (the `body` element itself sets none) left this
      black in dark mode. `text-ink dark:text-text-dark` is the same pairing `HeaderNav.vue` uses for
      the identical "must not depend on an ambient color" case.
    -->
    <span v-if="label" class="pt-px text-caption text-ink dark:text-text-dark">{{ label }}</span>
  </button>
</template>

<script setup>
import { computed } from 'vue'
import { useToggleModel } from '@/composables/toggleModel'

/**
 * Checkbox. Binds either a boolean, or a value within an array of selections via `val`.
 */
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
  /** Shrinks the box and its glyph, matching WToggle's and WInput's compact variant. */
  dense: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  /**
   * Tri-state "mixed" rendering, for a group checkbox standing in for a set of children that are
   * only partly selected. Purely visual -- it has no click semantics of its own beyond `toggle()`'s
   * usual boolean flip below, which is what the box's own `isOn` reads as `false` while
   * indeterminate (since `modelValue` is neither `true` nor an array containing `val`), so a click
   * still emits `true`. The parent decides what that means -- in a tri-state group checkbox, "select
   * every child", the standard tri-state convention.
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

// -> The boolean-or-array model is shared with WToggle; see `composables/toggleModel.js`
const { isOn, toggle } = useToggleModel(props, emit)

const isDisabled = computed(() => props.disabled)
</script>

<style scoped>
/*
  The accent fill is set inline from the `color` prop, so all this has to add is the ONE thing a
  utility cannot express here: what the box looks like in dark mode when it is off, and the border
  the filled state paints in its own colour so the box does not change size between states.

  The relief that used to live here -- rim, inset shadows, cast shadow, and a second heavier set for
  the filled state -- is gone with the app's relief generally. Cardinal separates a control from its
  ground with a hairline, not with light.
*/
.w-checkbox__box {
  /* -> Sits on the surface it is drawn on, rather than carrying a well colour of its own */
  background-color: transparent;
}
</style>
