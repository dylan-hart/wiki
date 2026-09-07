import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WBtnToggle from './WBtnToggle.vue'

const OPTIONS = [
  { label: 'One', value: 1 },
  { label: 'Two', value: 2 },
  { label: 'Three', value: 3 }
]

describe('WBtnToggle', () => {
  it('renders one radio button per option, and emits the picked value on click', async () => {
    const wrapper = mount(WBtnToggle, { props: { modelValue: 1, options: OPTIONS } })

    const segments = wrapper.findAll('[role="radio"]')
    expect(segments).toHaveLength(3)
    expect(segments[0].attributes('aria-checked')).toBe('true')
    expect(segments[1].attributes('aria-checked')).toBe('false')

    await segments[2].trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[3]])
  })

  /*
   * "A segmented control rounds only its outer edges (`rounded-s-control` / `rounded-e-control`),
   * never each segment" (`css/tailwind.css`'s Cobalt shape-token comment) -- `0` under Ledger
   * (unchanged from before this task), a real value under Cobalt (`body.body--cobalt`, OpenProject
   * #2767/#2772). The logical `-s-`/`-e-` corners keep this correct under RTL.
   */
  it('rounds only the outer edges of the strip, off --radius-control', () => {
    const wrapper = mount(WBtnToggle, { props: { modelValue: 1, options: OPTIONS } })
    const segments = wrapper.findAll('[role="radio"]')

    expect(segments[0].classes()).toContain('rounded-s-control')
    expect(segments[0].classes()).not.toContain('rounded-e-control')
    expect(segments[1].classes()).not.toContain('rounded-s-control')
    expect(segments[1].classes()).not.toContain('rounded-e-control')
    expect(segments[2].classes()).toContain('rounded-e-control')
    expect(segments[2].classes()).not.toContain('rounded-s-control')
  })
})
