import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import PageNewMenu from './PageNewMenu.vue'
import BlueprintIcon from './BlueprintIcon.vue'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

/**
 * Regression coverage for task 493's adjacent fix: `PageNewMenu.vue` (the header's own "+ New Page"
 * menu) is a second, independently-built editor-choice UI that task 492 left with three dead rows --
 * `channel`/`blog`/`api` -- none of which had a matching `editorComponents` entry after that task's
 * cleanup, so picking one opened onto a blank editor. It was also still missing the `code` editor
 * (task 489) entirely, and hid its now-unconditional `asciidoc` row (task 491) behind the experimental
 * flag it no longer needs.
 */
function mountMenu({ editors = {}, experimental = false } = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.editors = { asciidoc: false, code: false, markdown: true, wysiwyg: false, ...editors }
  const flagsStore = useFlagsStore()
  flagsStore.experimental = experimental
  const pageStore = usePageStore()
  pageStore.pageCreate = vi.fn()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(PageNewMenu, {
    global: {
      plugins: [i18n],
      components: { BlueprintIcon },
      // -> `w-menu` only renders its slot once opened by whatever `w-btn` wraps it in the real app
      //    (`HeaderNav.vue`); this test cares about which `<w-item>`s the menu holds, not the
      //    open/close mechanics `WMenu.vue` already owns, so the gating is bypassed here.
      stubs: { WMenu: { template: '<div><slot /></div>' } }
    },
    attachTo: document.body
  })

  return { wrapper, pageStore }
}

describe('PageNewMenu', () => {
  it('never offers the removed channel/blog/api editors, even with the experimental flag on', async () => {
    const { wrapper } = mountMenu({ experimental: true })
    await flushPromises()

    const text = wrapper.text()
    expect(text).not.toContain('Discussion Space')
    expect(text).not.toContain('New Blog Page')
    expect(text).not.toContain('API Documentation')

    wrapper.unmount()
  })

  it('offers the code editor once active, calling pageCreate with editor: code', async () => {
    const { wrapper, pageStore } = mountMenu({ editors: { code: true } })
    await flushPromises()

    const codeItem = wrapper.findAll('.w-item').find((i) => i.text().includes('New Code Page'))
    expect(codeItem).toBeTruthy()
    await codeItem.trigger('click')

    expect(pageStore.pageCreate).toHaveBeenCalledWith(expect.objectContaining({ editor: 'code' }))

    wrapper.unmount()
  })

  it('offers asciidoc without requiring the experimental flag', async () => {
    const { wrapper } = mountMenu({ editors: { asciidoc: true }, experimental: false })
    await flushPromises()

    expect(wrapper.text()).toContain('New AsciiDoc Page')

    wrapper.unmount()
  })
})

describe('PageNewMenu: import menu item', () => {
  /*
    Regression coverage for OpenProject #1092: both items used to be hidden behind
    `siteStore.extensionsStatus.pandoc`, so an instance with no Pandoc extension installed had no
    bulk-add-pages path at all -- even though `format: 'markdown'` needs no Pandoc and is available
    unconditionally. Neither item reads `extensionsStatus` any more, so it's never fetched here
    either (unlike this suite's own pre-#1092 version, which asserted the opposite).
  */
  it('always offers "Import Page" and "Import Multiple Pages", with no extensions-status fetch', async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    expect(wrapper.text()).toContain('pages.import.menuLabel')
    expect(wrapper.text()).toContain('pages.importBatch.menuLabel')
    expect(globalThis.API_CLIENT.get).not.toHaveBeenCalledWith('system/extensions/status')
  })

  it("still offers both items when a site's extensionsStatus explicitly says Pandoc is missing", async () => {
    const { wrapper } = mountMenu()
    const siteStore = useSiteStore()
    siteStore.extensionsStatus = { pandoc: false }
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('pages.import.menuLabel')
    expect(wrapper.text()).toContain('pages.importBatch.menuLabel')
  })
})
