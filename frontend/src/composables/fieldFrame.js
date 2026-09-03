import { computed, ref } from 'vue'

/**
 * The Material outlined-field chrome both text-entry components draw — `WInput` and `WSelect`.
 *
 * The two carried the same label/notch/float/hint/error/ring logic by copy, parameterised in
 * practice by only two things: what each counts as "active" (focus for an input, an open dropdown
 * for a select) and whether it draws a frame at all (a `standout` select does not). Everything else
 * — the props, the validation, the four computed styles — was identical, which is what lives here.
 *
 * The markup those styles feed is `components/shared/WFieldFrame.vue`, which is internal to those
 * two components and deliberately not registered in `components/shared/index.js`.
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
  /** Bordered style. Retained as a prop because the markup sets it explicitly nearly everywhere. */
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

  /*
    A label on an outlined field rides the outline, Material-style, instead of sitting above it: at
    rest it stands in the middle of the field, and on focus or once there is a value it rises into
    the top border. A variant with no outline to rise into keeps its label above.
  */
  const hasFloatingLabel = computed(() => Boolean(props.label) && props.outlined && !noFrame?.value)

  /*
    Floated whenever the resting position is unavailable or would collide.

    A leading icon or prefix keeps it floated permanently: the resting label occupies the same place
    as the field's text, which begins after those, so the two would overlap. MUI resolves this the
    same way -- it asks the caller to pin the label up whenever there is a start adornment.

    A placeholder likewise: it renders in the resting position the moment the field is empty.
  */
  const isFloating = computed(
    () => active.value || hasValue.value || Boolean(props.placeholder) || hasLeadingAdornment.value
  )

  const floatColorClass = computed(() => {
    if (errorMessage.value) {
      return 'text-negative'
    }
    // -> `primary` is picked to read on white; on a dark field it needs the lightened mix
    return active.value
      ? 'text-primary dark:text-primary-light'
      : 'text-black/60 dark:text-white/70'
  })

  /**
   * The field frame, drawn as an inset ring rather than a border.
   *
   * Ports what Quasar did with two stacked pseudo-elements: a 1px resting frame and a 2px focus
   * frame occupying the same rectangle, so the thicker one covers the thinner one. Insets do not
   * take part in layout, so thickening on focus cannot nudge the content -- which a real border
   * would. `--w-input-ring` carries the resting colour so dark mode can swap it in CSS.
   *
   * Built as an inline style on purpose: the colour depends on three pieces of state, and an
   * arbitrary Tailwind class would be one more thing that has to survive the scanner and the
   * Quasar cascade.
   */
  const frameColor = computed(() =>
    errorMessage.value
      ? 'var(--color-negative)'
      : active.value
        ? 'var(--color-primary)'
        : hovered.value && !props.disabled && !props.readonly
          ? 'var(--w-input-ring-hover)'
          : 'var(--w-input-ring)'
  )

  // -> Error and active both read as "active", and get the heavier 2px frame
  const frameWidth = computed(() => (errorMessage.value || active.value ? 2 : 1))

  const controlStyle = computed(() => {
    // -> A floating label needs a frame that can be interrupted, which the fieldset draws instead
    if (noFrame?.value || hasFloatingLabel.value) {
      return undefined
    }
    return {
      boxShadow: props.outlined
        ? `inset 0 0 0 ${frameWidth.value}px ${frameColor.value}`
        : `inset 0 -${frameWidth.value}px 0 0 ${frameColor.value}`
    }
  })

  const outlineStyle = computed(() => ({
    borderColor: frameColor.value,
    borderWidth: `${frameWidth.value}px`
  }))

  const controlClasses = computed(() => [
    props.dense ? 'w-input-control--dense min-h-9 px-2 py-1' : 'min-h-11 px-3 py-2',
    surface.value,
    props.disabled ? 'pointer-events-none opacity-60' : '',
    extraClasses?.value ?? '',
    /*
      `relative` for the outline and the label. The margin is the room the floated label needs above
      the control, and it is matched below so the field's box stays symmetric about the control --
      otherwise a top margin alone drops the control below the centre of whatever row it sits in, out
      of line with a leading icon beside it.

      Skipped underneath when a message line follows, since that already occupies the space and the
      gap would only push the message away from the field it belongs to.
    */
    hasFloatingLabel.value ? (showsBottom.value ? 'relative mt-2' : 'relative my-2') : ''
  ])

  return {
    hasFloatingLabel,
    isFloating,
    floatColorClass,
    frameColor,
    frameWidth,
    controlStyle,
    outlineStyle,
    controlClasses,
    showsBottom,
    errorMessage,
    validate
  }
}
