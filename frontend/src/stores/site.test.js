import { beforeEach, describe, expect, it } from 'vitest'
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
