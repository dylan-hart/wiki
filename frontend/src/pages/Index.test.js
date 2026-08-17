import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import Index from './Index.vue'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * Regression test for task 515's entry point out of the missing-page screen.
 *
 * A path that 404s is also what a deleted page's own address does once nothing is left to answer for
 * it, so this is "wherever a reader currently lands when a page's path no longer resolves" — the
 * landing spot task 515 names as one acceptable place for a lightweight link into the new Recently
 * Deleted admin view. It is gated on TWO permissions rather than shown unconditionally: `read:history`
 * at this exact path is what a row for this path would need to appear on that list at all (see
 * `GET sites/:siteId/pages/deleted`'s per-row `mayOnPage` filter), and the global `access:admin` is
 * what `AdminLayout` itself checks on arrival -- without it the link would only bounce the reader to
 * the unauthorized screen. A group can grant either without the other, so both are asserted here.
 */
async function mountAtMissingPath({ pagePermissions, permissions = [] }) {
  // -> `stores/common.js` reads `localStorage` at store setup. Node's own experimental global
  //    shadows happy-dom's in this sandbox and throws on `.getItem` with no backing file
  //    configured; stubbed locally so this test does not depend on either implementation.
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })

  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'
  siteStore.editors.markdown = false // -> Keeps the screen on the simpler "go back" branch

  const userStore = useUserStore()
  userStore.permissions = permissions

  // -> `pageLoad`'s GET resolves to `undefined` by default (the stub's plain response), which is
  //    exactly what makes it throw ERR_PAGE_NOT_FOUND and take the missing-page path below
  globalThis.API_CLIENT.post.mockReturnValue({
    json: vi.fn().mockResolvedValue(pagePermissions)
  })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: Index }]
  })

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(Index, {
    global: {
      plugins: [router, i18n],
      stubs: {
        PageHeader: true,
        PageActionsCol: true,
        PageRedirect: true,
        PageTags: true,
        PageToc: true,
        FooterNav: true,
        SideDialog: true
      }
    }
  })

  router.push('/deleted/page')
  await router.isReady()
  await flushPromises()

  return { wrapper, userStore }
}

describe('Index missing-page screen: Recently Deleted entry link', () => {
  it('shows the link when both access:admin and read:history at this path are granted', async () => {
    const { wrapper } = await mountAtMissingPath({
      pagePermissions: ['read:history'],
      permissions: ['access:admin']
    })

    const entry = wrapper.find('[href="/_admin/site-1/pages/deleted"]')
    expect(entry.exists()).toBe(true)
  })

  it('hides the link when this path grants no read:history, even with access:admin', async () => {
    const { wrapper } = await mountAtMissingPath({
      pagePermissions: [],
      permissions: ['access:admin']
    })

    const entry = wrapper.find('[href="/_admin/site-1/pages/deleted"]')
    expect(entry.exists()).toBe(false)
  })

  it('hides the link when there is no access:admin, even with read:history here', async () => {
    const { wrapper } = await mountAtMissingPath({
      pagePermissions: ['read:history'],
      permissions: []
    })

    const entry = wrapper.find('[href="/_admin/site-1/pages/deleted"]')
    expect(entry.exists()).toBe(false)
  })
})
