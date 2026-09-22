import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { usePageStore } from './page.js'
import { useSiteStore } from './site.js'
import { useUserStore } from './user.js'
import { stubPageResponse } from './pageStoreFixtures.js'

function setup({ authenticated = true } = {}) {
  setActivePinia(createPinia())
  useSiteStore().id = 'site-1'
  useUserStore().authenticated = authenticated
  return usePageStore()
}

beforeEach(() => {
  setup()
})

describe('page store: pageLoad() records a visit', () => {
  it('PUTs the visit route after a completed reader load by a logged-in user', async () => {
    const pageStore = setup()
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse({ id: 'page-9' }))

    await pageStore.pageLoad({ path: 'a' })
    await Promise.resolve()

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-9/visit')
  })

  it('makes no visit call for a guest', async () => {
    const pageStore = setup({ authenticated: false })
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse({ id: 'page-9' }))

    await pageStore.pageLoad({ path: 'a' })

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('makes no visit call for an editor load', async () => {
    const pageStore = setup()
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse({ id: 'page-9' }))

    await pageStore.pageLoad({ id: 'page-9', withContent: true })

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('makes no visit call for a load that was superseded', async () => {
    const pageStore = setup()
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse({ id: 'page-9' }))

    await pageStore.pageLoad({ path: 'a', isStale: () => true })

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('makes no visit call for a redirect stub', async () => {
    const pageStore = setup()
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse({ id: 'page-9', editor: 'redirect' }))

    await pageStore.pageLoad({ path: 'a' })

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('makes no visit call when the page is missing or forbidden', async () => {
    const pageStore = setup()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.reject(Object.assign(new Error('nope'), { response: { status: 404 } }))
    })
    await expect(pageStore.pageLoad({ path: 'a' })).rejects.toThrow('ERR_PAGE_NOT_FOUND')

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.reject(Object.assign(new Error('nope'), { response: { status: 403 } }))
    })
    await expect(pageStore.pageLoad({ path: 'b' })).rejects.toThrow('ERR_PAGE_UNAUTHORIZED')

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('still resolves, with the page loaded, when the visit call fails', async () => {
    const pageStore = setup()
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse({ id: 'page-9' }))
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.reject(new Error('offline')) })

    await expect(pageStore.pageLoad({ path: 'a' })).resolves.toBeUndefined()

    expect(pageStore.id).toBe('page-9')
  })
})
