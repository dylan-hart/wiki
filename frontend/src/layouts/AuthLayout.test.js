import { describe, expect, it } from 'vitest'

import AuthLayout from './AuthLayout.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * `AuthLayout` draws the shell and nothing else.
 *
 * Task 749 added a `FooterNav` here because the login screen was the one place a site's
 * copyright/license line never appeared. OpenProject #2627 moved that colophon into
 * `pages/Login.vue`'s own credentials column, which is where `Cardinal Wiki - Login 3x.dc.html`
 * draws it -- a footer bar under a row that is already `100vh` tall was present in the DOM and off
 * the bottom of a screen that does not otherwise scroll. `pages/Login.test.js` carries 749's
 * assertion now; this file guards the other half, that the shell does not draw a SECOND one.
 */
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
