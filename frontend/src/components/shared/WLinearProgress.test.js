import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WLinearProgress from './WLinearProgress.vue'

describe('WLinearProgress', () => {
  // -> OpenProject #1590: the determinate fill was found anchored to the physical `left-0`, which
  //    reads as filling toward the trailing edge instead of the reading-end one under RTL. Fixed
  //    to `start-0` rather than allowlisted -- this is the regression test for that fix.
  it('anchors the fill to the logical inline-start edge, not the physical left', () => {
    const wrapper = mount(WLinearProgress, { props: { value: 0.5 } })

    const fill = wrapper.find('.w-linear-progress > div:nth-child(2)')
    expect(fill.classes()).toContain('start-0')
    expect(fill.classes()).not.toContain('left-0')
  })

  it('sets the fill width from the value prop', () => {
    const wrapper = mount(WLinearProgress, { props: { value: 0.5 } })

    const fill = wrapper.find('.w-linear-progress > div:nth-child(2)')
    expect(fill.attributes('style')).toContain('width: 50%')
  })

  it('reports progressbar ARIA attributes for a determinate value, and omits them when indeterminate', () => {
    const determinate = mount(WLinearProgress, { props: { value: 0.25 } })
    expect(determinate.attributes('aria-valuenow')).toBe('25')
    expect(determinate.attributes('aria-valuemin')).toBe('0')
    expect(determinate.attributes('aria-valuemax')).toBe('100')

    const indeterminate = mount(WLinearProgress, { props: { indeterminate: true } })
    expect(indeterminate.attributes('aria-valuenow')).toBeUndefined()
  })
})
