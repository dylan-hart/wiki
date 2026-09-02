import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'

import AdminEditors from './AdminEditors.vue'
import { useAdminStore } from '@/stores/admin'
import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { loading } from '@/composables/loading'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

vi.mock('@/composables/loading', async (importOriginal) => ({
  ...(await importOriginal()),
  loading: { show: vi.fn(), hide: vi.fn() }
}))

/**
 * Regression coverage for task 489: `AdminEditors.vue` needs a `code` row that is enabled by default
 * (not gated behind `flagsStore.experimental`, the way `asciidoc`/`blog`/`channel`/`redirect`/
 * `wysiwyg` still are) and whose toggle actually round-trips through `GET`/`PUT sites/:siteId` the
 * same way `asciidoc`/`markdown`/`wysiwyg` already do — a row present only in `state.config`'s
 * initial value but missing from `load()`/`save()` would silently reset to off on every page visit
 * and never actually reach the server.
 */
async function mountPage(siteId = 'site-1') {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = siteId
  const siteStore = useSiteStore()

  // -> useSiteAdminAccess('site:editors') needs a real route (for its `siteid` param) and a
  //    permission that satisfies GLOBAL_FALLBACKS['site:editors'], so this mount neither warns on a
  //    missing router injection nor redirects away mid-test.
  const userStore = useUserStore()
  userStore.permissions = ['manage:sites']

  const router = await createTestRouter(['/_admin/:siteid/editors'], '/_admin/site-1/editors')

  const i18n = createTestI18n()

  const wrapper = mount(AdminEditors, {
    global: { plugins: [router, i18n] }
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
    const { wrapper } = await mountPage()
    await flushPromises()

    expect(wrapper.text()).toContain('admin.editors.asciidocName')
    expect(wrapper.text()).toContain('admin.editors.asciidocDescription')
    const asciidocEditor = wrapper.vm.editors.find((e) => e.id === 'asciidoc')
    expect(asciidocEditor.isDisabled).toBeFalsy()
  })

  /**
   * Regression coverage for OpenProject #988: `asciidoc`'s row flipped `useRendering` on when the
   * real AsciiDoc-to-HTML pipeline (`renderers/asciidoc.js`) landed -- before that it was `false`
   * because there was nothing to render with. `useRendering` is what shows the "uses the rendering
   * pipeline" caption on the row (see the template just above `editors` in `AdminEditors.vue`), so a
   * regression here would silently misrepresent AsciiDoc as still raw-source-only again.
   */
  it('flags the asciidoc row as using the rendering pipeline (OpenProject #988)', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ editors: {} }) })
    const { wrapper } = await mountPage()
    await flushPromises()

    const asciidocEditor = wrapper.vm.editors.find((e) => e.id === 'asciidoc')
    expect(asciidocEditor.useRendering).toBe(true)
    expect(wrapper.text()).toContain('admin.editors.useRenderingPipeline')
  })

  it('load()/save() round-trip editors.asciidoc.isActive through the site config', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ editors: { asciidoc: { isActive: true } } })
    })
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    const { wrapper, adminStore, siteStore } = await mountPage()
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
    const { wrapper } = await mountPage()
    await flushPromises()

    expect(wrapper.text()).toContain('admin.editors.codeName')
    const toggle = wrapper.find('.w-toggle')
    expect(toggle.exists()).toBe(true)
  })

  it('load() reads editors.code.isActive from the site config', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ editors: { code: { isActive: true } } })
    })
    const { wrapper } = await mountPage()
    await flushPromises()

    expect(wrapper.vm.state.config.code).toBe(true)
  })

  it('save() sends editors.code.isActive in the PUT body', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ editors: { code: { isActive: true } } })
    })
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    const { wrapper, adminStore, siteStore } = await mountPage()
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
    const { wrapper } = await mountPage()
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

/**
 * OpenProject #1736: `onMounted` used to call `loading.show()` unconditionally, before the
 * `if (adminStore.currentSiteId)` test that gates the `load()` call which would hide it again. On a
 * zero-site instance (`currentSiteId` null) that left the full-screen overlay stuck on forever, with
 * nothing in the UI explaining why. `loading.show()` must now be inside that branch.
 */
describe('AdminEditors: loading overlay on mount (OpenProject #1736)', () => {
  it('does not show the loading overlay when adminStore.currentSiteId is null', async () => {
    loading.show.mockClear()
    await mountPage(null)
    await flushPromises()

    expect(loading.show).not.toHaveBeenCalled()
  })

  it('does show the loading overlay when adminStore.currentSiteId is set', async () => {
    loading.show.mockClear()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ editors: {} }) })
    await mountPage('site-1')
    await flushPromises()

    expect(loading.show).toHaveBeenCalled()
  })
})
