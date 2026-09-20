import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageTags from './PageTags.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

async function mountPageTags(props = {}, { attachTo } = {}) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.tags = ['equipment', 'procedure']

  const router = await createTestRouter(['/', '/_tags'])

  const i18n = createTestI18n()

  const wrapper = mount(PageTags, {
    props,
    global: { plugins: [router, i18n] },
    ...(attachTo ? { attachTo } : {})
  })
  return { wrapper, router, pageStore }
}

describe('PageTags.vue', () => {
  it('view mode: clicking a tag chip opens the tag-browse page pre-selected on that tag', async () => {
    const { wrapper, router } = await mountPageTags({ edit: false })

    wrapper.vm.browseTag('equipment')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/_tags')
    expect(router.currentRoute.value.query.tags).toBe('equipment')
  })

  it('never routes to the old /_search?q=#tag shape', async () => {
    const { wrapper, router } = await mountPageTags({ edit: false })

    wrapper.vm.browseTag('procedure')
    await flushPromises()

    expect(router.currentRoute.value.path).not.toBe('/_search')
  })

  it('edit mode: removing a tag drops it from the store without navigating', async () => {
    const { wrapper, router, pageStore } = await mountPageTags({ edit: true })

    wrapper.vm.removeTag('equipment')

    expect(pageStore.tags).toEqual(['procedure'])
    expect(router.currentRoute.value.path).toBe('/')
  })

  /**
   * WChip's own inline `font-size` always beats `.page-tag`'s external rule, whatever the source
   * order or specificity, so only an explicit `size="sm"` gets the chip to 12px.
   */
  it('renders the tag chip at 12px via an explicit size prop, not the .page-tag CSS rule', async () => {
    const { wrapper } = await mountPageTags({ edit: false })

    const chips = wrapper.findAllComponents({ name: 'WChip' })
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) {
      expect(chip.props('size')).toBe('sm')
      expect(chip.find('.w-chip').attributes('style')).toContain('font-size: 12px')
    }
  })
})

/**
 * `.page-tag` is drawn attached to `document.body` rather than to a detached div: both rules key off
 * a `body.body--cobalt &` ancestor selector, which only matches once the class really sits on
 * `<body>`.
 *
 * Font SIZE is deliberately not asserted here via computed style -- `WChip`'s own inline `font-size`
 * wins over `.page-tag { font-size: 12px }` regardless of which lands first -- so the static-source
 * test below pins this file's declared value instead. Every test unmounts its wrapper so the next one
 * starts from a clean `document.body`.
 */
describe('PageTags.vue Cobalt typography (OpenProject #2979)', () => {
  afterEach(() => {
    document.body.classList.remove('body--cobalt')
  })

  it('keeps the tag chip at Ledger weight (unset, i.e. normal/400) when Cobalt is not active', async () => {
    const { wrapper } = await mountPageTags({ edit: false }, { attachTo: document.body })

    const chip = document.body.querySelector('.page-tag')
    expect(getComputedStyle(chip).fontWeight).toBe('normal')

    wrapper.unmount()
  })

  it('steps the tag chip up to weight 500 under Cobalt', async () => {
    document.body.classList.add('body--cobalt')
    const { wrapper } = await mountPageTags({ edit: false }, { attachTo: document.body })

    const chip = document.body.querySelector('.page-tag')
    expect(getComputedStyle(chip).fontWeight).toBe('500')

    wrapper.unmount()
  })

  it('declares .page-tag at 12px in its own stylesheet, unchanged by the weight swap', () => {
    const componentPath = join(dirname(fileURLToPath(import.meta.url)), 'PageTags.vue')
    const styleBlock = readFileSync(componentPath, 'utf-8')
    const rule = styleBlock.match(/\n\.page-tag\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule[1]).toMatch(/font-size:\s*12px;/)
  })

  it('renders the "#" mark under Ledger but hides it entirely under Cobalt', async () => {
    const ledger = await mountPageTags({ edit: false }, { attachTo: document.body })
    const ledgerHash = document.body.querySelector('.page-tag-hash')
    expect(getComputedStyle(ledgerHash).display).not.toBe('none')
    ledger.wrapper.unmount()

    document.body.classList.add('body--cobalt')
    const cobalt = await mountPageTags({ edit: false }, { attachTo: document.body })
    const cobaltHash = document.body.querySelector('.page-tag-hash')
    expect(getComputedStyle(cobaltHash).display).toBe('none')

    cobalt.wrapper.unmount()
  })
})

describe('PageTags.vue tag suggestions', () => {
  async function mountEditWithSiteTags(siteTags) {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.tags = siteTags.map((tag, i) => ({ tag, usageCount: 100 - i }))
    siteStore.tagsLoaded = true
    const router = await createTestRouter(['/', '/_tags'])
    const wrapper = mount(PageTags, {
      props: { edit: true },
      global: { plugins: [router, createTestI18n()] }
    })
    await flushPromises()
    return { wrapper, siteStore }
  }

  it('offers suggestions alphabetically rather than in usage order', async () => {
    const { wrapper } = await mountEditWithSiteTags(['zebra', 'apple', 'mango'])

    expect(wrapper.findComponent({ name: 'WSelect' }).props('options')).toEqual([
      'apple',
      'mango',
      'zebra'
    ])
  })

  it('places non-ASCII tags by locale order rather than after every ASCII tag', async () => {
    const { wrapper } = await mountEditWithSiteTags(['zoo', 'écrit', 'ecole', 'apple'])

    expect(wrapper.findComponent({ name: 'WSelect' }).props('options')).toEqual([
      'apple',
      'ecole',
      'écrit',
      'zoo'
    ])
  })

  it('leaves the site store in its most-used-first order', async () => {
    const { siteStore } = await mountEditWithSiteTags(['zebra', 'apple', 'mango'])

    expect(siteStore.tags.map((t) => t.tag)).toEqual(['zebra', 'apple', 'mango'])
  })

  it('slots a newly created tag into its alphabetical position', async () => {
    const { wrapper } = await mountEditWithSiteTags(['zebra', 'apple'])

    wrapper.vm.createTag('mango')
    await flushPromises()

    expect(wrapper.findComponent({ name: 'WSelect' }).props('options')).toEqual([
      'apple',
      'mango',
      'zebra'
    ])
  })
})
