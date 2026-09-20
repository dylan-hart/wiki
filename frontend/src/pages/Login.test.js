import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import Login from './Login.vue'

import { mountWithApp } from '../../test/mount.js'

/**
 * jsdom runs no layout engine, so a height in pixels cannot be asserted; what can be is the contract
 * that produces it -- the classes the stylesheet hangs on, and the `size`/`padding` pair each band
 * is built from, since `WBtn` writes its own `min-height` as an inline style no rule can override.
 */

const MESSAGES = {
  auth: {
    login: { title: 'Login' },
    loginToContinue: 'Login to continue',
    selectAuthProvider: 'Sign in with',
    actions: { login: 'Log In' },
    fields: { email: 'Email Address', password: 'Password' },
    passkeys: { signin: 'Log In with a Passkey' }
  },
  common: {
    footerCopyright: '© {year} {company}. All rights reserved.',
    footerLicense: 'Content is available under the {license}, by {company}.',
    footerGeneric: 'Powered by {link}, an open source project.',
    footerPoweredBy: 'Powered by {link}',
    license: { alr: 'All Rights Reserved' }
  }
}

async function mountLogin(site = {}) {
  // -> The panel asks for the site's strategies the moment it mounts; nothing here is about them
  API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve([]) })

  const { wrapper, siteStore } = mountWithApp(Login, {
    messages: MESSAGES,
    stores: { site: { id: 'site-1', title: 'Cardinal', logoText: true, ...site } }
  })
  await flushPromises()

  return { wrapper, siteStore }
}

describe('Login — the two-column shell', () => {
  it('draws the credentials column beside a background pane', async () => {
    const { wrapper } = await mountLogin()

    expect(wrapper.find('.auth-content').exists()).toBe(true)
    expect(wrapper.find('.auth-bg').exists()).toBe(true)
    expect(wrapper.find('.auth-bg').attributes('aria-hidden')).toBe('true')
  })

  it('renders the wordmark and the lead line in their own classes, not on bare elements', async () => {
    const { wrapper } = await mountLogin()

    expect(wrapper.find('h2.auth-site-title').text()).toBe('Cardinal')
    expect(wrapper.find('p.auth-lead').text()).toBe('Login to continue')
  })

  it('hides the wordmark when the site draws its name in its logo instead', async () => {
    const { wrapper } = await mountLogin({ logoText: false })

    expect(wrapper.find('.auth-site-title').exists()).toBe(false)
  })
})

describe('Login — the colophon', () => {
  it('renders the site footer inside the credentials column (task 749, relocated by #2627)', async () => {
    const { wrapper, siteStore } = await mountLogin()
    siteStore.company = 'Acme Corp'
    siteStore.contentLicense = 'alr'
    siteStore.footerExtra = 'Extra footer text'
    await wrapper.vm.$nextTick()

    const colophon = wrapper.find('.auth-colophon')
    expect(colophon.exists()).toBe(true)
    expect(colophon.find('.site-footer').exists()).toBe(true)
    expect(colophon.text()).toContain('Acme Corp')
    expect(colophon.text()).toContain('Extra footer text')
  })

  it('still shows the generic "powered by" line with no site branding configured', async () => {
    const { wrapper } = await mountLogin()

    expect(wrapper.find('.auth-colophon .site-footer').text()).toContain('Cardinal.js')
  })

  it('places it inside the column, not after it -- the pane is a full viewport tall', async () => {
    const { wrapper } = await mountLogin()

    expect(wrapper.find('.auth-content .auth-colophon').exists()).toBe(true)
  })
})
