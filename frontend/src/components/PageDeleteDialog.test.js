import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import PageDeleteDialog from './PageDeleteDialog.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { createTestI18n } from '../../test/i18n.js'

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

  const i18n = createTestI18n(MESSAGES)
  const wrapper = mount(PageDeleteDialog, {
    props: { pageId: 'page-1', pageName: 'Some Page' },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  // -> `useDialogComponent()` mounts the panel hidden and flips `dialogVisible` true on the tick
  //    after mount.
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
   * A deleted page drops out of any `auto`/`mixed` menu generated from it, which an already-open
   * tab never sees unless the refetch bypasses `fetchNavigation()`'s "this id is already cached"
   * skip.
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
