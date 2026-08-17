import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import TreeBrowserDialog from './TreeBrowserDialog.vue'
import { useSiteStore } from '@/stores/site'

/**
 * Regression test for task 515's `siteId` prop.
 *
 * Every existing call site (`PageHeader`, `PageActionsCol`, `FileManager`, `PageHistoryOverlay`) opens
 * this dialog from the main site view, where `siteStore.id` IS the site being browsed, so it always
 * fetched the tree from there. The admin area's Recently Deleted view (task 515) opens the same dialog
 * for whichever site ITS OWN picker has selected (`adminStore.currentSiteId`), which is not
 * necessarily the site `siteStore` is currently showing — without a way to say which site, the browser
 * would silently list the wrong site's pages and a path picked there would be meaningless once posted
 * back against the admin-selected site.
 */
function mountDialog(props, { viewedSiteId = 'viewed-site' } = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = viewedSiteId

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  globalThis.API_CLIENT.get.mockReturnValue({ json: vi.fn().mockResolvedValue([]) })

  return mount(TreeBrowserDialog, {
    props: { mode: 'duplicatePage', itemTitle: 'A page', itemFileName: 'a-page', ...props },
    global: { plugins: [i18n] }
  })
}

describe('TreeBrowserDialog siteId prop', () => {
  it('browses the site passed as a prop rather than the one currently on screen', async () => {
    mountDialog({ siteId: 'admin-selected-site' }, { viewedSiteId: 'viewed-site' })
    await flushPromises()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith(
      'sites/admin-selected-site/tree',
      expect.anything()
    )
    expect(globalThis.API_CLIENT.get).not.toHaveBeenCalledWith(
      'sites/viewed-site/tree',
      expect.anything()
    )
  })

  it('falls back to the currently viewed site when no siteId prop is given', async () => {
    mountDialog({}, { viewedSiteId: 'viewed-site' })
    await flushPromises()

    expect(globalThis.API_CLIENT.get).toHaveBeenCalledWith(
      'sites/viewed-site/tree',
      expect.anything()
    )
  })
})
