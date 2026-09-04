import { describe, expect, it } from 'vitest'

import MainLayout from './MainLayout.vue'
import routes from '@/router/routes.js'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

const LAYOUT_STUBS = {
  teleport: true,
  'router-view': true,
  HeaderNav: true,
  NavSidebar: true,
  MainOverlayDialog: true
}

/**
 * Regression coverage for OpenProject #2512: loading or SPA-navigating to a non-content-page route
 * (the knowledge graph chief among them) used to collapse the sidebar to its 56px mini rail, because
 * `isSidebarMini`'s `!pageStore.navigationId` fallback -- meant to catch a CONTENT page that hasn't
 * told the store which menu it belongs to yet -- fired on every OTHER route too, since those never
 * call `pageStore.pageLoad()` (the only thing that ever sets `navigationId`) and so just see whatever
 * a previously-viewed content page left there: `null` on a fresh store, or a stale id carried over
 * from an earlier SPA navigation. Fixed by scoping that fallback to `route.meta.contentPage`
 * (`router/routes.js`), so a route with no navigation opinion of its own gets the normal expanded
 * sidebar instead.
 *
 * Real routes from the app's own route table drive each case (not hand-rolled stub routes), since the
 * bug is precisely about which of those routes carry `meta.contentPage` -- a stub route list would
 * hide a regression where a route's flag drifts from what this test expects.
 */
async function mountLayout(path, options = {}) {
  const router = await createTestRouter(routes, path)

  return mountWithApp(MainLayout, { router, stubs: LAYOUT_STUBS, ...options })
}

describe('MainLayout sidebar-mini fallback (OpenProject #2512)', () => {
  it('stays mini on a content page route with no navigationId yet (fresh store / direct load)', async () => {
    const { wrapper } = await mountLayout('/some/wiki/page')

    expect(wrapper.find('.sidebar-mini').exists()).toBe(true)
  })

  it('expands once the content page route has a navigationId', async () => {
    const { wrapper, pageStore } = await mountLayout('/some/wiki/page')

    pageStore.navigationId = 'nav-1'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
  })

  it('does NOT go mini on a non-content route with no navigationId (the graph, direct load)', async () => {
    const { wrapper } = await mountLayout('/_graph')

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
  })

  it('does NOT go mini on a non-content route carrying a STALE navigationId left by a prior page', async () => {
    const router = await createTestRouter(routes, '/some/wiki/page')
    const { wrapper } = mountWithApp(MainLayout, {
      router,
      stubs: LAYOUT_STUBS,
      stores: { page: { navigationId: 'stale-nav-from-last-page' } }
    })

    await router.push('/_graph')
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
  })

  it('other non-content routes (tags browse) also skip the fallback', async () => {
    const { wrapper } = await mountLayout('/_tags')

    expect(wrapper.find('.sidebar-mini').exists()).toBe(false)
  })

  it('still goes mini on a content page whose author set navigationMode to hide, regardless of navigationId', async () => {
    const { wrapper, pageStore } = await mountLayout('/some/wiki/page')

    pageStore.$patch({ navigationId: 'nav-1', navigationMode: 'hide' })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-mini').exists()).toBe(true)
  })
})
