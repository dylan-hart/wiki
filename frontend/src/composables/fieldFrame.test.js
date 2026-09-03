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
  it('declares the twelve props every field shares', () => {
    expect(Object.keys(fieldProps).sort()).toEqual([
      'ariaLabel',
      'autofocus',
      'dense',
      'disabled',
      'hideBottomSpace',
      'hint',
      'label',
      'lazyRules',
      'outlined',
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

describe('useFieldFrame — floating label', () => {
  it('floats the label only on a labelled outlined field', () => {
    expect(setup({ label: 'Name', outlined: true }).hasFloatingLabel.value).toBe(true)
    expect(setup({ label: 'Name' }).hasFloatingLabel.value).toBe(false)
    expect(setup({ outlined: true }).hasFloatingLabel.value).toBe(false)
  })

  it('keeps the label above when the caller draws no frame at all', () => {
    const frame = setup({ label: 'Name', outlined: true }, { noFrame: computed(() => true) })
    expect(frame.hasFloatingLabel.value).toBe(false)
  })

  it('rests the label in the field until something displaces it', () => {
    const frame = setup({ label: 'Name', outlined: true })
    expect(frame.isFloating.value).toBe(false)
  })

  it('lifts the label while the field is active', () => {
    const frame = setup({ label: 'Name', outlined: true })
    frame.active.value = true
    expect(frame.isFloating.value).toBe(true)
  })

  it('lifts the label once the field has a value', () => {
    const frame = setup({ label: 'Name', outlined: true })
    frame.state.modelValue = 'x'
    expect(frame.isFloating.value).toBe(true)
  })

  it('lifts the label for a placeholder or a leading adornment, which occupy its resting place', () => {
    expect(setup({ label: 'N', outlined: true, placeholder: 'p' }).isFloating.value).toBe(true)
    const frame = setup({ label: 'N', outlined: true })
    frame.hasLeadingAdornment.value = true
    expect(frame.isFloating.value).toBe(true)
  })
})

describe('useFieldFrame — colours', () => {
  it('colours the floated label by the field’s state', () => {
    const frame = setup({ label: 'N', outlined: true })
    expect(frame.floatColorClass.value).toBe('text-black/60 dark:text-white/70')
    frame.active.value = true
    expect(frame.floatColorClass.value).toBe('text-primary dark:text-primary-light')
  })

  it('colours the floated label negative once there is a message', () => {
    const frame = setup({ label: 'N', outlined: true, rules: [() => 'Nope'] })
    frame.validate()
    expect(frame.floatColorClass.value).toBe('text-negative')
  })

  it('draws the resting frame at 1px in the resting colour', () => {
    const frame = setup()
    expect(frame.frameColor.value).toBe('var(--w-input-ring)')
    expect(frame.frameWidth.value).toBe(1)
  })

  it('thickens and brightens the frame while active', () => {
    const frame = setup()
    frame.active.value = true
    expect(frame.frameColor.value).toBe('var(--color-primary)')
    expect(frame.frameWidth.value).toBe(2)
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
    expect(frame.frameColor.value).toBe('var(--color-negative)')
    expect(frame.frameWidth.value).toBe(2)
  })
})

describe('useFieldFrame — frame styles', () => {
  it('rings an outlined field and underlines a filled one', () => {
    expect(setup({ outlined: true }).controlStyle.value).toEqual({
      boxShadow: 'inset 0 0 0 1px var(--w-input-ring)'
    })
    expect(setup().controlStyle.value).toEqual({
      boxShadow: 'inset 0 -1px 0 0 var(--w-input-ring)'
    })
  })

  it('draws no inline frame when the fieldset is drawing one that can be interrupted', () => {
    expect(setup({ label: 'N', outlined: true }).controlStyle.value).toBe(undefined)
  })

  it('draws no inline frame when the caller wants none', () => {
    expect(setup({ outlined: true }, { noFrame: computed(() => true) }).controlStyle.value).toBe(
      undefined
    )
  })

  it('gives the fieldset the same colour and width as the ring', () => {
    const frame = setup({ label: 'N', outlined: true })
    frame.active.value = true
    expect(frame.outlineStyle.value).toEqual({
      borderColor: 'var(--color-primary)',
      borderWidth: '2px'
    })
  })
})

describe('useFieldFrame — control classes', () => {
  it('sizes the control and includes the caller’s own surface', () => {
    expect(setup().controlClasses.value).toContain('min-h-11 px-3 py-2')
    expect(setup().controlClasses.value).toContain('surface-class')
    expect(setup({ dense: true }).controlClasses.value).toContain(
      'w-input-control--dense min-h-9 px-2 py-1'
    )
  })

  it('mutes a disabled field', () => {
    expect(setup({ disabled: true }).controlClasses.value).toContain(
      'pointer-events-none opacity-60'
    )
  })

  it('makes room for the floated label, and closes the gap when a message line follows', () => {
    expect(setup({ label: 'N', outlined: true }).controlClasses.value).toContain('relative my-2')
    expect(setup({ label: 'N', outlined: true, hint: 'h' }).controlClasses.value).toContain(
      'relative mt-2'
    )
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
