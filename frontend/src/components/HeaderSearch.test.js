import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import HeaderSearch from './HeaderSearch.vue'
import { useSiteStore } from '@/stores/site'

/**
 * Covers the `popularTags` computed (HeaderSearch.vue ~line 176): it must sort by usage count
 * DESCENDING -- most-used tag first -- not ascending. See the git history for the FIXME this
 * replaced: `orderBy(tags, ['usageCount', 'desc'], ['asc', 'asc'])` passed a non-existent `'desc'`
 * property as a second sort KEY rather than as the ORDER for `usageCount`, so every tag sorted
 * ascending by usage.
 */
async function mountWithTags(tags) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.features.search = true
  siteStore.tagsLoaded = true
  siteStore.tags = tags

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(HeaderSearch, {
    global: {
      plugins: [router, i18n]
    }
  })

  // -> The panel (and the popular-tags list inside it) only renders once the field is focused --
  //    mirrors what a real user does, rather than reaching into component internals for the flag.
  await wrapper.find('.header-search-input').trigger('focus')

  return wrapper
}

describe('HeaderSearch popularTags', () => {
  it('sorts tags by usage count descending, most-used first', async () => {
    const wrapper = await mountWithTags([
      { tag: 'a', usageCount: 1 },
      { tag: 'b', usageCount: 5 },
      { tag: 'c', usageCount: 3 }
    ])

    const renderedTags = wrapper.findAll('w-chip').map((chip) => chip.text().trim())

    expect(renderedTags).toEqual(['b', 'c', 'a'])
  })
})
