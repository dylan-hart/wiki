import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WOtpInput from './WOtpInput.vue'

import { createTestI18n } from '../../../test/i18n.js'

/** All six `.otp-input` boxes, in DOM order. */
function boxes(wrapper) {
  return wrapper.findAll('input.otp-input')
}

describe('WOtpInput', () => {
  it('renders one box per digit of length, defaulting to 6', () => {
    const wrapper = mount(WOtpInput)

    expect(boxes(wrapper)).toHaveLength(6)
  })

  it('renders the number of boxes the length prop asks for', () => {
    const wrapper = mount(WOtpInput, { props: { length: 4 } })

    expect(boxes(wrapper)).toHaveLength(4)
  })

  it('seeds the boxes from an initial modelValue', () => {
    const wrapper = mount(WOtpInput, { props: { modelValue: '123' } })

    const values = boxes(wrapper).map((b) => b.element.value)
    expect(values).toEqual(['1', '2', '3', '', '', ''])
  })

  describe('typing', () => {
    it('emits the joined value and advances focus to the next box', async () => {
      const wrapper = mount(WOtpInput, { attachTo: document.body })
      const inputs = boxes(wrapper)

      await inputs[0].setValue('4')

      expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['4'])
      expect(document.activeElement).toBe(inputs[1].element)

      wrapper.unmount()
    })

    it('strips non-digit characters', async () => {
      const wrapper = mount(WOtpInput)
      const inputs = boxes(wrapper)

      await inputs[0].setValue('a')

      expect(inputs[0].element.value).toBe('')
      expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([''])
    })

    it('does not advance focus past the last box', async () => {
      const wrapper = mount(WOtpInput, { props: { length: 1 }, attachTo: document.body })
      const inputs = boxes(wrapper)

      await inputs[0].setValue('7')

      expect(document.activeElement).toBe(inputs[0].element)

      wrapper.unmount()
    })
  })

  describe('paste', () => {
    it('distributes a pasted code across the boxes from the focused one onward', async () => {
      const wrapper = mount(WOtpInput, { attachTo: document.body })
      const inputs = boxes(wrapper)

      await inputs[0].trigger('paste', {
        clipboardData: { getData: () => '123456' }
      })

      const values = boxes(wrapper).map((b) => b.element.value)
      expect(values).toEqual(['1', '2', '3', '4', '5', '6'])
      expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['123456'])

      wrapper.unmount()
    })

    it('strips non-digit characters out of the pasted text', async () => {
      const wrapper = mount(WOtpInput)
      const inputs = boxes(wrapper)

      await inputs[0].trigger('paste', {
        clipboardData: { getData: () => '12-34 56' }
      })

      expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['123456'])
    })

    it('pastes starting from a later box, filling only what remains', async () => {
      const wrapper = mount(WOtpInput)
      const inputs = boxes(wrapper)

      await inputs[4].trigger('paste', {
        clipboardData: { getData: () => '99' }
      })

      const values = boxes(wrapper).map((b) => b.element.value)
      expect(values).toEqual(['', '', '', '', '9', '9'])
    })
  })

  describe('backspace', () => {
    it('clears the current box without moving when it already holds a digit', async () => {
      const wrapper = mount(WOtpInput, {
        props: { modelValue: '12' },
        attachTo: document.body
      })
      const inputs = boxes(wrapper)
      inputs[1].element.focus()

      await inputs[1].trigger('keydown', { key: 'Backspace' })

      expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['1'])
      expect(document.activeElement).toBe(inputs[1].element)

      wrapper.unmount()
    })

    it('moves to and clears the previous box when the current one is already empty', async () => {
      const wrapper = mount(WOtpInput, {
        props: { modelValue: '1' },
        attachTo: document.body
      })
      const inputs = boxes(wrapper)
      inputs[1].element.focus()

      await inputs[1].trigger('keydown', { key: 'Backspace' })

      expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([''])
      expect(document.activeElement).toBe(inputs[0].element)

      wrapper.unmount()
    })

    it('does nothing on an empty first box', async () => {
      const wrapper = mount(WOtpInput, { attachTo: document.body })
      const inputs = boxes(wrapper)
      inputs[0].element.focus()

      await inputs[0].trigger('keydown', { key: 'Backspace' })

      expect(wrapper.emitted('update:modelValue')).toBeUndefined()
      expect(document.activeElement).toBe(inputs[0].element)

      wrapper.unmount()
    })
  })

  describe('arrow navigation', () => {
    it('moves focus with ArrowLeft/ArrowRight', async () => {
      const wrapper = mount(WOtpInput, { attachTo: document.body })
      const inputs = boxes(wrapper)
      inputs[2].element.focus()

      await inputs[2].trigger('keydown', { key: 'ArrowLeft' })
      expect(document.activeElement).toBe(inputs[1].element)

      await inputs[1].trigger('keydown', { key: 'ArrowRight' })
      expect(document.activeElement).toBe(inputs[2].element)

      wrapper.unmount()
    })

    it('does not throw moving left past the first box or right past the last', async () => {
      const wrapper = mount(WOtpInput, { props: { length: 2 }, attachTo: document.body })
      const inputs = boxes(wrapper)
      inputs[0].element.focus()

      await inputs[0].trigger('keydown', { key: 'ArrowLeft' })
      expect(document.activeElement).toBe(inputs[0].element)

      inputs[1].element.focus()
      await inputs[1].trigger('keydown', { key: 'ArrowRight' })
      expect(document.activeElement).toBe(inputs[1].element)

      wrapper.unmount()
    })
  })

  describe('complete', () => {
    it('fires once, when the last box is filled', async () => {
      const wrapper = mount(WOtpInput, { props: { length: 2 } })
      const inputs = boxes(wrapper)

      await inputs[0].setValue('1')
      expect(wrapper.emitted('complete')).toBeUndefined()

      await inputs[1].setValue('2')
      expect(wrapper.emitted('complete')).toHaveLength(1)
      expect(wrapper.emitted('complete')[0]).toEqual(['12'])
    })

    it('does not fire again on further edits while still complete', async () => {
      const wrapper = mount(WOtpInput, { props: { modelValue: '12', length: 2 } })
      const inputs = boxes(wrapper)

      // -> Re-typing over an already-full box (selects-on-focus, so this replaces rather than appends)
      await inputs[1].setValue('9')

      expect(wrapper.emitted('complete')).toBeUndefined()
    })

    it('fires again after a full code is cleared and refilled', async () => {
      const wrapper = mount(WOtpInput, { props: { length: 1 } })
      const inputs = boxes(wrapper)

      await inputs[0].setValue('5')
      expect(wrapper.emitted('complete')).toHaveLength(1)

      await inputs[0].trigger('keydown', { key: 'Backspace' })
      await inputs[0].setValue('6')

      expect(wrapper.emitted('complete')).toHaveLength(2)
    })
  })

  describe('a11y', () => {
    it('labels each box "Digit N of total" in English with no i18n plugin installed', () => {
      const wrapper = mount(WOtpInput, { props: { length: 3 } })
      const inputs = boxes(wrapper)

      expect(inputs[0].attributes('aria-label')).toBe('Digit 1 of 3')
      expect(inputs[2].attributes('aria-label')).toBe('Digit 3 of 3')
    })

    it('resolves the label from the dictionary when installed', () => {
      const i18n = createTestI18n({ 'common.otpInput.digitLabel': 'Ziffer {n} von {total}' })
      const wrapper = mount(WOtpInput, {
        props: { length: 2 },
        global: { plugins: [i18n] }
      })

      expect(boxes(wrapper)[0].attributes('aria-label')).toBe('Ziffer 1 von 2')
    })

    it('puts autocomplete="one-time-code" on the first box only', () => {
      const wrapper = mount(WOtpInput)
      const inputs = boxes(wrapper)

      expect(inputs[0].attributes('autocomplete')).toBe('one-time-code')
      expect(inputs[1].attributes('autocomplete')).not.toBe('one-time-code')
    })
  })

  describe('disabled', () => {
    it('disables every box', () => {
      const wrapper = mount(WOtpInput, { props: { disabled: true } })

      for (const box of boxes(wrapper)) {
        expect(box.attributes('disabled')).toBeDefined()
      }
    })
  })

  describe('external reset', () => {
    it('rebuilds the boxes when modelValue changes out from under it', async () => {
      const wrapper = mount(WOtpInput, { props: { modelValue: '12' } })

      await wrapper.setProps({ modelValue: '' })

      const values = boxes(wrapper).map((b) => b.element.value)
      expect(values).toEqual(['', '', '', '', '', ''])
    })
  })
})
