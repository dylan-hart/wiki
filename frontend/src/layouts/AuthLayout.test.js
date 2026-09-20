import { describe, expect, it } from 'vitest'

import AuthLayout from './AuthLayout.vue'

import { mountWithApp } from '../../test/mount.js'

function mountLayout() {
  const { wrapper } = mountWithApp(AuthLayout, {
    stubs: { 'router-view': true }
  })

  return wrapper
}

describe('AuthLayout', () => {
  it('renders the routed page inside the shell', () => {
    const wrapper = mountLayout()

    expect(wrapper.find('.w-page-container').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'RouterView' }).exists()).toBe(true)
  })

  it('draws no footer of its own -- the login page places the colophon in its own column', () => {
    const wrapper = mountLayout()

    expect(wrapper.find('.site-footer').exists()).toBe(false)
    expect(wrapper.find('.w-footer').exists()).toBe(false)
  })
})
