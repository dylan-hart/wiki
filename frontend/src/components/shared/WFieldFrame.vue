<template>
  <!--
    `max-w-full`: the field is often a flex item in a fixed-width track -- the admin rows put one
    in a `flex: 0 0 120px` section. `align-items: stretch` only ever GROWS an item to fill its
    container; it will not shrink one whose content is wider, so a text input at its natural width
    pushed the field past the section and out of the card. The cap does the shrinking, and stretch
    still handles the growing.
  -->
  <div :class="[variantClass, 'max-w-full', 'min-w-0', rootClass]" :style="rootStyle">
    <!--
      Cardinal labels a field from ABOVE, always. The Material alternative -- a label standing in the
      middle of the field at rest and rising into a notch cut in its own outline -- is gone with the
      rounded outline it rode on, and with the three interlocking measurements that kept the notch
      lined up under it.

      The design's own screens go further and drop the visible label entirely, letting a section
      header carry the meaning. That is not portable to this app: a `label` here is frequently the
      only thing that says what a field is (an admin form's dialogs, the page-properties panel), and
      dropping it would leave the accessible name on an `aria-label` nobody sighted can read. So a
      label that is passed is drawn, in Cardinal's own caption tone, and a field with nothing to say
      is exactly the bare box the design draws.
    -->
    <label
      v-if="label"
      :for="labelFor"
      class="mb-1 block text-caption text-text-secondary dark:text-text-secondary-dark">
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
      The line under the control that error and hint text occupy.

      Held open only when something could actually go there -- a hint, a validating rule, or a
      message showing right now. Reserving it unconditionally cost every plain field 24px of dead
      height, and because that height sits inside the field, it pushed the visible control above
      the centre of whatever row held it: measured at 8px above / 28px below in an item row.

      Where a rule exists the space stays reserved even with nothing to say, so the form does not
      shift the moment a message appears -- which is the reason to hold it at all.
    -->
    <div
      v-if="showsBottom"
      :id="bottomId"
      aria-live="polite"
      aria-atomic="true"
      class="min-h-5 pt-1 text-caption"
      :class="errorMessage ? 'text-negative' : 'text-text-caption dark:text-text-caption-dark'">
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
  /** Id of the real control, for the label's `for`. */
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
  /** The control's own static classes, which differ between a `<div>` and an unstyled `<button>`. */
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
  /** Id for the hint/error line, for a control pointing at it with `aria-describedby`. */
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
