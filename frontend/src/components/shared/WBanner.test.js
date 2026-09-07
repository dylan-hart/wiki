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

  // -> `0` under Ledger (unchanged from before this task), a real value under Cobalt
  //    (`body.body--cobalt`, OpenProject #2767/#2772), matching "banners ... take
  //    `--radius-control`"
  it('draws its corner off --radius-control, not left unrounded', () => {
    const wrapper = mount(WBanner, { slots: { default: 'Text' } })

    expect(wrapper.classes()).toContain('rounded-control')
  })
})
