import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WBadge from './WBadge.vue'

describe('WBadge', () => {
  it('renders the label prop when no default slot content is given', () => {
    const wrapper = mount(WBadge, { props: { label: 3 } })

    expect(wrapper.text()).toBe('3')
  })

  it('draws its corner off --radius-mark unless rounded is set', () => {
    // -> `--radius-mark` is `0` under Ledger and a real value under Cobalt.
    const mark = mount(WBadge, { props: { label: 1 } })
    expect(mark.classes()).toContain('rounded-mark')
    expect(mark.classes()).not.toContain('rounded-none')

    const pill = mount(WBadge, { props: { label: 1, rounded: true } })
    expect(pill.classes()).toContain('rounded-full')
  })

  it('is not positioned by default', () => {
    const wrapper = mount(WBadge, { props: { label: 1 } })

    expect(wrapper.classes()).not.toContain('absolute')
  })

  it('pins a floating badge to the inline-end top corner, straddling it in either direction', () => {
    const wrapper = mount(WBadge, { props: { label: 1, floating: true } })

    expect(wrapper.classes()).toEqual(
      expect.arrayContaining([
        'absolute',
        'top-0',
        'end-0',
        'translate-x-1/2',
        'rtl:-translate-x-1/2',
        '-translate-y-1/3'
      ])
    )
    expect(wrapper.classes()).not.toContain('right-0')
  })

  it('renders a native title tooltip', () => {
    const wrapper = mount(WBadge, { props: { label: 1, title: '2FA is active' } })

    expect(wrapper.attributes('title')).toBe('2FA is active')
  })
})
