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

    it('announces the message from a live region, and the error text replaces the hint in that same node', async () => {
      const wrapper = mount(WInput, {
        props: { modelValue: '', hint: 'Pick a name', rules: [isNonEmpty] }
      })

      const describedById = wrapper.find('input').attributes('aria-describedby')
      const messageEl = wrapper.find(`#${describedById}`)
      expect(messageEl.attributes('aria-live')).toBe('polite')
      expect(messageEl.attributes('aria-atomic')).toBe('true')
      expect(messageEl.text()).toBe('Pick a name')

      wrapper.vm.validate()
      await wrapper.vm.$nextTick()

      // -> Same node, not a second one -- the live region only announces on a node it was already
      //    watching, so the error has to land in the node that carries aria-live, not a new one.
      const messageElAfter = wrapper.find(`#${describedById}`)
      expect(messageElAfter.exists()).toBe(true)
      expect(wrapper.findAll(`#${describedById}`)).toHaveLength(1)
      expect(messageElAfter.attributes('aria-live')).toBe('polite')
      expect(messageElAfter.text()).toBe('Required')
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

  describe('autofocus', () => {
    it('focuses the real input on mount when set', () => {
      const wrapper = mount(WInput, {
        props: { modelValue: '', autofocus: true },
        attachTo: document.body
      })

      expect(document.activeElement).toBe(wrapper.find('input').element)
      wrapper.unmount()
    })

    it('does nothing when unset', () => {
      const wrapper = mount(WInput, { props: { modelValue: '' }, attachTo: document.body })

      expect(document.activeElement).not.toBe(wrapper.find('input').element)
      wrapper.unmount()
    })

    it('does nothing for a hidden field', () => {
      const wrapper = mount(WInput, {
        props: { modelValue: '', autofocus: true, type: 'hidden' },
        attachTo: document.body
      })

      expect(document.activeElement).not.toBe(wrapper.find('input').element)
      wrapper.unmount()
    })

    it('is not left as an inert attribute on the wrapper (excluded from $attrs as a declared prop)', () => {
      const wrapper = mount(WInput, {
        props: { modelValue: '', autofocus: true }
      })

      expect(wrapper.attributes('autofocus')).toBeUndefined()
    })
  })

  describe('attribute forwarding', () => {
    it('forwards name/inputmode/maxlength onto the real control, not the wrapper', () => {
      const wrapper = mount(WInput, {
        props: { modelValue: '' },
        attrs: { name: 'username', inputmode: 'numeric', maxlength: '10' }
      })

      const input = wrapper.find('input')
      expect(input.attributes('name')).toBe('username')
      expect(input.attributes('inputmode')).toBe('numeric')
      expect(input.attributes('maxlength')).toBe('10')
      expect(wrapper.attributes('name')).toBeUndefined()

      const root = wrapper.element
      expect(root.getAttribute('name')).toBeNull()
      expect(root.getAttribute('inputmode')).toBeNull()
      expect(root.getAttribute('maxlength')).toBeNull()
    })

    it('forwards an aria-label attribute to the real control', () => {
      const wrapper = mount(WInput, {
        props: { modelValue: '' },
        attrs: { 'aria-label': 'Search' }
      })

      expect(wrapper.find('input').attributes('aria-label')).toBe('Search')
      expect(wrapper.element.getAttribute('aria-label')).toBeNull()
    })

    it('keeps a caller-supplied class on the wrapper rather than moving it onto the input', () => {
      const wrapper = mount(WInput, {
        props: { modelValue: '' },
        attrs: { class: 'mb-2' }
      })

      expect(wrapper.classes()).toContain('mb-2')
      expect(wrapper.find('input').classes()).not.toContain('mb-2')
    })
  })

  describe('validation message live region', () => {
    it('carries aria-live and aria-atomic whenever the message area is shown', () => {
      const wrapper = mount(WInput, { props: { modelValue: '', hint: 'Helper text' } })

      const message = wrapper.find('.text-caption')
      expect(message.attributes('aria-live')).toBe('polite')
      expect(message.attributes('aria-atomic')).toBe('true')
    })

    it('replaces the hint with the error text in that same node rather than a new one', async () => {
      function isNonEmpty(v) {
        return String(v ?? '').length > 0 || 'Required'
      }
      const wrapper = mount(WInput, {
        props: { modelValue: '', hint: 'Helper text', rules: [isNonEmpty] }
      })

      const message = wrapper.find('.text-caption')
      expect(message.text()).toBe('Helper text')

      wrapper.vm.validate()
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('.text-caption')).toHaveLength(1)
      expect(message.text()).toBe('Required')
      expect(message.attributes('aria-live')).toBe('polite')
    })
  })
})
