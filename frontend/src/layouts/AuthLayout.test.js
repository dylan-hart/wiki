import { describe, expect, it } from 'vitest'

import AuthLayout from './AuthLayout.vue'
import { useSiteStore } from '@/stores/site'

import { mountWithApp } from '../../test/mount.js'

/**
 * Regression for task 749: `AuthLayout` (the shell behind `Login.vue` and every other auth route)
 * rendered no footer at all, so a site's copyright/license line and `footerExtra` text -- visible on
 * every other layout via `FooterNav` -- never appeared on the login screen. 2.5.x's login screen did
 * include this footer, so its absence was a gap, not an intentional redesign.
 */
function mountLayout() {
  const { wrapper } = mountWithApp(AuthLayout, {
    messages: {
      common: {
        footerCopyright: '© {year} {company}. All rights reserved.',
        footerLicense: 'Content is available under the {license}, by {company}.',
        footerGeneric: 'Powered by {link}, an open source project.',
        footerPoweredBy: 'Powered by {link}',
        license: { alr: 'All Rights Reserved' }
      }
    },
    stubs: { 'router-view': true }
  })

  return wrapper
}

describe('AuthLayout — site footer', () => {
  it('renders the site footer (company/license) on the auth shell, same as the other layouts', () => {
    const wrapper = mountLayout()
    const siteStore = useSiteStore()
    siteStore.company = 'Acme Corp'
    siteStore.contentLicense = 'alr'
    siteStore.footerExtra = 'Extra footer text'

    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.find('.site-footer').exists()).toBe(true)
      expect(wrapper.text()).toContain('Acme Corp')
      expect(wrapper.text()).toContain('Extra footer text')
    })
  })

  it('still renders the generic "powered by Cardinal.js" line with no site branding configured', () => {
    const wrapper = mountLayout()

    expect(wrapper.find('.site-footer').exists()).toBe(true)
    expect(wrapper.text()).toContain('Cardinal.js')
  })
})
