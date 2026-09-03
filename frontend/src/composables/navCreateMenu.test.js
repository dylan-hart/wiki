import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { useNavCreateMenu } from './navCreateMenu'
import { closeDialog, openDialogs } from '@/composables/dialog'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * `useNavCreateMenu()` is the shared implementation both `NavSidebarItem.vue` (per-item context
 * menu) and `NavSidebar.vue` (empty-space, locale-root context menu) call rather than each closing
 * over its own copy -- see the composable's own header comment for why. Mounted through a tiny host
 * component the same way `navSidebarDestination.test.js` tests its own composable, so `computed()`
 * has a live component instance to attach to.
 */
async function mountNavCreateMenu() {
  setActivePinia(createPinia())
  let captured
  const Host = defineComponent({
    setup() {
      captured = useNavCreateMenu()
      return () => h('div')
    }
  })
  mount(Host)
  return captured
}

describe('useNavCreateMenu#canUploadAsset', () => {
  it('is true when the viewer holds write:assets', async () => {
    const { canUploadAsset } = await mountNavCreateMenu()
    useUserStore().permissions = ['write:assets']
    expect(canUploadAsset.value).toBe(true)
  })

  it('is true when the viewer holds write:pages instead, with no write:assets', async () => {
    const { canUploadAsset } = await mountNavCreateMenu()
    useUserStore().permissions = ['write:pages']
    expect(canUploadAsset.value).toBe(true)
  })

  it('is false when the viewer holds neither', async () => {
    const { canUploadAsset } = await mountNavCreateMenu()
    useUserStore().permissions = []
    expect(canUploadAsset.value).toBe(false)
  })
})

describe('useNavCreateMenu#openFolderDialog', () => {
  it('opens FolderCreateDialog with the given parentId', async () => {
    const { openFolderDialog } = await mountNavCreateMenu()

    openDialogs.length = 0
    openFolderDialog('folder-1')

    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0].props).toEqual({ parentId: 'folder-1' })
  })

  it('passes a null parentId through unchanged, for the locale-root case', async () => {
    const { openFolderDialog } = await mountNavCreateMenu()

    openDialogs.length = 0
    openFolderDialog(null)

    expect(openDialogs[0].props).toEqual({ parentId: null })
  })

  it('force-refetches the sidebar nav, for the page currently open, once the dialog confirms', async () => {
    const { openFolderDialog } = await mountNavCreateMenu()
    const pageStore = usePageStore()
    const siteStore = useSiteStore()
    pageStore.navigationId = 'nav-42'
    const fetchNavigation = vi.spyOn(siteStore, 'fetchNavigation').mockResolvedValue()

    openDialogs.length = 0
    openFolderDialog('folder-1')
    closeDialog(openDialogs[0].id, true)

    expect(fetchNavigation).toHaveBeenCalledWith('nav-42', true)
  })

  it('does not refetch when the dialog is cancelled', async () => {
    const { openFolderDialog } = await mountNavCreateMenu()
    const siteStore = useSiteStore()
    const fetchNavigation = vi.spyOn(siteStore, 'fetchNavigation').mockResolvedValue()

    openDialogs.length = 0
    openFolderDialog('folder-1')
    closeDialog(openDialogs[0].id, false)

    expect(fetchNavigation).not.toHaveBeenCalled()
  })
})
