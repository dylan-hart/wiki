import { computed, ref } from 'vue'

/**
 * The field chrome both text-entry components draw — `WInput` and `WSelect`.
 *
 * The two carried the same label/hint/error/frame logic by copy, parameterised in practice by only
 * two things: what each counts as "active" (focus for an input, an open dropdown for a select) and
 * whether it draws a frame at all (a `standout` select does not). Everything else — the props, the
 * validation, the computed styles — was identical, which is what lives here.
 *
 * The markup those styles feed is `components/shared/WFieldFrame.vue`, which is internal to those
 * two components and deliberately not registered in `components/shared/index.js`.
 *
 * ## Cardinal
 *
 * A field is a square box with a hairline edge, and its label stands ABOVE it. The Material
 * treatment this replaces — a rounded outline notched open by a fieldset legend so a label could
 * ride up into the border, thickening from 1px to 2px on focus — is gone entirely, along with
 * `w-input-outline`, `w-input-float` and their three interlocking measurements.
 *
 * Two consequences worth knowing:
 *
 *  - The frame is one pixel in EVERY state; only its colour changes (hairline at rest, the faint
 *    slate under the pointer, chrome slate on focus, the accent fill on error). It is still drawn
 *    as an inset ring rather than a real border, so a field's box never changes size — which also
 *    means a caller's own `border-*` utility does not fight it.
 *  - `outlined` is now inert. Cardinal has no underlined field variant, so every field is the boxed
 *    one; the prop is kept only until its call sites are swept.
 */

/**
 * The twelve props a field of either kind declares identically. Spread into each component's own
 * `defineProps`, which then adds whatever is genuinely its own.
 */
export const fieldProps = {
  label: {
    type: String,
    default: null
  },
  /** Accessible name for the control, used only when there is no `label` to associate instead. */
  ariaLabel: {
    type: String,
    default: null
  },
  /**
   * Marks the field as one that has to be filled in.
   *
   * Draws a red asterisk beside the label and tells assistive technology the same thing through
   * `aria-required`; it does not validate anything or set the native `required` attribute, since the
   * form around it owns when and how it complains.
   */
  required: {
    type: Boolean,
    default: false
  },
  /** Helper text below the control, replaced by the error message when invalid. */
  hint: {
    type: String,
    default: null
  },
  /**
   * @deprecated Inert. Cardinal has no underlined field, so every field is the boxed one -- see the
   *   file header. Kept only until the call sites that still pass it are swept.
   */
  outlined: {
    type: Boolean,
    default: false
  },
  dense: {
    type: Boolean,
    default: false
  },
  /** Shows the value but does not accept a change. Keeps full contrast, unlike `disabled`. */
  readonly: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  /**
   * Focuses the real control once mounted.
   *
   * A declared prop rather than a bare HTML attribute, because the component's root is a wrapping
   * `<div>` -- the real control sits a level down, and a plain `autofocus` attribute lands on that
   * wrapper by default, where it does nothing (a `<div>` isn't focusable), and only reliably fires
   * for an element present when the page itself loads besides. Declaring it here both keeps it out
   * of `$attrs` (so it doesn't also sit inertly on the wrapper) and gives the component a moment --
   * `onMounted` -- to call the already-exposed `focus()` itself.
   *
   * A field that mounts after the page has already loaded -- inside a dialog, say -- needs a
   * different trigger than `onMounted`, since the dialog's own content is not in the DOM yet at that
   * point; see `composables/dialog.js`'s `useDialogComponent({ autofocus })` for that case.
   */
  autofocus: {
    type: Boolean,
    default: false
  },
  /** Drops the reserved line beneath the control. */
  hideBottomSpace: {
    type: Boolean,
    default: false
  },
  /** `Array<(value) => true | string>` */
  rules: {
    type: Array,
    default: () => []
  },
  /**
   * When to run `rules`:
   *   false        validate on every change
   *   true         stay silent until the first blur, then validate on every change
   *   'ondemand'   never validate automatically -- only when `validate()` is called, which is
   *                what the enclosing WForm does on submit
   */
  lazyRules: {
    type: [Boolean, String],
    default: false
  }
}

/**
 * @param {object} options
 * @param {object} options.props The component's own props bag.
 * @param {import('vue').Ref<boolean>} options.active What this control counts as active: focus for
 *   a text input, an open dropdown for a select.
 * @param {import('vue').Ref<boolean>} options.hovered Pointer-over, for the ring — which is an
 *   inline style, so CSS `:hover` cannot reach it.
 * @param {import('vue').Ref<boolean>} options.hasValue Whether the field holds anything.
 * @param {import('vue').Ref<boolean>} options.hasLeadingAdornment Whether anything sits in front of
 *   the value (a `prepend` slot, a prefix), which occupies the resting label's place.
 * @param {import('vue').Ref<string>} options.surface The field's own background classes, which is
 *   the one part of `controlClasses` the two components genuinely disagree about.
 * @param {import('vue').Ref<boolean>} [options.noFrame] The control draws no frame at all and takes
 *   no floating label — `WSelect`'s `standout` variant, which carries its state in its fill.
 * @param {import('vue').Ref<string>} [options.extraClasses] One more class slot on the control, for
 *   whatever is that component's alone (`WSelect`'s cursor affordance).
 */
export function useFieldFrame({
  props,
  active,
  hovered,
  hasValue,
  hasLeadingAdornment,
  surface,
  noFrame,
  extraClasses
}) {
  const errorMessage = ref(null)

  /**
   * Runs `rules` and records the first failure.
   *
   * @param {*} [value] Value to test. Defaults to the current model, but callers reacting to a
   *   change must pass the *new* value: the prop still holds the old one until the parent re-renders.
   * @returns {boolean} Whether the value is valid.
   */
  function validate(value = props.modelValue) {
    for (const rule of props.rules) {
      const result = rule(value)
      if (result !== true) {
        errorMessage.value = typeof result === 'string' ? result : 'Invalid'
        return false
      }
    }
    errorMessage.value = null
    return true
  }

  /** See the note in `WFieldFrame`'s template: held open only when a message could occupy it. */
  const showsBottom = computed(
    () =>
      Boolean(errorMessage.value) ||
      (!props.hideBottomSpace && (props.hint || props.rules.length > 0))
  )

  /**
   * The field frame, drawn as an inset ring rather than a real border.
   *
   * Insets take no part in layout, so a field's box is the same size whatever the frame is doing --
   * which is what lets the colour change on hover, focus and error without nudging the control's
   * contents by a pixel, and what keeps a caller's own `border-*` utility from fighting it.
   *
   * One pixel in every state. The Material treatment this replaces thickened to 2px on focus (and
   * needed the inset trick to avoid a reflow when it did); Cardinal marks focus by DARKENING the
   * hairline to the chrome slate instead, which is quieter and does not need the field to grow.
   *
   * Built as an inline style on purpose: the colour depends on four pieces of state, and an
   * arbitrary Tailwind class would be one more thing that has to survive the scanner.
   */
  const frameColor = computed(() =>
    errorMessage.value
      ? 'var(--w-input-ring-error)'
      : active.value
        ? 'var(--w-input-ring-active)'
        : hovered.value && !props.disabled && !props.readonly
          ? 'var(--w-input-ring-hover)'
          : 'var(--w-input-ring)'
  )

  const controlStyle = computed(() => {
    // -> `standout` carries its state in its fill and draws no frame at all
    if (noFrame?.value) {
      return undefined
    }
    return { boxShadow: `inset 0 0 0 1px ${frameColor.value}` }
  })

  const controlClasses = computed(() => [
    props.dense ? 'w-input-control--dense min-h-7 px-2' : 'min-h-[34px] px-2.5',
    surface.value,
    props.disabled ? 'pointer-events-none opacity-60' : '',
    extraClasses?.value ?? ''
  ])

  return {
    frameColor,
    controlStyle,
    controlClasses,
    showsBottom,
    errorMessage,
    validate
  }
}
