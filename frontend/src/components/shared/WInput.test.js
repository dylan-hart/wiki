import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WInput from './WInput.vue'

describe('WInput', () => {
  it('emits update:modelValue with the raw input value on input', async () => {
    const wrapper = mount(WInput, { props: { modelValue: '' } })

    await wrapper.find('input').setValue('hello')

    expect(wrapper.emitted('update:modelValue')).toEqual([['hello']])
  })

  it('renders a textarea instead of an input when type="textarea"', () => {
    const wrapper = mount(WInput, { props: { modelValue: '', type: 'textarea' } })

    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(wrapper.find('input').exists()).toBe(false)
  })

  it('shows the clear button only when clearable and the value is non-empty, and clears to an empty string', async () => {
    const empty = mount(WInput, { props: { modelValue: '', clearable: true } })
    expect(empty.find('[aria-label="Clear"]').exists()).toBe(false)

    const filled = mount(WInput, { props: { modelValue: 'something', clearable: true } })
    expect(filled.find('[aria-label="Clear"]').exists()).toBe(true)

    await filled.find('[aria-label="Clear"]').trigger('click')
    expect(filled.emitted('update:modelValue')).toEqual([['']])
  })

  it('does not render a clear button when clearable is off, regardless of value', () => {
    const wrapper = mount(WInput, { props: { modelValue: 'something', clearable: false } })
    expect(wrapper.find('[aria-label="Clear"]').exists()).toBe(false)
  })

  describe('revealable password field', () => {
    it('starts masked and toggles to plain text on click, updating the aria-label and aria-pressed', async () => {
      const wrapper = mount(WInput, {
        props: { modelValue: 'secret', type: 'password', revealable: true }
      })
      const input = wrapper.find('input')
      const toggle = wrapper.find('[aria-label="Show password"]')

      expect(input.attributes('type')).toBe('password')
      expect(toggle.attributes('aria-pressed')).toBe('false')

      await toggle.trigger('click')

      expect(wrapper.find('input').attributes('type')).toBe('text')
      expect(wrapper.find('[aria-label="Hide password"]').attributes('aria-pressed')).toBe('true')
    })

    it('renders no reveal toggle when revealable is off', () => {
      const wrapper = mount(WInput, { props: { modelValue: '', type: 'password' } })
      expect(wrapper.find('[aria-label="Show password"]').exists()).toBe(false)
    })
  })

  describe('disabled state', () => {
    it('disables the control via either disable or disabled', () => {
      const viaDisable = mount(WInput, { props: { modelValue: '', disable: true } })
      const viaDisabled = mount(WInput, { props: { modelValue: '', disabled: true } })

      expect(viaDisable.find('input').attributes('disabled')).toBeDefined()
      expect(viaDisabled.find('input').attributes('disabled')).toBeDefined()
    })
  })

  describe('required', () => {
    it('marks aria-required and shows an asterisk beside the label', () => {
      const wrapper = mount(WInput, { props: { modelValue: '', label: 'Name', required: true } })

      expect(wrapper.find('input').attributes('aria-required')).toBe('true')
      expect(wrapper.text()).toContain('*')
    })
  })

  describe('validate()', () => {
    function isNonEmpty(v) {
      return String(v ?? '').length > 0 || 'Required'
    }

    it('runs the rules array, surfaces the first failing message, and marks aria-invalid', async () => {
      const wrapper = mount(WInput, { props: { modelValue: '', rules: [isNonEmpty] } })

      const valid = wrapper.vm.validate()
      await wrapper.vm.$nextTick()

      expect(valid).toBe(false)
      expect(wrapper.text()).toContain('Required')
      expect(wrapper.find('input').attributes('aria-invalid')).toBe('true')
    })

    it('returns true and clears any prior error once the value satisfies every rule', async () => {
      const wrapper = mount(WInput, { props: { modelValue: '', rules: [isNonEmpty] } })
      wrapper.vm.validate()
      await wrapper.vm.$nextTick()
      expect(wrapper.vm.hasError).toBe(true)

      await wrapper.setProps({ modelValue: 'ok' })
      const valid = wrapper.vm.validate()

      expect(valid).toBe(true)
      expect(wrapper.vm.hasError).toBe(false)
    })

    it('with lazyRules=true, stays silent on typing until the first blur', async () => {
      const wrapper = mount(WInput, {
        props: { modelValue: 'x', rules: [isNonEmpty], lazyRules: true }
      })

      await wrapper.setProps({ modelValue: '' })
      expect(wrapper.text()).not.toContain('Required')

      await wrapper.find('input').trigger('blur')
      expect(wrapper.text()).toContain('Required')
    })

    it('with lazyRules="ondemand", never validates automatically -- only an explicit validate() call runs it', async () => {
      const wrapper = mount(WInput, {
        props: { modelValue: '', rules: [isNonEmpty], lazyRules: 'ondemand' }
      })

      await wrapper.find('input').trigger('blur')
      expect(wrapper.text()).not.toContain('Required')

      wrapper.vm.validate()
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain('Required')
    })
  })

  describe('exposed methods', () => {
    it('reveal() shows a revealable password field as if the eye had been clicked', async () => {
      const wrapper = mount(WInput, {
        props: { modelValue: 'secret', type: 'password', revealable: true }
      })

      wrapper.vm.reveal()
      await wrapper.vm.$nextTick()

      expect(wrapper.find('input').attributes('type')).toBe('text')
    })

    it('focus() focuses the underlying input element', () => {
      const wrapper = mount(WInput, { props: { modelValue: '' }, attachTo: document.body })

      wrapper.vm.focus()

      expect(document.activeElement).toBe(wrapper.find('input').element)
      wrapper.unmount()
    })
  })

  describe('accessible name', () => {
    it('sets aria-label on the input when no label is passed', () => {
      const wrapper = mount(WInput, { props: { modelValue: '', ariaLabel: 'Search users' } })

      expect(wrapper.find('input').attributes('aria-label')).toBe('Search users')
    })

    it('does not set aria-label on the input once a label is passed', () => {
      const wrapper = mount(WInput, {
        props: { modelValue: '', label: 'Name', ariaLabel: 'Search users' }
      })

      expect(wrapper.find('input').attributes('aria-label')).toBeUndefined()
    })
  })
})
