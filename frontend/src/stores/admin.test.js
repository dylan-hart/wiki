import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAdminStore } from './admin.js'

beforeEach(() => {
  setActivePinia(createPinia())
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
