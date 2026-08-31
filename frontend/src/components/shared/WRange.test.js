import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WRange from './WRange.vue'

/** The two draggable handles, in `[min, max]` order -- see the `v-for="handle of ['min', 'max']"`. */
function handles(wrapper) {
  return wrapper.findAll('[role="slider"]')
}

describe('WRange', () => {
  it('renders a handle button per side with the expected aria-value wiring', () => {
    const wrapper = mount(WRange, {
      props: { modelValue: { min: 2, max: 8 }, min: 0, max: 10 }
    })

    const handleButtons = wrapper.findAll('button')
    expect(handleButtons).toHaveLength(2)
    expect(handleButtons[0].attributes('aria-valuenow')).toBe('2')
    expect(handleButtons[1].attributes('aria-valuenow')).toBe('8')
  })

  it('emits an updated model on ArrowRight/ArrowLeft/Home/End when enabled', async () => {
    const wrapper = mount(WRange, {
      props: { modelValue: { min: 2, max: 8 }, min: 0, max: 10 }
    })
    const [minHandle] = wrapper.findAll('button')

    await minHandle.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([{ min: 3, max: 8 }])

    await minHandle.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([{ min: 1, max: 8 }])

    await minHandle.trigger('keydown', { key: 'End' })
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([{ min: 8, max: 8 }])

    await minHandle.trigger('keydown', { key: 'Home' })
    expect(wrapper.emitted('update:modelValue').at(-1)).toEqual([{ min: 0, max: 8 }])
  })

  it('marks both handle buttons disabled and out of the tab order when disabled', () => {
    const wrapper = mount(WRange, {
      props: { modelValue: { min: 2, max: 8 }, min: 0, max: 10, disable: true }
    })

    for (const handle of wrapper.findAll('button')) {
      expect(handle.attributes('disabled')).toBeDefined()
      expect(handle.attributes('aria-disabled')).toBe('true')
    }
  })

  it('emits no update:modelValue on ArrowLeft/ArrowRight/Home/End while disabled', async () => {
    const wrapper = mount(WRange, {
      props: { modelValue: { min: 2, max: 8 }, min: 0, max: 10, disable: true }
    })
    const [minHandle, maxHandle] = wrapper.findAll('button')

    await minHandle.trigger('keydown', { key: 'ArrowLeft' })
    await minHandle.trigger('keydown', { key: 'ArrowRight' })
    await minHandle.trigger('keydown', { key: 'Home' })
    await maxHandle.trigger('keydown', { key: 'End' })

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('leaves aria-disabled unset while enabled', () => {
    const wrapper = mount(WRange, {
      props: { modelValue: { min: 2, max: 8 }, min: 0, max: 10 }
    })

    for (const handle of wrapper.findAll('button')) {
      expect(handle.attributes('disabled')).toBeUndefined()
      expect(handle.attributes('aria-disabled')).toBeUndefined()
    }
  })

  describe('accessible name', () => {
    it('sets aria-label on the min and max handles from ariaLabelMin/ariaLabelMax', () => {
      const wrapper = mount(WRange, {
        props: {
          modelValue: { min: 1, max: 6 },
          min: 1,
          max: 6,
          ariaLabelMin: 'Minimum heading depth',
          ariaLabelMax: 'Maximum heading depth'
        }
      })

      const [minHandle, maxHandle] = handles(wrapper)

      expect(minHandle.attributes('aria-label')).toBe('Minimum heading depth')
      expect(maxHandle.attributes('aria-label')).toBe('Maximum heading depth')
    })

    it('leaves aria-label unset on both handles when neither prop is passed', () => {
      const wrapper = mount(WRange, {
        props: { modelValue: { min: 1, max: 6 }, min: 1, max: 6 }
      })

      const [minHandle, maxHandle] = handles(wrapper)

      expect(minHandle.attributes('aria-label')).toBeUndefined()
      expect(maxHandle.attributes('aria-label')).toBeUndefined()
    })
  })
})
