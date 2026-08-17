import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useUserStore } from './user.js'
import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('user store: can()', () => {
  it('grants a permission held globally, or granted for the current page', () => {
    const store = useUserStore()
    store.permissions = ['manage:users']
    store.pagePermissions = ['write:pages']

    expect(store.can('manage:users')).toBe(true)
    expect(store.can('write:pages')).toBe(true)
    expect(store.can('delete:pages')).toBe(false)
  })

  it('treats manage:system as a wildcard over everything', () => {
    const store = useUserStore()
    store.permissions = ['manage:system']

    expect(store.can('anything:at-all')).toBe(true)
  })
})

describe('user store: applyProfile() / setToGuest()', () => {
  it('falls back to the guest identity when the session response is unauthenticated', () => {
    const store = useUserStore()
    store.applyProfile({ authenticated: false })

    expect(store.authenticated).toBe(false)
    expect(store.id).toBe('10000000-0000-4000-8000-000000000001')
    expect(store.profileLoaded).toBe(true)
  })

  it('adopts the responding user’s id and permissions when authenticated', () => {
    const store = useUserStore()
    store.applyProfile({
      authenticated: true,
      id: 'abc-123',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      permissions: ['write:pages']
    })

    expect(store.authenticated).toBe(true)
    expect(store.id).toBe('abc-123')
    expect(store.name).toBe('Ada Lovelace')
    expect(store.permissions).toEqual(['write:pages'])
  })

  it('clears page permissions on setToGuest, so a stale edit button cannot survive a logout', () => {
    const store = useUserStore()
    store.applyProfile({ authenticated: true, id: 'abc-123', permissions: ['write:pages'] })
    store.pagePermissions = ['write:pages']

    store.setToGuest()

    expect(store.authenticated).toBe(false)
    expect(store.pagePermissions).toEqual([])
    expect(store.permissions).toEqual([])
  })
})

describe('user store: logout()', () => {
  it('posts to the site logout endpoint, resets to guest, and emits logout on EVENT_BUS', async () => {
    const store = useUserStore()
    store.applyProfile({ authenticated: true, id: 'abc-123', permissions: ['manage:users'] })

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ redirect: '/goodbye' })
    })
    const received = []
    EVENT_BUS.on('logout', (payload) => received.push(payload))

    await store.logout()

    expect(API_CLIENT.post).toHaveBeenCalledWith(expect.stringContaining('/auth/logout'))
    expect(store.authenticated).toBe(false)
    expect(received).toEqual([{ redirect: '/goodbye' }])
  })

  it('still resets to guest and emits logout when the request itself fails', async () => {
    const store = useUserStore()
    store.applyProfile({ authenticated: true, id: 'abc-123', permissions: [] })

    API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('network down')
    })
    const received = []
    EVENT_BUS.on('logout', (payload) => received.push(payload))

    await store.logout()

    expect(store.authenticated).toBe(false)
    // -> No response to read a redirect from: falls back to the app root rather than throwing
    expect(received).toEqual([{ redirect: '/' }])
  })

  /*
    Task 468 (feature 362): `NavSidebar.vue`'s watcher only refetches the sidebar menu when the page
    it lands on carries a DIFFERENT `navigationId` than the one it just left -- true most of the time,
    but not when App.vue's `logout` handler routes the reader to a redirect target that happens to
    share the same `navigationId` as the page they were just reading (the site's default menu is the
    common case). The watcher then never fires, and the sidebar built while authenticated -- including
    any `visibilityGroups`-restricted item this reader could see a moment ago -- stays on screen after
    the session has ended. `logout()` forces the refetch itself, unconditionally, rather than relying
    on the watcher's own diffing.
  */
  it('forces a navigation refetch against the now-anonymous session, regardless of whether the destination shares the same navigationId', async () => {
    const store = useUserStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    // -> The sidebar the reader was looking at when they logged out
    siteStore.nav.currentId = 'nav-1'
    siteStore.nav.items = [
      { id: 'restricted', type: 'link', label: 'Restricted', target: '/secret' }
    ]
    store.applyProfile({ authenticated: true, id: 'abc-123', permissions: [] })

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ redirect: '/some-page' })
    })
    // -> The re-fetched menu, now built against the guest session: the restricted item is gone
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([{ id: 'public', type: 'link', label: 'Public', target: '/' }])
    })

    await store.logout()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(siteStore.nav.items).toEqual([
      { id: 'public', type: 'link', label: 'Public', target: '/' }
    ])
  })

  it('does not attempt a navigation refetch when no sidebar menu was ever loaded', async () => {
    const store = useUserStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    siteStore.nav.currentId = null
    store.applyProfile({ authenticated: true, id: 'abc-123', permissions: [] })

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ redirect: '/' })
    })

    await store.logout()

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })
})

describe('user store: formatDate()', () => {
  it('renders an ISO instant string in the stored dateFormat and timezone', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timezone = 'UTC'

    expect(store.formatDate('2026-03-04T12:00:00Z')).toBe('2026-03-04')
  })

  it('returns an empty string for a nullish date rather than throwing', () => {
    const store = useUserStore()

    expect(store.formatDate(null)).toBe('')
  })
})
