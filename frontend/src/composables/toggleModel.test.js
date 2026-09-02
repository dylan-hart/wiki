import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import { useToggleModel } from './toggleModel'

/** `props`/`emit` as a component would hand them over. */
function setup(props) {
  const emit = vi.fn()
  const state = reactive({ val: undefined, ...props })
  return { state, emit, ...useToggleModel(state, emit) }
}

describe('useToggleModel — boolean model', () => {
  it('is on only for a literal true', () => {
    expect(setup({ modelValue: true }).isOn.value).toBe(true)
    expect(setup({ modelValue: false }).isOn.value).toBe(false)
    expect(setup({ modelValue: null }).isOn.value).toBe(false)
  })

  it('emits the opposite of what it holds', () => {
    const { emit, toggle } = setup({ modelValue: false })
    toggle()
    expect(emit).toHaveBeenCalledWith('update:modelValue', true)
  })

  it('turns off again', () => {
    const { emit, toggle } = setup({ modelValue: true })
    toggle()
    expect(emit).toHaveBeenCalledWith('update:modelValue', false)
  })
})

describe('useToggleModel — array model', () => {
  it('is on when the array holds this control’s own value', () => {
    expect(setup({ modelValue: ['a', 'b'], val: 'a' }).isOn.value).toBe(true)
    expect(setup({ modelValue: ['b'], val: 'a' }).isOn.value).toBe(false)
  })

  it('adds its value to the array, leaving the original untouched', () => {
    const { state, emit, toggle } = setup({ modelValue: ['b'], val: 'a' })
    toggle()
    expect(emit).toHaveBeenCalledWith('update:modelValue', ['b', 'a'])
    expect(state.modelValue).toEqual(['b'])
  })

  it('removes its value from the array', () => {
    const { emit, toggle } = setup({ modelValue: ['a', 'b'], val: 'a' })
    toggle()
    expect(emit).toHaveBeenCalledWith('update:modelValue', ['b'])
  })

  it('follows the model when it changes shape from boolean to array', () => {
    const { state, isOn } = setup({ modelValue: false, val: 'a' })
    expect(isOn.value).toBe(false)
    state.modelValue = ['a']
    expect(isOn.value).toBe(true)
  })
})
