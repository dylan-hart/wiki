import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { usePageStore } from './page.js'
import { useSiteStore } from './site.js'

const PAGE_ID = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  setActivePinia(createPinia())
})

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } })
}

describe('page store: pageById()', () => {
  it('resolves a page id through the by-id page route and hands back its path and locale', async () => {
    const pageStore = usePageStore()
    useSiteStore().id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ id: PAGE_ID, path: 'docs/moved', locale: 'fr' })
    })

    const target = await pageStore.pageById(PAGE_ID)

    expect(API_CLIENT.get).toHaveBeenCalledWith(`sites/site-1/pages/${PAGE_ID}`)
    expect(target.path).toBe('docs/moved')
    expect(target.locale).toBe('fr')
  })

  it('maps a 404 to ERR_PAGE_NOT_FOUND', async () => {
    const pageStore = usePageStore()
    useSiteStore().id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.reject(httpError(404)) })

    await expect(pageStore.pageById(PAGE_ID)).rejects.toThrow('ERR_PAGE_NOT_FOUND')
  })

  it('rethrows a non-404 failure as it came', async () => {
    const pageStore = usePageStore()
    useSiteStore().id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.reject(httpError(403)) })

    await expect(pageStore.pageById(PAGE_ID)).rejects.toThrow('HTTP 403')
  })

  it('treats a response with no id as not found', async () => {
    const pageStore = usePageStore()
    useSiteStore().id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({}) })

    await expect(pageStore.pageById(PAGE_ID)).rejects.toThrow('ERR_PAGE_NOT_FOUND')
  })

  it('refuses a non-uuid without asking the server, which would read a hex string as a path hash', async () => {
    const pageStore = usePageStore()
    useSiteStore().id = 'site-1'

    await expect(pageStore.pageById('abc123')).rejects.toThrow('ERR_PAGE_NOT_FOUND')
    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })
})
