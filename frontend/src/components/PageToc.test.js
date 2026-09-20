import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import PageToc from './PageToc.vue'

import { createTestI18n } from '../../test/i18n.js'

/** `useI18n()` needs an installed i18n instance to resolve at all, so every mount goes through here. */
function mountToc(props, options = {}) {
  const i18n = createTestI18n({ 'common.page.toc': 'Table of Contents' })
  return mount(PageToc, { props, global: { plugins: [i18n] }, ...options })
}

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
    const wrapper = mountToc({ nodes, selected: '#usage-basic' })

    const links = wrapper.findAll('.page-toc-link')
    expect(links.map((link) => link.text())).toEqual(['Introduction', 'Usage', 'Basic'])

    const active = wrapper.find('.page-toc-item--active')
    expect(active.exists()).toBe(true)
    expect(active.text()).toBe('Basic')
  })

  it('respects minDepth/maxDepth, hiding headings outside the range', () => {
    const wrapper = mountToc({ nodes, minDepth: 2, maxDepth: 2 })

    const links = wrapper.findAll('.page-toc-link')
    expect(links.map((link) => link.text())).toEqual(['Basic'])
  })

  it('emits update:selected and prevents the default jump when a heading exists in the document', async () => {
    const heading = document.createElement('h2')
    heading.id = 'usage'
    document.body.appendChild(heading)

    const wrapper = mountToc({ nodes, selected: null }, { attachTo: document.body })
    try {
      const link = wrapper.findAll('.page-toc-link').at(1)
      await link.trigger('click')

      expect(wrapper.emitted('update:selected')).toEqual([['#usage']])
    } finally {
      wrapper.unmount()
      heading.remove()
    }
  })

  it('localizes its landmark label instead of a hardcoded English string', () => {
    const wrapper = mountToc({ nodes, selected: null })

    expect(wrapper.find('nav.page-toc').attributes('aria-label')).toBe('Table of Contents')
  })

  it('does not hardcode a literal aria-label string in the template', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'PageToc.vue'), 'utf-8')
    // -> Bound (`:aria-label="…"`) to a `t()` call, not a plain `aria-label="Some English text"`
    expect(source).not.toMatch(/(?<!:)aria-label="/)
    expect(source).toMatch(/:aria-label="t\(.common\.page\.toc.\)"/)
  })
})
