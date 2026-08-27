import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WRange from './WRange.vue'

/** The two draggable handles, in `[min, max]` order -- see the `v-for="handle of ['min', 'max']"`. */
function handles(wrapper) {
  return wrapper.findAll('[role="slider"]')
}

describe('WRange', () => {
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
