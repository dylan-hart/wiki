import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useUserStore } from './user.js'

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
