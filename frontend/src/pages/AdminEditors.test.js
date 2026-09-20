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

async function mountPage(siteId = 'site-1') {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = siteId
  const siteStore = useSiteStore()

  // -> `useSiteAdminAccess('site:editors')` needs a real route for its `siteid` param and a
  //    permission that satisfies it, or the mount warns and redirects away mid-test.
  const userStore = useUserStore()
  userStore.permissions = ['manage:sites']

  const router = await createTestRouter(['/_admin/:siteid/editors'], '/_admin/site-1/editors')

  const i18n = createTestI18n()

  const wrapper = mount(AdminEditors, {
    global: { plugins: [router, i18n] }
  })

  return { wrapper, adminStore, siteStore }
}

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

  /** `useRendering` is what draws the rendering-pipeline caption on a row. */
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
    expect(siteStore.editors.code).toBe(true)
  })

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

/** With no site to load, an overlay raised on mount would never be lowered again. */
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
