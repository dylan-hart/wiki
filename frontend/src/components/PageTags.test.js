import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageTags from './PageTags.vue'
import { usePageStore } from '@/stores/page'

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

/**
 * Regression coverage for the tag-browse routing change (OpenProject #987): a tag chip used to send
 * the reader to `/_search?q=#tag`. It now opens the dedicated browse page instead, pre-selected on
 * that one tag.
 */
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
})

/**
 * OpenProject #2979 ("Cobalt typography: tags and revision"), `cobalt-typography.md` §3's "Tags and
 * revision" role table and §4.3's role swap. `.page-tag` is drawn attached to `document.body` (not a
 * detached div) because both rules key off a `body.body--cobalt &` ancestor selector, which only
 * matches once the class really sits on `<body>` -- the same pattern `PageHistoryOverlay.test.js`
 * uses for its own `body--dark` cascade assertions.
 *
 * Font SIZE is deliberately not asserted here via computed style: `WChip` sets its own inline
 * `font-size` (sibling Bug #2966, "tag chip size -- `WChip` inline-style conflict"), which wins over
 * this component's `.page-tag { font-size: 12px }` regardless of which lands first, so a computed-
 * style assertion here would pass or fail depending on that OTHER task's state rather than this
 * one's. The static-source test below pins this file's own declared value instead, and every test in
 * this describe unmounts its wrapper before returning so the next one starts from a clean
 * `document.body` rather than accumulating stale `.page-tag` nodes.
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
