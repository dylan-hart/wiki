import { computed, ref } from 'vue'

/**
 * The label/hint/error/frame logic `WInput` and `WSelect` share. The markup it feeds is
 * `components/shared/WFieldFrame.vue`, internal to those two components and so deliberately absent
 * from `components/shared/index.js`.
 */

/**
 * Spread into each field component's own `defineProps`, which then adds whatever is genuinely its
 * own.
 */
export const fieldProps = {
  label: {
    type: String,
    default: null
  },
  /** Used only when there is no `label` to associate instead. */
  ariaLabel: {
    type: String,
    default: null
  },
  /**
   * Asterisk plus `aria-required` only: it validates nothing and does not set the native `required`
   * attribute, since the form around it owns when and how it complains.
   */
  required: {
    type: Boolean,
    default: false
  },
  /** Replaced by the error message while the field is invalid. */
  hint: {
    type: String,
    default: null
  },
  dense: {
    type: Boolean,
    default: false
  },
  /** Refuses changes but keeps full contrast, unlike `disabled`. */
  readonly: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  /**
   * A declared prop rather than a bare HTML attribute: the component's root is a wrapping `<div>`,
   * so a fall-through `autofocus` would land on a non-focusable element, and the native attribute
   * only reliably fires for an element present at page load. Declaring it keeps it out of `$attrs`
   * and lets `onMounted` call the exposed `focus()` instead.
   *
   * A field mounting inside a dialog needs a later trigger than `onMounted`, since the dialog's
   * content is not in the DOM yet: `composables/dialog.js`'s `useDialogComponent({ autofocus })`.
   */
  autofocus: {
    type: Boolean,
    default: false
  },
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
   *   'ondemand'   only when `validate()` is called, which is what `WForm` does on submit
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
 * @param {import('vue').Ref<boolean>} options.hovered Pointer-over. Needed as state because the
 *   ring is an inline style, which CSS `:hover` cannot reach.
 * @param {import('vue').Ref<boolean>} options.hasValue
 * @param {import('vue').Ref<boolean>} options.hasLeadingAdornment Whether anything sits in front of
 *   the value (a `prepend` slot, a prefix), which occupies the resting label's place.
 * @param {import('vue').Ref<string>} options.surface Background classes -- the one part of
 *   `controlClasses` the two components genuinely disagree about.
 * @param {import('vue').Ref<boolean>} [options.noFrame] No frame and no floating label --
 *   `WSelect`'s `standout` variant, which carries its state in its fill.
 * @param {import('vue').Ref<string>} [options.extraClasses]
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
   * @param {*} [value] Defaults to the current model, but a caller reacting to a change must pass
   *   the *new* value: the prop still holds the old one until the parent re-renders.
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

  /*
    `Boolean()` wraps the WHOLE expression, not just the error half: `props.hint` is a string, so
    `false || ('some hint' || ...)` evaluates to that string and `WFieldFrame` -- which declares
    `showsBottom` as `type: Boolean` -- warns on every such mount. A `toBeTruthy()` assertion passes
    either way, so a test will not catch a regression here.
  */
  const showsBottom = computed(() =>
    Boolean(
      errorMessage.value || (!props.hideBottomSpace && (props.hint || props.rules.length > 0))
    )
  )

  /**
   * The frame is an inset ring, not a border: insets take no part in layout, so the field's box
   * never changes size and a caller's own `border-*` utility does not fight it. It stays one pixel
   * in every state and marks focus by darkening instead of thickening.
   *
   * An inline style rather than a class, because the colour depends on four pieces of state and a
   * computed Tailwind class name would not survive the content scanner.
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
