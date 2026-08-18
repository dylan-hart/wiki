import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import PageNewMenu from './PageNewMenu.vue'
import { useSiteStore } from '@/stores/site'

/**
 * `WMenu` only renders its content once opened (a real anchor-triggered popup, teleported to
 * `document.body`) -- stubbed here to a plain `<slot />` so the `w-item v-if`s underneath, which are
 * what this test actually cares about, are reachable without driving that open/close mechanics.
 */
function mountMenu(props = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.editors = { asciidoc: false, markdown: true, wysiwyg: false }

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(PageNewMenu, {
    props,
    global: {
      plugins: [i18n],
      stubs: { WMenu: { template: '<div><slot /></div>' } }
    }
  })
}

describe('PageNewMenu: import menu item', () => {
  it('fetches the extensions status once opened, to decide whether to show itself', () => {
    globalThis.API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ pandoc: false })
    })

    mountMenu()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith('system/extensions/status')
  })

  it('hides the "Import Page" item when Pandoc is not installed', async () => {
    const wrapper = mountMenu()
    const siteStore = useSiteStore()
    siteStore.extensionsStatus = { pandoc: false }
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('pages.import.menuLabel')
  })

  it('shows the "Import Page" item when Pandoc is installed', async () => {
    const wrapper = mountMenu()
    const siteStore = useSiteStore()
    siteStore.extensionsStatus = { pandoc: true }
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('pages.import.menuLabel')
  })
})
