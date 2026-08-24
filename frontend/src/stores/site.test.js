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

/**
 * OpenProject #954: `blocksIndex` reaches `siteStore` from `applySiteInfo` the same way
 * `pdfExportAvailable` does above, so `Index.vue`'s block-loading scan can resolve a custom block's
 * `id`/`isCustom` off the store instead of calling the manage:sites-gated `GET /sites/:siteId/blocks`
 * route, which a plain reader is refused.
 */
describe('site store: applySiteInfo() blocksIndex', () => {
  it('adopts blocksIndex from the site payload', () => {
    const store = useSiteStore()
    store.applySiteInfo(
      siteInfoFixture({ blocksIndex: { widget: { id: 'custom-widget-id', isCustom: true } } })
    )

    expect(store.blocksIndex).toEqual({ widget: { id: 'custom-widget-id', isCustom: true } })
  })

  it('defaults to an empty object when the payload omits it', () => {
    const store = useSiteStore()
    store.applySiteInfo(siteInfoFixture())

    expect(store.blocksIndex).toEqual({})
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

/**
 * OpenProject #1012: `NavSidebar.vue`'s watcher used to gate this call itself
 * (`newValue !== siteStore.nav.currentId`), which meant nothing else in the app could ever force a
 * refetch of a menu it already had cached -- exactly the situation right after an admin nav edit, a
 * nav copy, or a page create/move/delete changes what a cached id's own items now are. The gate now
 * lives here instead, with a `forceRefresh` escape hatch for every same-tab invalidation caller.
 */
describe('site store: fetchNavigation()', () => {
  it('fetches and caches the menu for a not-yet-seen id', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([{ id: 'item-1' }])
    })

    await store.fetchNavigation('nav-1')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(store.nav).toEqual({ currentId: 'nav-1', items: [{ id: 'item-1' }] })
  })

  it('skips the request for an id already cached, unless forceRefresh is passed', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    store.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'stale' }] } })

    await store.fetchNavigation('nav-1')
    expect(API_CLIENT.get).not.toHaveBeenCalled()
    expect(store.nav.items).toEqual([{ id: 'stale' }])

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([{ id: 'fresh' }])
    })
    await store.fetchNavigation('nav-1', true)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(store.nav.items).toEqual([{ id: 'fresh' }])
  })

  it('does nothing for a falsy id, forceRefresh or not', async () => {
    const store = useSiteStore()
    store.id = 'site-1'

    await store.fetchNavigation(null)
    await store.fetchNavigation(undefined, true)

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('still refetches a DIFFERENT id even without forceRefresh, same as before', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    store.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'old' }] } })

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve([{ id: 'new' }])
    })
    await store.fetchNavigation('nav-2')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-2')
    expect(store.nav).toEqual({ currentId: 'nav-2', items: [{ id: 'new' }] })
  })
})

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 716: `locales.active`
 * descriptors must carry a real `isRTL` signal so App.vue can set `dir` on `<html>` without a second
 * request to `/_api/locales`.
 */
describe('site store: applySiteInfo() locale direction', () => {
  function baseSiteInfo(overrides = {}) {
    return {
      id: 'site-1',
      hostname: 'example.com',
      title: 'Test Wiki',
      description: '',
      logoText: true,
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
      locales: {
        primary: 'en',
        showMenu: true,
        active: ['en', 'ar', 'he', 'fr']
      },
      theme: {},
      ...overrides
    }
  }

  it('marks RTL script locales (Arabic, Hebrew) as isRTL: true', () => {
    const store = useSiteStore()
    store.applySiteInfo(baseSiteInfo())

    const byCode = Object.fromEntries(store.locales.active.map((l) => [l.code, l]))
    expect(byCode.ar.isRTL).toBe(true)
    expect(byCode.he.isRTL).toBe(true)
  })

  it('marks LTR script locales (English, French) as isRTL: false', () => {
    const store = useSiteStore()
    store.applySiteInfo(baseSiteInfo())

    const byCode = Object.fromEntries(store.locales.active.map((l) => [l.code, l]))
    expect(byCode.en.isRTL).toBe(false)
    expect(byCode.fr.isRTL).toBe(false)
  })

  it('falls back to isRTL: false for a malformed locale code rather than throwing', () => {
    const store = useSiteStore()
    store.applySiteInfo(
      baseSiteInfo({ locales: { primary: 'en', showMenu: true, active: ['not-a-real-tag-🎈'] } })
    )

    expect(store.locales.active[0].isRTL).toBe(false)
  })

  it('defaults the initial state to a single, LTR "en" entry', () => {
    const store = useSiteStore()

    expect(store.locales.active).toEqual([
      { code: 'en', language: 'en', name: 'English', nativeName: 'English', isRTL: false }
    ])
  })

  /**
   * Regression coverage for feature 413, task 727: a real Chromium build (verified live via
   * Playwright, not assumed) implements `Intl.Locale.prototype.getTextInfo()` as a METHOD and has no
   * `.textInfo` getter at all -- the shape every other test in this file exercises, because that is
   * what this sandbox's Node happens to expose instead. Reading `.textInfo.direction` unconditionally
   * (as `describeLocales()` did before this task) throws on a real Chrome `Intl.Locale`, silently
   * caught and defaulted to `isRTL: false` for every locale -- i.e. `dir="rtl"` would never actually
   * apply for a real reader, regardless of everything built on top of it. This locks the fix in by
   * removing the getter Node exposes and simulating the method-only, Chrome-shaped object instead.
   */
  it('still resolves isRTL correctly against a Chrome-shaped Intl.Locale (getTextInfo() method, no .textInfo getter)', () => {
    const RealLocale = Intl.Locale
    class ChromeShapedLocale extends RealLocale {
      get textInfo() {
        throw new TypeError('textInfo is not a function or its return value is not iterable')
      }
      getTextInfo() {
        return { direction: new RealLocale(this.toString()).textInfo.direction }
      }
    }
    Intl.Locale = ChromeShapedLocale
    try {
      const store = useSiteStore()
      store.applySiteInfo(baseSiteInfo())

      const byCode = Object.fromEntries(store.locales.active.map((l) => [l.code, l]))
      expect(byCode.ar.isRTL).toBe(true)
      expect(byCode.he.isRTL).toBe(true)
      expect(byCode.en.isRTL).toBe(false)
    } finally {
      Intl.Locale = RealLocale
    }
  })
})
