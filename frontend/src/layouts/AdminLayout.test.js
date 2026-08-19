import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminLayout from './AdminLayout.vue'
import StatusLight from '@/components/StatusLight.vue'
import { useAdminStore } from '@/stores/admin'
import { useFlagsStore } from '@/stores/flags'
import { useUserStore } from '@/stores/user'

/*
  `stores/common.js` reads `localStorage.getItem('locale')` at store-creation time. Node 26 (this
  repo's engine requirement) ships an experimental global `localStorage` that shadows happy-dom's own
  implementation in a way that leaves `.getItem` missing -- nothing under test actually cares about a
  persisted locale, so a minimal stub sidesteps the collision rather than fighting over which
  `localStorage` wins. `AdminLayout` pulls in `commonStore` unconditionally, so any mount needs this.
*/
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  })
})

describe('AdminLayout sidebar nav', () => {
  /**
   * Regression coverage for Task 614 (Feature 394, "Admin comments management UI rebuild"): the
   * sidebar Comments link used to be permanently `disabled` and only ever rendered behind
   * `flagsStore.experimental`, alongside Analytics. Both of those gates are now gone -- the link is a
   * normal, always-visible, clickable admin nav entry, matching General/Approvals.
   */
  async function mountLayout({ experimental }) {
    setActivePinia(createPinia())

    const userStore = useUserStore()
    userStore.permissions = ['access:admin', 'manage:sites']

    const flagsStore = useFlagsStore()
    flagsStore.experimental = experimental

    // -> Avoids the pre-existing `this.sites[0].id` crash in `adminStore.fetchSites()` (called from
    //    `onMounted`) when the stubbed API_CLIENT response is empty by default. The
    //    `userPermissions` branch avoids a similar crash in `userStore.fetchSitePermissions()`,
    //    triggered by AdminLayout.vue's watcher on `adminStore.currentSiteId` once `fetchSites()`
    //    resolves — `sitePermissions.includes()` needs an array, not the default `undefined`.
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites') {
        return { json: () => Promise.resolve([{ id: 'site1', title: 'Site 1' }]) }
      }
      if (typeof url === 'string' && url.endsWith('/userPermissions')) {
        return { json: () => Promise.resolve([]) }
      }
      return { json: () => Promise.resolve(undefined) }
    })

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/_admin/:siteid/general', component: { template: '<div />' } }]
    })
    router.push('/_admin/site1/general')
    await router.isReady()

    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

    const wrapper = mount(AdminLayout, {
      global: { plugins: [router, i18n], components: { StatusLight } }
    })
    await flushPromises()

    return wrapper
  }

  function findItemByIcon(wrapper, iconName) {
    return wrapper.findAll('.w-item').find((item) => item.find(`[data-icon="${iconName}"]`).exists())
  }

  it('shows the Comments link enabled, independent of the experimental flag', async () => {
    const wrapper = await mountLayout({ experimental: false })

    const commentsItem = findItemByIcon(wrapper, 'img:/_assets/icons/fluent-comments.svg')

    expect(commentsItem).toBeDefined()
    expect(commentsItem.attributes('aria-disabled')).toBeUndefined()
    // -> A non-disabled `to` item renders as a `router-link` -> `<a>`, with the real target href.
    expect(commentsItem.element.tagName).toBe('A')
  })

  it('shows the Analytics link enabled, independent of the experimental flag', async () => {
    const wrapper = await mountLayout({ experimental: false })

    const analyticsItem = findItemByIcon(wrapper, 'img:/_assets/icons/fluent-bar-chart.svg')

    expect(analyticsItem).toBeDefined()
    expect(analyticsItem.attributes('aria-disabled')).toBeUndefined()
    expect(analyticsItem.element.tagName).toBe('A')
  })

  it('keeps the Comments link visible when the experimental flag is on too', async () => {
    const wrapper = await mountLayout({ experimental: true })

    const commentsItem = findItemByIcon(wrapper, 'img:/_assets/icons/fluent-comments.svg')

    expect(commentsItem).toBeDefined()
    expect(commentsItem.attributes('aria-disabled')).toBeUndefined()
  })
})

describe('AdminLayout Navigation nav-tree entry', () => {
  /**
   * Regression test for the Navigation nav-tree entry's gating (Feature 358, Task 434): it used to be
   * wrapped in `flagsStore.experimental &&` and carry a `disabled` attribute, back when the screen
   * behind it (`AdminNavigation.vue`) was a dead stub. Both are gone now that the screen is real — the
   * entry should behave exactly like every other admin nav-tree item, gated on the permission check
   * alone, regardless of the experimental flag.
   */
  async function mountLayout({ permissions = [], experimental = false } = {}) {
    setActivePinia(createPinia())

    const userStore = useUserStore()
    userStore.permissions = permissions

    const flagsStore = useFlagsStore()
    flagsStore.$patch({ loaded: true, experimental })

    const adminStore = useAdminStore()
    adminStore.currentSiteId = 'site-1'

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
    })
    router.push('/_admin/site-1/navigation')
    await router.isReady()

    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

    return mount(AdminLayout, {
      global: {
        plugins: [router, i18n]
      }
    })
  }

  function findNavigationLink(wrapper) {
    return wrapper.find('a[href="/_admin/site-1/navigation"]')
  }

  it('shows the entry, not disabled, when the user has manage:navigation', async () => {
    const wrapper = await mountLayout({ permissions: ['manage:navigation'], experimental: false })

    const link = findNavigationLink(wrapper)

    expect(link.exists()).toBe(true)
    expect(link.attributes('aria-disabled')).toBeUndefined()
  })

  it('hides the entry for manage:sites alone -- the backend has never accepted it for navigation', async () => {
    const wrapper = await mountLayout({ permissions: ['manage:sites'], experimental: false })

    expect(findNavigationLink(wrapper).exists()).toBe(false)
  })

  it('shows the entry for a delegated site:navigation grant on the current site, without manage:navigation', async () => {
    const wrapper = await mountLayout({ permissions: [], experimental: false })
    const userStore = useUserStore()
    userStore.sitePermissions = ['site:navigation']
    userStore.sitePermissionsSiteId = 'site-1'
    await wrapper.vm.$nextTick()

    expect(findNavigationLink(wrapper).exists()).toBe(true)
  })

  it('hides the entry when the user has neither manage:sites nor manage:navigation', async () => {
    const wrapper = await mountLayout({ permissions: [], experimental: true })

    expect(findNavigationLink(wrapper).exists()).toBe(false)
  })
})

/**
 * Regression guard for the AdminSsl.vue removal (Task 599, Feature 388).
 *
 * `AdminSsl.vue` was unrouted dead code: a pre-migration Options-API/Pug page wired to
 * `$apollo.mutate` calls (`system.setHTTPSRedirection`, `system.renewHTTPSCertificate`) that have no
 * backend implementation, reachable only through a `disabled` nav item this file rendered behind
 * `flagsStore.experimental` -- `frontend/src/router/routes.js` never defined an `ssl` route, so the
 * link never resolved to anything even with the flag on.
 *
 * 3.0's TLS posture is termination at a reverse proxy/ingress (see the `trustProxy` setting in
 * `AdminSecurity.vue` and the Docker/Helm assets under `dev/`), not in-app certificate management --
 * so the page, its nav entry, and its locale strings were deleted outright rather than rebuilt, per
 * this repo's CLAUDE.md ("change the shape, change the callers, and delete the old path"). These
 * assertions exist to keep that dead surface from quietly growing back.
 */
describe('AdminLayout SSL dead-code removal', () => {
  const adminLayoutPath = join(import.meta.dirname, 'AdminLayout.vue')
  const adminSslPagePath = join(import.meta.dirname, '../pages/AdminSsl.vue')
  const sslIconPath = join(import.meta.dirname, '../../public/_assets/icons/fluent-security-ssl.svg')
  const localesPath = join(import.meta.dirname, '../../../backend/locales/en.json')

  it('does not reference the removed /_admin/ssl route or AdminSsl.vue', () => {
    const source = readFileSync(adminLayoutPath, 'utf-8')
    expect(source).not.toContain('/_admin/ssl')
    expect(source).not.toContain('admin.ssl.')
    expect(source).not.toContain('fluent-security-ssl')
  })

  it('no longer ships frontend/src/pages/AdminSsl.vue', () => {
    expect(existsSync(adminSslPagePath)).toBe(false)
  })

  it('no longer ships the now-unreferenced SSL nav icon asset', () => {
    expect(existsSync(sslIconPath)).toBe(false)
  })

  it('no longer carries any admin.ssl.* locale keys', () => {
    const locales = JSON.parse(readFileSync(localesPath, 'utf-8'))
    const sslKeys = Object.keys(locales).filter((key) => key.startsWith('admin.ssl.'))
    expect(sslKeys).toEqual([])
  })
})
