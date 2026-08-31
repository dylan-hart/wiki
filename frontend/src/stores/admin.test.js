import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAdminStore } from './admin.js'
import { queue as notifyQueue } from '@/composables/notify'

beforeEach(() => {
  setActivePinia(createPinia())
  notifyQueue.length = 0
})

describe('admin store: versionStatus / isVersionLatest', () => {
  it('is pending before either version has been fetched', () => {
    const store = useAdminStore()

    expect(store.versionStatus).toBe('pending')
    expect(store.isVersionLatest).toBe(false)
  })

  it('is pending while either version is still the n/a placeholder', () => {
    const store = useAdminStore()
    store.info.currentVersion = '3.0.0'
    store.info.latestVersion = 'n/a'

    expect(store.versionStatus).toBe('pending')
  })

  it('is latest when the current version is greater than or equal to the latest', () => {
    const store = useAdminStore()
    store.info.currentVersion = '3.1.0'
    store.info.latestVersion = '3.0.0'

    expect(store.versionStatus).toBe('latest')
    expect(store.isVersionLatest).toBe(true)
  })

  it('is latest when the current version equals the latest', () => {
    const store = useAdminStore()
    store.info.currentVersion = '3.0.0'
    store.info.latestVersion = '3.0.0'

    expect(store.versionStatus).toBe('latest')
  })

  it('is outdated when the current version is behind the latest', () => {
    const store = useAdminStore()
    store.info.currentVersion = '2.9.0'
    store.info.latestVersion = '3.0.0'

    expect(store.versionStatus).toBe('outdated')
    expect(store.isVersionLatest).toBe(false)
  })

  it('compares semver-aware rather than string-aware for a prerelease/patch pair', () => {
    const store = useAdminStore()
    // -> A plain string compare would call '3.0.0-alpha.1' >= '3.0.0-alpha.10' true (lexicographic
    //    '1' > '1' ties, then string compare stops), but semver correctly ranks alpha.10 higher.
    store.info.currentVersion = '3.0.0-alpha.1'
    store.info.latestVersion = '3.0.0-alpha.10'

    expect(store.versionStatus).toBe('outdated')

    // -> Same pair reversed: current genuinely is ahead
    store.info.currentVersion = '3.0.0-alpha.10'
    store.info.latestVersion = '3.0.0-alpha.1'

    expect(store.versionStatus).toBe('latest')

    // -> A patch bump that a naive string compare ('3.0.9' vs '3.0.10') would rank the wrong way
    store.info.currentVersion = '3.0.10'
    store.info.latestVersion = '3.0.9'

    expect(store.versionStatus).toBe('latest')
  })
})

describe('admin store: fetchSites()', () => {
  it('resolves an empty site list without throwing, and leaves currentSiteId null', async () => {
    const store = useAdminStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })

    await expect(store.fetchSites()).resolves.toBeUndefined()

    expect(store.sites).toEqual([])
    expect(store.currentSiteId).toBeNull()
  })

  it('defaults currentSiteId to the first site when one is unset', async () => {
    const store = useAdminStore()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([{ id: 'site-a' }, { id: 'site-b' }])
    })

    await store.fetchSites()

    expect(store.currentSiteId).toBe('site-a')
  })

  it('leaves an already-set currentSiteId untouched', async () => {
    const store = useAdminStore()
    store.currentSiteId = 'site-b'
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([{ id: 'site-a' }])
    })

    await store.fetchSites()

    expect(store.currentSiteId).toBe('site-b')
  })
})

/**
 * OpenProject #1732: none of adminStore's four fetch actions had a try/catch, so a rejection --
 * a 401 on an expired session, a 5xx -- propagated out of the action instead of being handled. In
 * AdminLayout.vue's onMounted, that meant a rejected `fetchSites()` skipped the subsequent
 * `fetchInfo()` call entirely (leaving the dashboard's version/counter fields silently at "n/a"
 * with nothing explaining why), and the two un-awaited calls (`fetchLocales`,
 * `fetchClassificationLevels`) produced unhandled promise rejections with no listener anywhere in
 * the app to catch them.
 *
 * Each action now wraps its body in a try/catch that notifies and leaves its slice at the default
 * from the store's `state()` initializer, rather than rejecting.
 */
describe('admin store: fetch actions error path', () => {
  describe('fetchLocales()', () => {
    it('leaves locales at the default and notifies on a rejecting request', async () => {
      const store = useAdminStore()
      API_CLIENT.get.mockImplementationOnce(() => {
        throw new Error('network down')
      })

      await expect(store.fetchLocales()).resolves.toBeUndefined()

      expect(store.locales).toEqual([{ code: 'en', name: 'English' }])
      expect(notifyQueue.at(-1)).toMatchObject({
        type: 'negative',
        message: 'Failed to load locales.'
      })
    })

    it('still updates locales on success', async () => {
      const store = useAdminStore()
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve([{ code: 'fr', name: 'French', nativeName: 'Français' }])
      })

      await store.fetchLocales()

      expect(store.locales).toEqual([{ code: 'fr', name: 'French', nativeName: 'Français' }])
      expect(notifyQueue).toHaveLength(0)
    })
  })

  describe('fetchInfo()', () => {
    it('leaves info at the default and notifies on a rejecting request', async () => {
      const store = useAdminStore()
      API_CLIENT.get.mockImplementationOnce(() => {
        throw new Error('network down')
      })

      await expect(store.fetchInfo()).resolves.toBeUndefined()

      expect(store.info.currentVersion).toBe('n/a')
      expect(store.info.latestVersion).toBe('n/a')
      expect(store.info.usersTotal).toBe(0)
      expect(notifyQueue.at(-1)).toMatchObject({
        type: 'negative',
        message: 'Failed to load system info.'
      })
    })
  })

  describe('fetchSites()', () => {
    it('leaves sites/currentSiteId at the default and notifies on a rejecting request', async () => {
      const store = useAdminStore()
      API_CLIENT.get.mockImplementationOnce(() => {
        throw new Error('unauthorized')
      })

      await expect(store.fetchSites()).resolves.toBeUndefined()

      expect(store.sites).toEqual([])
      expect(store.currentSiteId).toBeNull()
      expect(notifyQueue.at(-1)).toMatchObject({
        type: 'negative',
        message: 'Failed to load sites.'
      })
    })

    it('does not throw even when a rejected fetch would otherwise block a caller awaiting it', async () => {
      const store = useAdminStore()
      API_CLIENT.get.mockImplementationOnce(() => {
        throw new Error('unauthorized')
      })

      // -> AdminLayout.vue's onMounted awaits fetchSites() bare, then goes on to call fetchInfo();
      //    that only happens if this await resolves instead of rejecting.
      await store.fetchSites()
      API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ usersTotal: 3 }) })
      await store.fetchInfo()

      expect(store.info.usersTotal).toBe(3)
    })
  })

  describe('fetchClassificationLevels()', () => {
    it('leaves classificationLevels at the default and notifies on a rejecting request', async () => {
      const store = useAdminStore()
      API_CLIENT.get.mockImplementationOnce(() => {
        throw new Error('network down')
      })

      await expect(store.fetchClassificationLevels()).resolves.toBeUndefined()

      expect(store.classificationLevels).toEqual([])
      expect(notifyQueue.at(-1)).toMatchObject({
        type: 'negative',
        message: 'Failed to load classification levels.'
      })
    })
  })
})
