<template>
  <!--
    `max-w-full`: the field is often a flex item in a fixed-width track -- the admin rows put one
    in a `flex: 0 0 120px` section. `align-items: stretch` only ever GROWS an item to fill its
    container; it will not shrink one whose content is wider, so a text input at its natural width
    pushed the field past the section and out of the card. The cap does the shrinking, and stretch
    still handles the growing.
  -->
  <div :class="[variantClass, 'max-w-full', 'min-w-0', rootClass]" :style="rootStyle">
    <!-- -> Only variants without an outline to rise into still label from above; see `hasFloatingLabel` -->
    <label
      v-if="label && !hasFloatingLabel"
      :for="labelFor"
      class="mb-1 block text-caption text-black/60 dark:text-white/70">
      {{ label }}
      <span v-if="required" class="text-negative pe-1" aria-hidden="true">&nbsp;*</span>
    </label>

    <component
      :is="controlTag"
      v-bind="controlProps"
      ref="controlEl"
      :class="[controlBaseClass, controlClasses]"
      :style="controlStyle">
      <!--
        The outline, as a fieldset whose legend cuts the notch the floated label sits in.

        A fieldset is the only element that interrupts its own top border for a child, which is what
        makes a real gap rather than a patch: the label needs no background of its own, so it works
        over a white card, a grey `alt-card` section or a dark surface alike. The legend widens from
        nothing to the label's width, and that transition IS the notch opening.

        `aria-hidden`, and the accessible name stays on the real label below.
      -->
      <fieldset
        v-if="hasFloatingLabel"
        aria-hidden="true"
        class="w-input-outline"
        :style="outlineStyle">
        <legend :class="isFloating ? 'w-input-outline-notch--open' : ''">
          <span
            >{{ label
            }}<span v-if="required" class="text-negative pe-1" aria-hidden="true"
              >&nbsp;*</span
            ></span
          >
        </legend>
      </fieldset>

      <!--
        A `<label for>` where the control is a sibling, a `<span id>` where it is this element's own
        ancestor: a label cannot sit inside the thing it labels, which is the case for a select whose
        control is the enclosing `<button>`. That variant points at this with `aria-labelledby`
        instead, which names it without displacing the selected value the way an `aria-label` would.
      -->
      <component
        :is="labelTag"
        v-if="hasFloatingLabel"
        :id="floatLabelId"
        :for="labelTag === 'label' ? labelFor : undefined"
        class="w-input-float"
        :class="[isFloating ? 'w-input-float--up' : '', floatColorClass]">
        {{ label }}
        <span v-if="required" class="text-negative pe-1" aria-hidden="true">&nbsp;*</span>
      </component>

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
      class="min-h-5 px-1 pt-1 text-caption"
      :class="errorMessage ? 'text-negative' : 'text-black/54 dark:text-white/60'">
      {{ errorMessage || hint }}
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'

/**
 * The Material field chrome `WInput` and `WSelect` both draw: the wrapper, the label (above the
 * field or floated into its outline), the notched fieldset that outline is made of, and the
 * hint/error line beneath. The control itself is this component's default slot.
 *
 * INTERNAL. Deliberately not registered in `components/shared/index.js`: it is not a field of its
 * own, it is the half of one that two components share, and every prop it takes is a value
 * `composables/fieldFrame.js` computed for its caller. A third field type would use both together;
 * nothing else should reach for either.
 *
 * The control element is rendered here rather than left to the caller because the notch and the
 * floated label sit INSIDE it, absolutely positioned against it -- so `controlTag` and
 * `controlProps` carry whatever that element is and however the caller wires it, and `controlEl` is
 * exposed for a caller that has to focus it.
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
  /** Id given to the floated label itself, for a control naming it with `aria-labelledby`. */
  floatLabelId: {
    type: String,
    default: null
  },
  /** `label` when the control is a sibling, `span` when the control encloses it. */
  labelTag: {
    type: String,
    default: 'label'
  },
  hasFloatingLabel: {
    type: Boolean,
    default: false
  },
  isFloating: {
    type: Boolean,
    default: false
  },
  floatColorClass: {
    type: String,
    default: null
  },
  outlineStyle: {
    type: Object,
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
