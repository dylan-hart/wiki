import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WBadge from './WBadge.vue'

describe('WBadge', () => {
  it('renders the label prop when no default slot content is given', () => {
    const wrapper = mount(WBadge, { props: { label: 3 } })

    expect(wrapper.text()).toBe('3')
  })

  it('is not positioned by default', () => {
    const wrapper = mount(WBadge, { props: { label: 1 } })

    expect(wrapper.classes()).not.toContain('absolute')
  })

  // -> OpenProject #1590's physical-positioning triage: `floating` deliberately keeps the
  //    physical `right-0` (paired with a physical `translate-x-1/2` straddle, which never mirrors
  //    under RTL on its own) rather than converting only half the pair to `end-0` — see the
  //    justification comment on WBadge.vue's `classes` computed.
  it('pins a floating badge to the physical top-right corner', () => {
    const wrapper = mount(WBadge, { props: { label: 1, floating: true } })

    expect(wrapper.classes()).toEqual(
      expect.arrayContaining([
        'absolute',
        'top-0',
        'right-0',
        'translate-x-1/2',
        '-translate-y-1/3'
      ])
    )
  })

  // -> OpenProject #1805: title is a declared prop (not left to $attrs fallthrough), e.g.
  //    ProfileAuth.vue's 2FA-active badge, which pairs it with an icon-only label.
  it('renders a native title tooltip', () => {
    const wrapper = mount(WBadge, { props: { label: 1, title: '2FA is active' } })

    expect(wrapper.attributes('title')).toBe('2FA is active')
  })
})
