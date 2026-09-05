import { describe, expect, it } from 'vitest'
import { computed, reactive, ref } from 'vue'

import { fieldProps, useFieldFrame } from './fieldFrame'

/**
 * The composable as a field component wires it: `props` is the component's own props bag, and the
 * four state inputs are whatever that component calls "active", "hovered", "has a value" and "has
 * something in front of the value".
 */
function setup(props = {}, options = {}) {
  const state = reactive({
    modelValue: '',
    label: null,
    required: false,
    hint: null,
    outlined: false,
    dense: false,
    readonly: false,
    disabled: false,
    hideBottomSpace: false,
    placeholder: null,
    rules: [],
    lazyRules: false,
    ...props
  })
  const active = ref(false)
  const hovered = ref(false)
  const hasValue = computed(() => String(state.modelValue ?? '').length > 0)
  const hasLeadingAdornment = ref(false)
  const frame = useFieldFrame({
    props: state,
    active,
    hovered,
    hasValue,
    hasLeadingAdornment,
    surface: computed(() => 'surface-class'),
    ...options
  })
  return { state, active, hovered, hasLeadingAdornment, ...frame }
}

describe('fieldProps', () => {
  it('declares the eleven props every field shares', () => {
    expect(Object.keys(fieldProps).sort()).toEqual([
      'ariaLabel',
      'autofocus',
      'dense',
      'disabled',
      'hideBottomSpace',
      'hint',
      'label',
      'lazyRules',
      'readonly',
      'required',
      'rules'
    ])
  })

  it('defaults rules to a fresh array per component', () => {
    expect(fieldProps.rules.default()).toEqual([])
    expect(fieldProps.rules.default()).not.toBe(fieldProps.rules.default())
  })
})

describe('useFieldFrame — frame colour', () => {
  it('rests on the hairline', () => {
    expect(setup().frameColor.value).toBe('var(--w-input-ring)')
  })

  it('darkens to the chrome slate while active', () => {
    const frame = setup()
    frame.active.value = true
    expect(frame.frameColor.value).toBe('var(--w-input-ring-active)')
  })

  it('shows the hover colour only on a field that can actually be used', () => {
    const frame = setup()
    frame.hovered.value = true
    expect(frame.frameColor.value).toBe('var(--w-input-ring-hover)')
    frame.state.readonly = true
    expect(frame.frameColor.value).toBe('var(--w-input-ring)')
  })

  it('lets an error outrank both', () => {
    const frame = setup({ rules: [() => 'Nope'] })
    frame.active.value = true
    frame.validate()
    expect(frame.frameColor.value).toBe('var(--w-input-ring-error)')
  })
})

describe('useFieldFrame — frame styles', () => {
  /*
    Cardinal's frame is ONE pixel in every state -- only the colour moves. The Material treatment
    this replaces thickened to 2px on focus, which is why the inset ring existed in the first place;
    the ring is kept anyway, because it is still what keeps a caller's own `border-*` utility and the
    field's own frame from fighting over the same edge.
  */
  it('rings every field at one pixel, whatever state it is in', () => {
    expect(setup().controlStyle.value).toEqual({
      boxShadow: 'inset 0 0 0 1px var(--w-input-ring)'
    })

    const active = setup()
    active.active.value = true
    expect(active.controlStyle.value).toEqual({
      boxShadow: 'inset 0 0 0 1px var(--w-input-ring-active)'
    })
  })

  it('rings a labelled field the same as an unlabelled one -- the label is above it, not in it', () => {
    expect(setup({ label: 'N' }).controlStyle.value).toEqual({
      boxShadow: 'inset 0 0 0 1px var(--w-input-ring)'
    })
  })

  it('draws no inline frame when the caller wants none', () => {
    expect(setup({}, { noFrame: computed(() => true) }).controlStyle.value).toBe(undefined)
  })
})

describe('useFieldFrame — control classes', () => {
  it('sizes the control and includes the caller’s own surface', () => {
    expect(setup().controlClasses.value).toContain('min-h-[34px] px-2.5')
    expect(setup().controlClasses.value).toContain('surface-class')
    expect(setup({ dense: true }).controlClasses.value).toContain(
      'w-input-control--dense min-h-7 px-2'
    )
  })

  it('mutes a disabled field', () => {
    expect(setup({ disabled: true }).controlClasses.value).toContain(
      'pointer-events-none opacity-60'
    )
  })

  it('reserves no room above the control -- nothing floats into the frame any more', () => {
    for (const classes of [
      setup({ label: 'N' }).controlClasses.value,
      setup({ label: 'N', hint: 'h' }).controlClasses.value
    ]) {
      expect(classes).not.toContain('relative my-2')
      expect(classes).not.toContain('relative mt-2')
    }
  })

  it('carries the caller’s own extra class through', () => {
    const frame = setup({}, { extraClasses: computed(() => 'cursor-pointer') })
    expect(frame.controlClasses.value).toContain('cursor-pointer')
  })
})

describe('useFieldFrame — bottom line', () => {
  it('stays closed for a plain field', () => {
    expect(setup().showsBottom.value).toBeFalsy()
  })

  // -> Truthiness, not a literal `true`: this feeds a `v-if`, and the hint is its own reason to show
  it('opens for a hint, and for a field that has rules to fail', () => {
    expect(setup({ hint: 'Helpful' }).showsBottom.value).toBeTruthy()
    expect(setup({ rules: [() => true] }).showsBottom.value).toBeTruthy()
  })

  it('stays closed when the caller asked for no reserved space', () => {
    expect(setup({ hint: 'Helpful', hideBottomSpace: true }).showsBottom.value).toBeFalsy()
  })

  it('opens regardless once there is a message to show', () => {
    const frame = setup({ hideBottomSpace: true, rules: [() => 'Nope'] })
    frame.validate()
    expect(frame.showsBottom.value).toBe(true)
  })
})

describe('useFieldFrame — validate', () => {
  it('records the first failing rule’s message', () => {
    const frame = setup({ rules: [() => true, () => 'Second failed', () => 'Third failed'] })
    expect(frame.validate()).toBe(false)
    expect(frame.errorMessage.value).toBe('Second failed')
  })

  it('clears the message once every rule passes', () => {
    const frame = setup({ rules: [(v) => v.length > 0 || 'Required'] })
    frame.validate()
    expect(frame.errorMessage.value).toBe('Required')
    frame.state.modelValue = 'x'
    expect(frame.validate()).toBe(true)
    expect(frame.errorMessage.value).toBe(null)
  })

  it('falls back to a generic message for a rule returning a bare false', () => {
    const frame = setup({ rules: [() => false] })
    frame.validate()
    expect(frame.errorMessage.value).toBe('Invalid')
  })

  it('tests the value it was handed rather than the model, for a caller reacting to a change', () => {
    const frame = setup({ modelValue: '', rules: [(v) => v.length > 0 || 'Required'] })
    expect(frame.validate('typed')).toBe(true)
  })
})
