import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import FooterNav from './FooterNav.vue'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Task 749's `hasSiteFooter` audit: it only checks truthiness of `company`/`contentLicense`, with no
 * reference to `logoText` at all (that flag only ever gates the site title next to the logo in
 * `HeaderNav`/`Login.vue`/`AdminGeneral.vue`'s preview) -- so `logoText:false` has no interaction
 * with the footer, verified below by leaving it at its default `false` throughout.
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

    // No "© 2026 . All Rights Reserved" -- the i18n-t for it doesn't render at all.
    expect(wrapper.text()).not.toContain('All Rights Reserved')
    expect(wrapper.text()).not.toContain('©')
    // The second, always-on line still renders normally.
    expect(wrapper.text()).toContain('Wiki.js')
  })

  it('renders a very long company name in full, without truncation, guarded by CSS overflow-wrap', async () => {
    const { wrapper, siteStore } = mountFooter()
    const longName = 'A'.repeat(300)
    siteStore.company = longName
    siteStore.contentLicense = 'alr'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain(longName)
    // Defensive wrap so a single unbroken token can't push the footer bar wider than the page --
    // real layout (word breaking) isn't measurable under jsdom, so this pins the CSS rule itself.
    // Vitest's CSS pipeline (`test.css: true`) injects the compiled scoped style into the document
    // head rather than into the mounted component's own subtree, so it's read from there.
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
