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
      A square track with a square knob pushed to one end: on is a solid accent block with a white
      knob at the trailing edge, off is a tinted box with a hairline edge and a pale slate knob at
      the leading one. State is read from which end the knob sits at and from the fill behind it.

      No relief, no glow and no glyph in the knob. The switch this replaces was a recessed channel
      with a knob standing proud of it, lit from the top left, carrying a tick or a cross -- all of
      which went with the app's relief generally; Cardinal separates a control from its ground with
      a hairline, not with light.
    -->
    <span
      class="w-toggle__track relative inline-flex shrink-0 items-center border p-0.5 transition-colors"
      :class="[
        dense ? 'h-4 w-7' : 'h-[18px] w-[34px]',
        isOn
          ? 'w-toggle__track--on justify-end'
          : 'justify-start border-slate-pale bg-tint dark:border-border-dark dark:bg-dark-4'
      ]">
      <!--
        While the real value is still being fetched, a spinner stands in for the knob rather than
        the knob rendering at its `false` default and sliding across once `loading` drops -- see the
        file header comment.
      -->
      <span v-if="loading" class="absolute inset-0 flex items-center justify-center">
        <w-spinner :size="dense ? '10px' : '12px'" />
      </span>
      <span
        v-else
        class="w-toggle__knob transition-colors"
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
 * On/off switch.
 *
 * A square track with a square knob at one end. On is the accent fill with a white knob pushed to
 * the trailing edge; off is a tinted box with a hairline edge and a pale slate knob at the leading
 * one. Both the fill and the knob's position say the same thing, so the state survives a viewer who
 * cannot tell the two fills apart.
 *
 * There are no glyphs in the knob and no glow under it. The tick/cross pair the previous switch
 * carried was a third statement of the same fact, and it forced a second colour decision (which
 * green, which red) on a control that has no business making one.
 *
 * The label's `pt-px` is optical centring, the same compensation WInput makes: an ascent exceeding
 * its descent puts a geometrically-centred line box above the middle of the track beside it.
 *
 * There is no `color` prop: the switch says the same thing everywhere, in one place, rather than
 * each caller picking a tint. A toggle that needs to signal danger should say so in its label.
 *
 * `loading` is for a value seeded with a placeholder default (`false`, typically) that an async
 * `load()` overwrites once the real value arrives: bound straight through, the toggle would mount on
 * the placeholder and visibly animate to the fetched value the moment it lands. Passing
 * `:loading="state.loading"` for as long as that fetch is in flight swaps the knob for a spinner
 * instead, so the control mounts already showing its real state and never animates from a wrong one.
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
  /** Shows a spinner in place of the knob and blocks interaction -- see the file header comment. */
  loading: {
    type: Boolean,
    default: false
  },
  /**
   * Present only when `modelValue` is an array: the value this toggle contributes to it. Lets a set
   * of toggles bind to one array of selected values.
   */
  val: {
    type: null,
    default: undefined
  }
})

const emit = defineEmits(['update:modelValue'])

// COMPUTED

// -> The boolean-or-array model is shared with WCheckbox; see `composables/toggleModel.js`
const { isOn, toggle } = useToggleModel(props, emit)

const isDisabled = computed(() => props.disabled || props.loading)
</script>

<style scoped>
/*
  Two things a utility cannot state here.

  The "on" fill is the themeable accent, which is a custom property rather than a fixed palette step
  -- so it has to be written as `var()`, and it is written on both the background and the border so
  the track does not change size between its two states.

  And the disabled treatment: flat and colourless. The fill is what makes the control read as
  operable, so it goes rather than merely dimming -- a switch that stays accent-red while nobody can
  move it says the wrong thing.
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
