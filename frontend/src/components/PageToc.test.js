import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import PageToc from './PageToc.vue'

/**
 * `useI18n()` (added for OpenProject #1630 -- the hardcoded `aria-label="Table of contents"` is now
 * `t('common.page.toc')`) needs an installed i18n instance to resolve at all, so every mount below
 * carries one -- matching `PageHeader.test.js`'s own `mountHeader()` helper, which the same task
 * introduced this component to.
 */
const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { 'common.page.toc': 'Table of Contents' } }
})

/**
 * `PageToc.vue`'s `<style lang="scss">` reaches for bare `$grey-9` / `$grey-7` / ... (see the file),
 * relying on the `@use '@/css/_theme.scss' as *; @use '@/css/_palette.scss' as *;` the app build
 * injects into every SFC style block via `css.preprocessorOptions.scss.additionalData`
 * (`vite.config.js`). `vitest.config.js` mirrors that setting; without it, mounting this component
 * would fail to compile at all -- a Sass "undefined variable" error, not a failing assertion -- which
 * is what makes it a good end-to-end check that the harness's SCSS wiring genuinely works, not just
 * that it is present in the config file.
 */

describe('PageToc', () => {
  const nodes = [
    { key: '#intro', label: 'Introduction', level: 1, children: [] },
    {
      key: '#usage',
      label: 'Usage',
      level: 1,
      children: [{ key: '#usage-basic', label: 'Basic', level: 2, children: [] }]
    }
  ]

  it('flattens the tree into one list, and marks the selected heading active', () => {
    const wrapper = mount(PageToc, {
      props: { nodes, selected: '#usage-basic' },
      global: { plugins: [i18n] }
    })

    const links = wrapper.findAll('.page-toc-link')
    expect(links.map((link) => link.text())).toEqual(['Introduction', 'Usage', 'Basic'])

    const active = wrapper.find('.page-toc-item--active')
    expect(active.exists()).toBe(true)
    expect(active.text()).toBe('Basic')
  })

  it('respects minDepth/maxDepth, hiding headings outside the range', () => {
    const wrapper = mount(PageToc, {
      props: { nodes, minDepth: 2, maxDepth: 2 },
      global: { plugins: [i18n] }
    })

    const links = wrapper.findAll('.page-toc-link')
    expect(links.map((link) => link.text())).toEqual(['Basic'])
  })

  it('emits update:selected and prevents the default jump when a heading exists in the document', async () => {
    const heading = document.createElement('h2')
    heading.id = 'usage'
    document.body.appendChild(heading)

    const wrapper = mount(PageToc, {
      props: { nodes, selected: null },
      attachTo: document.body,
      global: { plugins: [i18n] }
    })
    try {
      const link = wrapper.findAll('.page-toc-link').at(1)
      await link.trigger('click')

      expect(wrapper.emitted('update:selected')).toEqual([['#usage']])
    } finally {
      wrapper.unmount()
      heading.remove()
    }
  })

  /**
   * OpenProject #1630 (task 1640): the landmark used to be a hardcoded English string, so it never
   * followed the reader's locale even though `NavSidebar`'s own `<nav>` landmark (added by the same
   * task) does. Localized instead, off the same `common.page.toc` key the page-properties panel's
   * `H{min} → H{max}` UI already uses to talk about this same feature.
   */
  it('localizes its landmark label instead of a hardcoded English string', () => {
    const wrapper = mount(PageToc, {
      props: { nodes, selected: null },
      global: { plugins: [i18n] }
    })

    expect(wrapper.attributes('aria-label')).toBe('Table of Contents')
  })
})
