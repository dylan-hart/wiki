import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import PageDeleteDialog from './PageDeleteDialog.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

const MESSAGES = {
  'pageDeleteDialog.title': 'Delete Page',
  'pageDeleteDialog.confirm': 'Are you sure you want to delete {name}?',
  'pageDeleteDialog.pageId': 'Page ID: {id}',
  'pageDeleteDialog.deleteSuccess': 'Page deleted successfully.',
  'common.actions.cancel': 'Cancel',
  'common.actions.delete': 'Delete'
}

async function mountDialog({ siteId = 'site-1', currentNavigationId = 'nav-1' } = {}) {
  setActivePinia(createPinia())

  const siteStore = useSiteStore()
  siteStore.id = siteId

  const pageStore = usePageStore()
  pageStore.navigationId = currentNavigationId

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: MESSAGES } })
  const wrapper = mount(PageDeleteDialog, {
    props: { pageId: 'page-1', pageName: 'Some Page' },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  // -> `useDialogComponent()` mounts the panel hidden and flips `dialogVisible` true on the tick
  //    after mount (see `composables/dialog.js`), matching `BlockUploadDialog.test.js`'s own pattern.
  await flushPromises()

  return { wrapper, siteStore, pageStore }
}

async function clickDelete(wrapper) {
  const deleteBtn = wrapper.findAll('button').find((b) => b.text().includes('Delete'))
  await deleteBtn.trigger('click')
}

describe('PageDeleteDialog', () => {
  it('DELETEs sites/:siteId/pages/:pageId and confirms ok', async () => {
    const { wrapper } = await mountDialog()
    API_CLIENT.delete.mockReturnValueOnce({})

    await clickDelete(wrapper)
    await flushPromises()

    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/pages/page-1')
    expect(wrapper.emitted('ok')).toBeTruthy()
  })

  /**
   * OpenProject #1012: a deleted page drops out of whatever `auto`/`mixed` menu generated from it,
   * and any per-page nav override it held is cleaned up server-side
   * (`navigation.deleteNavForEntries`) -- neither is visible to an already-open tab without this.
   * Force-refetches whatever menu THIS tab's currently viewed page resolves to
   * (`pageStore.navigationId`), even though the cache check `fetchNavigation()` applies would
   * otherwise skip a refetch for an id already cached under the same value.
   */
  it('force-refetches the sidebar nav after a successful delete, past the "already cached" gate', async () => {
    const { wrapper, siteStore } = await mountDialog({ currentNavigationId: 'nav-1' })
    siteStore.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'stale' }] } })

    API_CLIENT.delete.mockReturnValueOnce({})
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ mode: 'static', items: [{ id: 'fresh' }] })
    })

    await clickDelete(wrapper)
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(siteStore.nav.items).toEqual([{ id: 'fresh' }])
  })

  it('does not touch the sidebar nav (or confirm ok) when the delete itself fails', async () => {
    const { wrapper, siteStore } = await mountDialog({ currentNavigationId: 'nav-1' })
    siteStore.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'stale' }] } })

    API_CLIENT.delete.mockImplementationOnce(() => {
      throw new Error('not found')
    })

    await clickDelete(wrapper)
    await flushPromises()

    expect(API_CLIENT.get).not.toHaveBeenCalled()
    expect(wrapper.emitted('ok')).toBeFalsy()
  })
})
