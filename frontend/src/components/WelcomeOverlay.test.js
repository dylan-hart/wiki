import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import WelcomeOverlay from './WelcomeOverlay.vue'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/**
 * Regression coverage for task 799: with exactly one editor enabled, "Create the Homepage" used to
 * still require opening a one-item menu and clicking its only entry. It should instead call
 * `pageStore.pageCreate` directly, skipping the menu.
 */
async function mountOverlay({ editors = {}, experimental = false } = {}) {
  setActivePinia(createPinia())

  const siteStore = useSiteStore()
  siteStore.editors = { asciidoc: false, markdown: false, wysiwyg: false, ...editors }
  siteStore.locales = { primary: 'en' }

  const flagsStore = useFlagsStore()
  flagsStore.experimental = experimental

  const pageStore = usePageStore()
  pageStore.pageCreate = vi.fn().mockResolvedValue()

  const userStore = useUserStore()
  userStore.permissions = []

  const router = await createTestRouter(['/:pathMatch(.*)*'])

  const i18n = createTestI18n()

  const wrapper = mount(WelcomeOverlay, {
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  return { wrapper, pageStore }
}

describe('WelcomeOverlay: create homepage button', () => {
  it('calls pageCreate directly, skipping the menu, when exactly one editor is enabled', async () => {
    const { wrapper, pageStore } = await mountOverlay({ editors: { markdown: true } })

    // -> No menu should even be in the DOM when there is nothing to pick between
    expect(wrapper.findComponent({ name: 'WMenu' }).exists()).toBe(false)

    await wrapper.find('button.w-btn').trigger('click')
    await flushPromises()

    expect(pageStore.pageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ editor: 'markdown' })
    )

    wrapper.unmount()
  })

  it('keeps the menu, not calling pageCreate on the button click alone, when several editors are enabled', async () => {
    const { wrapper, pageStore } = await mountOverlay({
      editors: { markdown: true, wysiwyg: true },
      experimental: true
    })

    expect(wrapper.findComponent({ name: 'WMenu' }).exists()).toBe(true)

    await wrapper.find('button.w-btn').trigger('click')
    await flushPromises()

    expect(pageStore.pageCreate).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('leaves the menu present (no editor to create with) when no editor is enabled at all', async () => {
    const { wrapper, pageStore } = await mountOverlay()

    expect(wrapper.findComponent({ name: 'WMenu' }).exists()).toBe(true)

    await wrapper.find('button.w-btn').trigger('click')
    await flushPromises()

    expect(pageStore.pageCreate).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})
