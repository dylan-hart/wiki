import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { usePageStore } from './page.js'
import { useSiteStore } from './site.js'

function stubPageResponse(overrides = {}) {
  return {
    json: vi.fn().mockResolvedValue({
      id: 'page-1',
      relations: [],
      tocDepth: { min: 1, max: 2 },
      ...overrides
    })
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('page store: pageLoad()', () => {
  it('sends no locale search param when none is given', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse())

    const pageStore = usePageStore()
    await pageStore.pageLoad({ path: '/some/page' })

    const [, opts] = API_CLIENT.get.mock.calls[0]
    expect(opts.searchParams).toEqual({ withContent: false })
  })

  it('passes the resolved locale as the locale search param', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse())

    const pageStore = usePageStore()
    await pageStore.pageLoad({ path: '/some/page', locale: 'fr' })

    const [, opts] = API_CLIENT.get.mock.calls[0]
    expect(opts.searchParams).toEqual({ withContent: false, locale: 'fr' })
  })
})
