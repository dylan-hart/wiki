import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import FooterNav from './FooterNav.vue'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

/**
 * `logoText` gates only the site title beside the logo, never the footer -- pinned false here so
 * the suite below proves the footer is indifferent to it.
 */
function mountFooter(props = {}) {
  setActivePinia(createPinia())

  const i18n = createTestI18n({
    common: {
      footerCopyright: '© {year} {company}. All rights reserved.',
      footerLicense: 'Content is available under the {license}, by {company}.',
      footerGeneric: 'Powered by {link}, an open source project.',
      footerPoweredBy: 'Powered by {link}',
      license: { alr: 'All Rights Reserved' }
    }
  })

  const wrapper = mount(FooterNav, {
    props,
    global: { plugins: [i18n] }
  })
  const siteStore = useSiteStore()
  siteStore.logoText = false

  return { wrapper, siteStore }
}

describe('FooterNav — hasSiteFooter edge cases', () => {
  it('hides the company/license line (not a broken blank line) when company is an empty string', async () => {
    const { wrapper, siteStore } = mountFooter()
    siteStore.company = ''
    siteStore.contentLicense = 'alr'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('All Rights Reserved')
    expect(wrapper.text()).not.toContain('©')
    expect(wrapper.text()).toContain('Cardinal.js')
  })

  it('renders a very long company name in full, without truncation, guarded by CSS overflow-wrap', async () => {
    const { wrapper, siteStore } = mountFooter()
    const longName = 'A'.repeat(300)
    siteStore.company = longName
    siteStore.contentLicense = 'alr'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain(longName)
    // -> Word breaking is not measurable without a layout engine, so this pins the rule itself.
    //    `test.css: true` injects the compiled scoped style into the document head rather than
    //    into the mounted component's own subtree, which is why it is read from there.
    const styleText = Array.from(document.head.querySelectorAll('style'))
      .map((el) => el.textContent)
      .join('\n')
    expect(styleText).toContain('overflow-wrap: anywhere')
  })

  it('is unaffected by logoText -- the footer has no reference to it', async () => {
    const { wrapper, siteStore } = mountFooter()
    siteStore.company = 'Acme Corp'
    siteStore.contentLicense = 'alr'
    siteStore.logoText = false
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Acme Corp')

    siteStore.logoText = true
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('Acme Corp')
  })

  it('generic mode never shows the company/license line even when both are set', async () => {
    const { wrapper, siteStore } = mountFooter({ generic: true })
    siteStore.company = 'Acme Corp'
    siteStore.contentLicense = 'alr'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('Acme Corp')
  })
})
