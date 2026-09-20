<template>
  <button
    type="button"
    role="switch"
    :aria-checked="String(isOn)"
    :aria-label="label ? undefined : ariaLabel"
    :aria-busy="loading || undefined"
    :disabled="isDisabled"
    class="w-toggle w-unstyled inline-flex flex-nowrap items-center gap-2 outline-offset-2 focus-visible:outline-2"
    :class="isDisabled ? 'w-toggle--disabled pointer-events-none' : 'cursor-pointer'"
    @click="toggle">
    <!--
      One `--radius-pill` covers both shapes with no separate case: on the knob a pill radius
      exceeds half the box and clamps to a full circle, the way `rounded-full` would draw it.
    -->
    <span
      class="w-toggle__track relative inline-flex shrink-0 items-center rounded-pill border p-0.5 transition-colors"
      :class="[
        dense ? 'h-4 w-7' : 'h-[18px] w-[34px]',
        isOn
          ? 'w-toggle__track--on justify-end'
          : 'justify-start border-slate-pale bg-tint dark:border-border-dark dark:bg-dark-4'
      ]">
      <span v-if="loading" class="absolute inset-0 flex items-center justify-center">
        <w-spinner :size="dense ? '10px' : '12px'" />
      </span>
      <span
        v-else
        class="w-toggle__knob rounded-pill transition-colors"
        :class="[
          dense ? 'size-3' : 'size-3.5',
          isOn ? 'bg-white' : 'bg-slate-pale dark:bg-disabled-dark'
        ]" />
    </span>
    <span v-if="label" class="w-toggle__label pt-px text-caption">{{ label }}</span>
  </button>
</template>

<script setup>
import { computed } from 'vue'
import { useToggleModel } from '@/composables/toggleModel'

/**
 * Both the fill and the knob's position carry the state, so it survives a viewer who cannot tell
 * the two fills apart. No glyph in the knob and no glow under it: a tick/cross pair is a third
 * statement of the same fact, and it forces a second colour decision (which green, which red) on a
 * control that has no business making one. There is no `color` prop either -- a toggle that needs
 * to signal danger should say so in its label.
 *
 * The label's `pt-px` is optical centring, the same compensation WInput makes: an ascent exceeding
 * its descent puts a geometrically-centred line box above the middle of the track beside it.
 *
 * `loading` is for a value seeded with a placeholder default that an async `load()` overwrites:
 * bound straight through, the toggle would mount on the placeholder and visibly animate to the
 * fetched value the moment it lands. A spinner in place of the knob means it never animates from a
 * state that was never real.
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
  /** Required when there is no `label`, so the control is still announced. */
  ariaLabel: {
    type: String,
    default: null
  },
  dense: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  loading: {
    type: Boolean,
    default: false
  },
  /** Present only when `modelValue` is an array: the value this toggle contributes to it. */
  val: {
    type: null,
    default: undefined
  }
})

const emit = defineEmits(['update:modelValue'])

const { isOn, toggle } = useToggleModel(props, emit)

const isDisabled = computed(() => props.disabled || props.loading)
</script>

<style scoped>
/*
  The "on" fill is the themeable accent -- a custom property rather than a fixed palette step, so no
  utility can state it. It goes on the border as well as the background, so the track does not
  change size between its two states.

  Disabled drops the fill rather than merely dimming it: the fill is what makes the control read as
  operable.
*/
.w-toggle__track--on {
  background-color: var(--color-accent);
  border-color: var(--color-accent);
}

.w-toggle--disabled {
  opacity: 0.55;
}

.w-toggle--disabled .w-toggle__track {
  background-color: var(--color-tint);
  border-color: var(--color-slate-pale);
}

:global(body.body--dark .w-toggle--disabled .w-toggle__track) {
  background-color: var(--color-dark-4);
  border-color: var(--color-border-dark);
}

.w-toggle--disabled .w-toggle__knob {
  background-color: var(--color-slate-pale);
}

:global(body.body--dark .w-toggle--disabled .w-toggle__knob) {
  background-color: var(--color-disabled-dark);
}
</style>
