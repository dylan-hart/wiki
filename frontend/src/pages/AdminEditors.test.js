import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { flushPromises } from '@vue/test-utils'

import AdminEditors from './AdminEditors.vue'
import { useAdminStore } from '@/stores/admin'
import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'

/**
 * Regression coverage for task 489: `AdminEditors.vue` needs a `code` row that is enabled by default
 * (not gated behind `flagsStore.experimental`, the way `asciidoc`/`blog`/`channel`/`redirect`/
 * `wysiwyg` still are) and whose toggle actually round-trips through `GET`/`PUT sites/:siteId` the
 * same way `asciidoc`/`markdown`/`wysiwyg` already do — a row present only in `state.config`'s
 * initial value but missing from `load()`/`save()` would silently reset to off on every page visit
 * and never actually reach the server.
 */
function mountPage() {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-1'
  const siteStore = useSiteStore()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(AdminEditors, {
    global: { plugins: [i18n] }
  })

  return { wrapper, adminStore, siteStore }
}

/**
 * Regression coverage for task 491: before this task `asciidoc` was `isDisabled: true` with a
 * description implying real-time preview, even though no `EditorAsciidoc.vue` existed -- a
 * disabled-but-visible-under-experimental-flag row that misrepresented what actually worked. Now that
 * a real (if minimal) AsciiDoc editor exists, its row and copy should match `code`'s: visible without
 * the experimental flag, its toggle enabled, and its description honest about there being no preview.
 */
describe('AdminEditors', () => {
  it('shows the asciidoc editor row without requiring the experimental flag, with an enabled toggle', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ editors: {} }) })
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.text()).toContain('admin.editors.asciidocName')
    expect(wrapper.text()).toContain('admin.editors.asciidocDescription')
    const asciidocEditor = wrapper.vm.editors.find((e) => e.id === 'asciidoc')
    expect(asciidocEditor.isDisabled).toBeFalsy()
  })

  it('load()/save() round-trip editors.asciidoc.isActive through the site config', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ editors: { asciidoc: { isActive: true } } })
    })
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    const { wrapper, adminStore, siteStore } = mountPage()
    await flushPromises()

    expect(wrapper.vm.state.config.asciidoc).toBe(true)

    siteStore.id = adminStore.currentSiteId
    await wrapper.vm.save()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'sites/site-1',
      expect.objectContaining({
        json: expect.objectContaining({
          editors: expect.objectContaining({ asciidoc: { isActive: true } })
        })
      })
    )
    expect(siteStore.editors.asciidoc).toBe(true)
  })

  it('shows the code editor row without requiring the experimental flag', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ editors: {} }) })
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.text()).toContain('admin.editors.codeName')
    const toggle = wrapper.find('.w-toggle')
    expect(toggle.exists()).toBe(true)
  })

  it('load() reads editors.code.isActive from the site config', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ editors: { code: { isActive: true } } })
    })
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.vm.state.config.code).toBe(true)
  })

  it('save() sends editors.code.isActive in the PUT body', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ editors: { code: { isActive: true } } })
    })
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    const { wrapper, adminStore, siteStore } = mountPage()
    await flushPromises()

    siteStore.id = adminStore.currentSiteId
    await wrapper.vm.save()

    expect(API_CLIENT.put).toHaveBeenCalledWith(
      'sites/site-1',
      expect.objectContaining({
        json: expect.objectContaining({
          editors: expect.objectContaining({ code: { isActive: true } })
        })
      })
    )
    // -> The current site's own store follows the saved config, the same as the other editors
    expect(siteStore.editors.code).toBe(true)
  })

  /**
   * Regression coverage for task 492: `api`/`blog`/`channel` were unbacked speculation — no
   * `EDITOR_CONTENT_TYPES` entry, no schema property, no reachable `editorComponents` registration —
   * and were removed rather than left as functionless toggles. This must hold even with the
   * experimental flag on, since that flag is what previously made them visible at all.
   */
  it('never renders api/blog/channel rows, even with the experimental flag enabled', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ editors: {} }) })
    const { wrapper } = mountPage()
    const flagsStore = useFlagsStore()
    flagsStore.experimental = true
    await flushPromises()

    const ids = wrapper.vm.editors.map((e) => e.id)
    expect(ids).not.toContain('api')
    expect(ids).not.toContain('blog')
    expect(ids).not.toContain('channel')
    expect(wrapper.text()).not.toContain('admin.editors.apiName')
    expect(wrapper.text()).not.toContain('admin.editors.blogName')
    expect(wrapper.text()).not.toContain('admin.editors.channelName')
    expect(wrapper.vm.state.config.api).toBeUndefined()
    expect(wrapper.vm.state.config.blog).toBeUndefined()
    expect(wrapper.vm.state.config.channel).toBeUndefined()
  })
})
