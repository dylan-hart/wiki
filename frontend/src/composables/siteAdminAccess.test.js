import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'

import { useUserStore } from '@/stores/user'
import { maySeeSiteSurface, useSiteAdminAccess } from './siteAdminAccess.js'

const mockRoute = { params: {} }
const mockRouter = { replace: vi.fn() }

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => mockRouter
}))

beforeEach(() => {
  setActivePinia(createPinia())
  mockRoute.params = { siteid: 'site-a' }
  mockRouter.replace.mockClear()
})

describe('maySeeSiteSurface()', () => {
  it('grants a surface whose group-wide fallback the caller holds, without touching sitePermissions', () => {
    const userStore = useUserStore()
    userStore.permissions = ['manage:sites']

    expect(maySeeSiteSurface(userStore, 'site:general', 'site-a')).toBe(true)
  })

  it('does NOT grant site:navigation for manage:sites alone, matching canManageNavigation', () => {
    const userStore = useUserStore()
    userStore.permissions = ['manage:sites']

    expect(maySeeSiteSurface(userStore, 'site:navigation', 'site-a')).toBe(false)
  })

  it('grants site:navigation for manage:navigation', () => {
    const userStore = useUserStore()
    userStore.permissions = ['manage:navigation']

    expect(maySeeSiteSurface(userStore, 'site:navigation', 'site-a')).toBe(true)
  })

  it('grants site:theme for the older instance-wide manage:theme, without manage:sites', () => {
    const userStore = useUserStore()
    userStore.permissions = ['manage:theme']

    expect(maySeeSiteSurface(userStore, 'site:theme', 'site-a')).toBe(true)
  })

  it('falls back to the fetched per-site grant when no global permission covers it', () => {
    const userStore = useUserStore()
    userStore.sitePermissions = ['site:general']
    userStore.sitePermissionsSiteId = 'site-a'

    expect(maySeeSiteSurface(userStore, 'site:general', 'site-a')).toBe(true)
    expect(maySeeSiteSurface(userStore, 'site:general', 'site-b')).toBe(false)
  })
})

describe('useSiteAdminAccess()', () => {
  it('never redirects, and never fetches, when a global fallback already covers the permission', async () => {
    const userStore = useUserStore()
    userStore.permissions = ['manage:sites']
    const scope = effectScope()

    scope.run(() => useSiteAdminAccess('site:general'))
    await nextTick()

    expect(mockRouter.replace).not.toHaveBeenCalled()
    expect(API_CLIENT.get).not.toHaveBeenCalled()
    scope.stop()
  })

  it('redirects to /_error/unauthorized once the fetch resolves without the permission', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })
    const scope = effectScope()

    scope.run(() => useSiteAdminAccess('site:theme'))
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-a/userPermissions')
    expect(mockRouter.replace).toHaveBeenCalledWith('/_error/unauthorized')
    scope.stop()
  })

  it('does not redirect once the fetch resolves WITH the permission', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(['site:theme']) })
    const scope = effectScope()

    scope.run(() => useSiteAdminAccess('site:theme'))
    await flushPromises()

    expect(mockRouter.replace).not.toHaveBeenCalled()
    scope.stop()
  })

  it('exposes allowed reactively for a page that wants to gate its own content further', async () => {
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(['site:theme']) })
    const scope = effectScope()

    const { allowed } = scope.run(() => useSiteAdminAccess('site:theme'))
    expect(allowed.value).toBe(false)
    await flushPromises()
    expect(allowed.value).toBe(true)
    scope.stop()
  })
})
