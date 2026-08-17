import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import NavEditMenu from './NavEditMenu.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

const MESSAGES = {
  'navEdit.title': 'Edit Navigation',
  'navEdit.editMenuItems': 'Edit Menu Items',
  'navEdit.saveModeSuccess': 'Navigation mode set successfully.',
  'navEdit.menuSourceLabel': 'Menu Source',
  'navEdit.menuSourceStatic': 'Manual',
  'navEdit.menuSourceStaticHint': 'Menu items are entered by hand below.',
  'navEdit.menuSourceAuto': 'Automatic',
  'navEdit.menuSourceAutoHint': 'Menu items are generated automatically.',
  'navEdit.menuSourceMixed': 'Mixed',
  'navEdit.menuSourceMixedHint': 'Generated items are combined with manual ones.',
  'common.actions.cancel': 'Cancel',
  'common.actions.save': 'Save'
}

function mountMenu({ path = '', navigationId = 'nav-1', navigationMode = 'inherit' } = {}) {
  setActivePinia(createPinia())

  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const pageStore = usePageStore()
  pageStore.id = 'page-1'
  pageStore.path = path
  pageStore.navigationId = navigationId
  pageStore.navigationMode = navigationMode

  API_CLIENT.get.mockImplementation((url) => {
    if (url === `sites/site-1/navigation/${navigationId}/mode`) {
      return { json: vi.fn().mockResolvedValue({ mode: 'auto' }) }
    }
    if (url === 'sites/site-1/navigation/pages/page-1/inherited') {
      return { json: vi.fn().mockResolvedValue({ navigationId: 'ancestor-nav' }) }
    }
    return { json: vi.fn().mockResolvedValue({}) }
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: MESSAGES } })
  const wrapper = mount(NavEditMenu, {
    global: { plugins: [i18n] }
  })

  return { wrapper, siteStore, pageStore }
}

describe('NavEditMenu', () => {
  it("loads the resolved menu's source mode on mount and saves it alongside the cascade mode", async () => {
    const { wrapper } = mountMenu()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1/mode')

    API_CLIENT.put.mockReturnValueOnce({
      json: vi
        .fn()
        .mockResolvedValue({ ok: true, navigationMode: 'inherit', navigationId: 'nav-1' })
    })

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('Save'))
    await saveBtn.trigger('click')
    await vi.waitUntil(() => API_CLIENT.put.mock.calls.length >= 1)

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/navigation/pages/page-1', {
      json: { mode: 'inherit', menuMode: 'auto' }
    })
  })

  it('skips loading a source mode when there is no resolved menu (sidebar hidden)', async () => {
    mountMenu({ navigationId: null })
    await flushPromises()

    expect(API_CLIENT.get).not.toHaveBeenCalledWith(expect.stringContaining('/mode'))
  })

  it('passes the loaded menuMode through to the item editor via overlayOpts on "Edit Menu Items"', async () => {
    const { wrapper, siteStore } = mountMenu()
    await flushPromises()

    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('Edit Menu Items'))
    await editBtn.trigger('click')

    expect(siteStore.overlay).toBe('NavEdit')
    expect(siteStore.overlayOpts.menuMode).toBe('auto')
    expect(siteStore.overlayOpts.mode).toBe('inherit')
  })
})
