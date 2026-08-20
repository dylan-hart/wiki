import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import TreeBrowserDialog from './TreeBrowserDialog.vue'
import { queue as notifyQueue } from '@/composables/notify'
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

/**
 * Regression test for task 810: `save()` used to test the WHOLE path against
 * `/^[a-z0-9-]+$/` -- a pattern with no slash in its character class, meant to validate one
 * path segment at a time (it mirrors the backend's `rePathName` in `models/tree.ts`) -- so any
 * nested path (`docs/setup/install`) was rejected outright. The fix checks each slash-separated
 * segment individually instead. Covered across all three modes the dialog's single shared `save()`
 * serves (`savePage`, `duplicatePage`, `renamePage`), since the same function backs all of them.
 */
describe.each(['savePage', 'duplicatePage', 'renamePage'])(
  'TreeBrowserDialog save() path validation (mode: %s)',
  (mode) => {
    it('accepts a valid nested path', async () => {
      const wrapper = mountDialog({ mode })
      await flushPromises()
      wrapper.vm.state.title = 'Install Guide'
      wrapper.vm.state.path = 'docs/setup/install'
      await wrapper.vm.save()

      expect(wrapper.emitted('ok')).toBeTruthy()
      expect(wrapper.emitted('ok')[0][0]).toMatchObject({ path: 'docs/setup/install' })
    })

    it('rejects a path with an invalid segment (uppercase, spaces, symbols)', async () => {
      notifyQueue.splice(0, notifyQueue.length)
      const wrapper = mountDialog({ mode })
      await flushPromises()
      wrapper.vm.state.title = 'Install Guide'
      wrapper.vm.state.path = 'docs/Setup Folder/inst@ll'
      await wrapper.vm.save()

      expect(wrapper.emitted('ok')).toBeFalsy()
      expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
    })

    it('rejects an empty segment from a stray double slash', async () => {
      notifyQueue.splice(0, notifyQueue.length)
      const wrapper = mountDialog({ mode })
      await flushPromises()
      wrapper.vm.state.title = 'Install Guide'
      wrapper.vm.state.path = 'docs//install'
      await wrapper.vm.save()

      expect(wrapper.emitted('ok')).toBeFalsy()
      expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
    })
  }
)
