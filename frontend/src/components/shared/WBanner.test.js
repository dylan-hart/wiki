import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WBanner from './WBanner.vue'

describe('WBanner', () => {
  it('renders its default slot content', () => {
    const wrapper = mount(WBanner, { slots: { default: 'Something happened.' } })

    expect(wrapper.text()).toContain('Something happened.')
  })

  it('renders the action slot only when given', () => {
    const bare = mount(WBanner, { slots: { default: 'Text' } })
    expect(bare.find('button').exists()).toBe(false)

    const withAction = mount(WBanner, {
      slots: { default: 'Text', action: '<button>Retry</button>' }
    })
    expect(withAction.find('button').text()).toBe('Retry')
  })

  // -> `--radius-control` is `0` under Ledger and a real value under Cobalt.
  it('draws its corner off --radius-control, not left unrounded', () => {
    const wrapper = mount(WBanner, { slots: { default: 'Text' } })

    expect(wrapper.classes()).toContain('rounded-control')
  })
})
