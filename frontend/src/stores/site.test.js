import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * Task 500: `pdfExportAvailable` reaches `siteStore` from `applySiteInfo`, which both `loadSite`
 * (`sites/:siteIdorHostname`) and the boot flow (`bootstrap`, which hands over site+flags+session
 * together) call with the same site payload shape — so the export UI can read
 * `siteStore.pdfExportAvailable` regardless of which of the two loaded it.
 */
function siteInfoFixture(overrides = {}) {
  return {
    id: 'site-1',
    hostname: 'wiki.example.com',
    title: 'My Wiki',
    description: '',
    logoText: true,
    pageExtensions: ['md'],
    company: '',
    contentLicense: '',
    footerExtra: '',
    features: {},
    auth: {},
    editors: {
      asciidoc: { isActive: false },
      code: { isActive: false },
      markdown: { isActive: true },
      wysiwyg: { isActive: false }
    },
    locales: { primary: 'en', active: ['en'] },
    theme: {},
    ...overrides
  }
}

describe('site store: applySiteInfo() pdfExportAvailable', () => {
  it('adopts pdfExportAvailable: true from the site payload', () => {
    const store = useSiteStore()
    store.applySiteInfo(siteInfoFixture({ pdfExportAvailable: true }))

    expect(store.pdfExportAvailable).toBe(true)
  })

  it('adopts pdfExportAvailable: false from the site payload', () => {
    const store = useSiteStore()
    store.applySiteInfo(siteInfoFixture({ pdfExportAvailable: false }))

    expect(store.pdfExportAvailable).toBe(false)
  })

  it('defaults to false when the payload omits it', () => {
    const store = useSiteStore()
    store.applySiteInfo(siteInfoFixture())

    expect(store.pdfExportAvailable).toBe(false)
  })
})

describe('site store: features.comments default', () => {
  it('defaults to false, so PageComments has something real to gate on before the backend sends it', () => {
    const store = useSiteStore()

    expect(store.features.comments).toBe(false)
  })

  it('applySiteInfo() lets a backend-sent features.comments override the default', () => {
    const store = useSiteStore()
    store.applySiteInfo({
      pageExtensions: [],
      features: { comments: true },
      auth: {},
      editors: {
        asciidoc: { isActive: false },
        code: { isActive: false },
        markdown: { isActive: true },
        wysiwyg: { isActive: false }
      },
      locales: { active: [] }
    })

    expect(store.features.comments).toBe(true)
  })

  it('applySiteInfo() without a comments key keeps the default rather than going undefined', () => {
    const store = useSiteStore()
    store.applySiteInfo({
      pageExtensions: [],
      features: { ratingsMode: 'stars' },
      auth: {},
      editors: {
        asciidoc: { isActive: false },
        code: { isActive: false },
        markdown: { isActive: true },
        wysiwyg: { isActive: false }
      },
      locales: { active: [] }
    })

    expect(store.features.comments).toBe(false)
    expect(store.features.ratingsMode).toBe('stars')
  })
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
