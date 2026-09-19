import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WAvatar from './WAvatar.vue'

describe('WAvatar', () => {
  it('stays a fixed disc by default, so its ~25 existing callers are unchanged', () => {
    const wrapper = mount(WAvatar, { slots: { default: 'AB' } })

    expect(wrapper.classes()).toContain('rounded-full')
    expect(wrapper.classes()).not.toContain('w-avatar--identity')
  })

  it('keeps the square and rounded shape props for callers that want them', () => {
    expect(mount(WAvatar, { props: { square: true } }).classes()).toContain('rounded-none')
    expect(mount(WAvatar, { props: { rounded: true } }).classes()).toContain('rounded')
  })

  it.each(['initials', 'plate'])(
    'identity="%s" takes the aesthetic radius and drops the fixed rounded utility',
    (identity) => {
      const wrapper = mount(WAvatar, { props: { identity } })

      expect(wrapper.classes()).toEqual(
        expect.arrayContaining(['w-avatar', 'w-avatar--identity', `w-avatar--${identity}`])
      )
      // -> `rounded-*` is a utility and would beat `.w-avatar--identity`'s token radius
      expect(wrapper.classes().some((c) => c.startsWith('rounded'))).toBe(false)
    }
  )

  it('identity wins over square, so Cobalt is not pinned to a square', () => {
    const wrapper = mount(WAvatar, { props: { identity: 'plate', square: true } })

    expect(wrapper.classes()).not.toContain('rounded-none')
  })
})
