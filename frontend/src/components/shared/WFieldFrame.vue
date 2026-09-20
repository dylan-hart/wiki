<template>
  <!--
    `max-w-full`: the field is often a flex item in a fixed-width track. `align-items: stretch` only
    ever GROWS an item to fill its container and will not shrink one whose content is wider, so a
    text input at its natural width pushes the field out of the card. The cap does the shrinking.
  -->
  <div :class="[variantClass, 'max-w-full', 'min-w-0', rootClass]" :style="rootStyle">
    <!--
      Cardinal labels a field from ABOVE, always: no Material floating label rising into a notch cut
      in an outline this design no longer has. The design's own screens go further and drop the
      visible label entirely, letting a section header carry the meaning, which is not portable
      here -- a `label` is frequently the only thing that says what a field is, and dropping it
      would leave the accessible name on an `aria-label` nobody sighted can read.
    -->
    <label v-if="label" :for="labelFor" class="w-field-label mb-1 block">
      {{ label }}
      <span v-if="required" class="text-negative pe-1" aria-hidden="true">&nbsp;*</span>
    </label>

    <component
      :is="controlTag"
      v-bind="controlProps"
      ref="controlEl"
      :class="[controlBaseClass, controlClasses]"
      :style="controlStyle">
      <slot />
    </component>

    <!--
      Held open only when something could actually go there -- a hint, a validating rule, or a
      message showing right now. Reserving it unconditionally costs every plain field a line of dead
      height inside the field, which pushes the visible control above the centre of the row holding
      it. Where a rule exists the space stays reserved even with nothing to say, so the form does
      not shift the moment a message appears.
    -->
    <div
      v-if="showsBottom"
      :id="bottomId"
      aria-live="polite"
      aria-atomic="true"
      class="w-field-message min-h-5 pt-1"
      :class="
        errorMessage
          ? 'w-field-message--error text-negative'
          : 'w-field-message--hint text-text-caption dark:text-text-caption-dark'
      ">
      {{ errorMessage || hint }}
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'

/**
 * The field chrome `WInput` and `WSelect` both draw: the wrapper, the label above the field, and
 * the hint/error line beneath. The control itself is this component's default slot.
 *
 * INTERNAL. Deliberately not registered in `components/shared/index.js`: it is not a field of its
 * own, it is the half of one that two components share, and every prop it takes is a value
 * `composables/fieldFrame.js` computed for its caller. A third field type would use both together;
 * nothing else should reach for either.
 *
 * The control element is rendered here rather than left to the caller because the frame ring is an
 * inset shadow on it and `controlClasses` sizes it -- so `controlTag` and `controlProps` carry
 * whatever that element is and however the caller wires it, and `controlEl` is exposed for a caller
 * that has to focus it.
 */
defineProps({
  /** `w-input` / `w-select` — the hook the stylesheets and call-site selectors reach for. */
  variantClass: {
    type: String,
    required: true
  },
  /** The caller's own `class`/`style`, which belong to the whole field rather than to the control. */
  rootClass: {
    type: [String, Array, Object],
    default: null
  },
  rootStyle: {
    type: [String, Array, Object],
    default: null
  },
  label: {
    type: String,
    default: null
  },
  required: {
    type: Boolean,
    default: false
  },
  hint: {
    type: String,
    default: null
  },
  labelFor: {
    type: String,
    default: null
  },
  controlTag: {
    type: String,
    default: 'div'
  },
  /** Everything the caller binds onto the control element, listeners included. */
  controlProps: {
    type: Object,
    default: () => ({})
  },
  controlBaseClass: {
    type: String,
    default: null
  },
  controlClasses: {
    type: Array,
    default: () => []
  },
  controlStyle: {
    type: Object,
    default: null
  },
  showsBottom: {
    type: Boolean,
    default: false
  },
  bottomId: {
    type: String,
    default: null
  },
  errorMessage: {
    type: String,
    default: null
  }
})

const controlEl = ref(null)

defineExpose({ controlEl })
</script>

<style scoped>
/*
  Field typography (cobalt-typography.md §3, "Shared primitives"). Explicit rather than the Material
  `text-caption` utility: that is a 12px/400 Material role reaching a Cardinal-drawn one, and the
  label's own role is 500/14px ("Field label", the same swatch `WSettingsRow.vue`'s row label
  draws). Hint and error are deliberately two DIFFERENT sizes in the design, so `.w-field-message`
  carries what they share and each modifier carries only the size.
*/
.w-field-label {
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 500;
  letter-spacing: normal;
  color: var(--color-ink);
}

:global(body.body--dark .w-field-label) {
  color: var(--color-text-dark);
}

.w-field-message {
  font-family: var(--font-sans);
  font-weight: 400;
  letter-spacing: normal;
}

.w-field-message--hint {
  font-size: 12.5px;
}

.w-field-message--error {
  font-size: 11.5px;
}
</style>
