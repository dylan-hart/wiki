import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import MainLayout from './MainLayout.vue'

/*
  `stores/common.js` reads `localStorage.getItem('locale')` at store-creation time -- see the
  identical stub/comment in `AdminLayout.test.js`. `MainLayout` pulls in `commonStore`
  unconditionally, so any mount needs this.
*/
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  })
})

/**
 * OpenProject #1644 (epic #1630, "Give the app a real heading hierarchy, a skip link and a `<nav>`
 * landmark on the primary sidebar"): a keyboard user had no way to bypass the sidebar/header and
 * land straight in the article -- WCAG 2.4.1 Bypass Blocks, Level A, with no alternative mechanism
 * anywhere else in the shell.
 *
 * The heavy chrome components (`HeaderNav`, `NavSidebar`, `NavEditMenu`, `LocaleSelectorMenu`,
 * `NavBrowseMenu`, `MainOverlayDialog`) are stubbed out: none of them is what this test is about,
 * and none of their own internals affect where the skip link sits in the DOM or how it targets
 * `WPage`'s `<main id="main-content">` (`e2e/`'s own `accessibility.spec.js` is what proves the
 * skip link works against the real, unstubbed shell end-to-end, focus-visibility and activation
 * included -- something no component-level mount can assert).
 */
function mountLayout() {
  setActivePinia(createPinia())

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        common: {
          a11y: { skipToContent: 'Skip to content' }
        }
      }
    },
    missingWarn: false,
    fallbackWarn: false
  })

  return mount(MainLayout, {
    global: {
      plugins: [router, i18n],
      stubs: {
        HeaderNav: true,
        NavSidebar: true,
        NavEditMenu: true,
        LocaleSelectorMenu: true,
        NavBrowseMenu: true,
        MainOverlayDialog: true,
        'router-view': true
      }
    }
  })
}

describe('MainLayout skip link', () => {
  it('is the first focusable element in the layout, ahead of the header', () => {
    const wrapper = mountLayout()

    const focusable = wrapper.element.querySelectorAll('a[href], button, [tabindex]')
    expect(focusable.length).toBeGreaterThan(0)
    expect(focusable[0].classList.contains('skip-link')).toBe(true)
  })

  it('renders as a link labelled via t(), targeting the main content id', () => {
    const wrapper = mountLayout()

    const link = wrapper.find('a.skip-link')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('#main-content')
    expect(link.text()).toBe('Skip to content')
  })

  it('is visually hidden off-screen until focused, per the .skip-link/:focus rule', () => {
    // -> `@vue/test-utils` never runs layout, so this can't assert a computed `top` value -- it
    //    asserts the rule itself instead, the same technique `AdminLayout.test.js`'s "defines the
    //    header-nav-btn--auto-width modifier" test uses for a CSS rule a mounted-component
    //    assertion can't otherwise reach.
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'MainLayout.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

    expect(styleBlock).toMatch(/\.skip-link\s*\{[^}]*position:\s*fixed[^}]*top:\s*-3rem/)
    expect(styleBlock).toMatch(/\.skip-link\s*\{[\s\S]*?&:focus\s*\{\s*top:\s*0;?\s*\}/)
  })
})
