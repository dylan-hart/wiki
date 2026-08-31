import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAdminStore } from './admin.js'
import { queue as notifyQueue } from '@/composables/notify'

beforeEach(() => {
  setActivePinia(createPinia())
  notifyQueue.length = 0
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
