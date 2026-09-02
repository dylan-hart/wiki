import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageTags from './PageTags.vue'
import { usePageStore } from '@/stores/page'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

async function mountPageTags(props = {}) {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.tags = ['equipment', 'procedure']

  const router = await createTestRouter(['/', '/_tags'])

  const i18n = createTestI18n()

  const wrapper = mount(PageTags, {
    props,
    global: { plugins: [router, i18n] }
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
