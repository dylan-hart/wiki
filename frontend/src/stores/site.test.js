import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('site store: fetchExtensionsStatus()', () => {
  it('populates extensionsStatus from the endpoint and marks it loaded', async () => {
    const store = useSiteStore()
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ pandoc: true, puppeteer: false })
    })

    await store.fetchExtensionsStatus()

    expect(API_CLIENT.get).toHaveBeenCalledWith('system/extensions/status')
    expect(store.extensionsStatus).toEqual({ pandoc: true, puppeteer: false })
    expect(store.extensionsStatusLoaded).toBe(true)
  })

  it('does not re-fetch once loaded, unless forceRefresh is passed', async () => {
    const store = useSiteStore()
    store.$patch({ extensionsStatus: { pandoc: true }, extensionsStatusLoaded: true })

    await store.fetchExtensionsStatus()
    expect(API_CLIENT.get).not.toHaveBeenCalled()

    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ pandoc: false })
    })
    await store.fetchExtensionsStatus(true)
    expect(API_CLIENT.get).toHaveBeenCalledWith('system/extensions/status')
    expect(store.extensionsStatus).toEqual({ pandoc: false })
  })

  it('swallows a failed request, leaving the item hidden rather than throwing', async () => {
    const store = useSiteStore()
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network down')
    })

    await expect(store.fetchExtensionsStatus()).resolves.toBeUndefined()
    expect(store.extensionsStatus).toEqual({})
    expect(store.extensionsStatusLoaded).toBe(false)
  })
})
