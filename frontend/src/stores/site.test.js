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
 * OpenProject #1922: `docsBase` reaches `siteStore` from `applySiteInfo` the same way
 * `pdfExportAvailable` does above -- but, unlike it, the store holds no hardcoded default of its
 * own. Every in-app "view docs" link is built from this value, so it must always come from the
 * server (`WIKI.config.docsBase`, from `backend/base.yml`) rather than a frontend literal that could
 * drift from it.
 */
describe('site store: applySiteInfo() docsBase', () => {
  it('has no hardcoded default before any site info is applied', () => {
    const store = useSiteStore()

    expect(store.docsBase).toBe('')
  })

  it('adopts docsBase from the site payload', () => {
    const store = useSiteStore()
    store.applySiteInfo(siteInfoFixture({ docsBase: 'https://docs.example.com' }))

    expect(store.docsBase).toBe('https://docs.example.com')
  })
})

/**
 * OpenProject #2527: `navigationId` reaches `siteStore` from `applySiteInfo` the same way `docsBase`
 * does above -- the site's default menu id (`backend/api/sites.ts`'s `buildSitePayload`, via
 * `WIKI.models.navigation.ensureSiteNav`), what `NavSidebar.vue` and `MainLayout.vue` fall back to
 * on a route with no page-inherited `navigationId` of its own.
 */
describe('site store: applySiteInfo() navigationId', () => {
  it('has no hardcoded default before any site info is applied', () => {
    const store = useSiteStore()

    expect(store.navigationId).toBe(null)
  })

  it('adopts navigationId from the site payload', () => {
    const store = useSiteStore()
    store.applySiteInfo(siteInfoFixture({ navigationId: 'site-default-nav-id' }))

    expect(store.navigationId).toBe('site-default-nav-id')
  })

  it('defaults to null when the payload omits it', () => {
    const store = useSiteStore()
    store.applySiteInfo(siteInfoFixture())

    expect(store.navigationId).toBe(null)
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

/**
 * Feature #2574/#2577: `pathDisplayCase` reaches `siteStore` from `applySiteInfo`, the same as
 * `pdfExportAvailable`/`blocksIndex` above -- both `loadSite` and `bootstrap` hand it the same
 * payload shape. `applySiteInfo` also kicks off `fetchAcronymMap()` on its own once the setting is
 * on, with no separate call needed at any render site -- see the dedicated `fetchAcronymMap()`
 * describe below for that half.
 */
describe('site store: applySiteInfo() pathDisplayCase', () => {
  it('adopts pathDisplayCase from the site payload', () => {
    const store = useSiteStore()
    store.applySiteInfo(siteInfoFixture({ pathDisplayCase: 'title' }))

    expect(store.pathDisplayCase).toBe('title')
  })

  it('defaults to "off" when the payload omits it', () => {
    const store = useSiteStore()
    store.applySiteInfo(siteInfoFixture())

    expect(store.pathDisplayCase).toBe('off')
  })

  it('fetches the acronym map when the setting is on', async () => {
    const store = useSiteStore()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ uss: 'USS' })
    })

    store.applySiteInfo(siteInfoFixture({ id: 'site-1', pathDisplayCase: 'title' }))
    await vi.waitFor(() => expect(store.acronymMapLoaded).toBe(true))

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/glossary/acronyms')
    expect(store.acronymMap).toEqual({ uss: 'USS' })
  })

  it('never fetches the acronym map when the setting is off', () => {
    const store = useSiteStore()
    store.applySiteInfo(siteInfoFixture({ pathDisplayCase: 'off' }))

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  /**
   * Bug #2599: the acronym map is per-site, so `applySiteInfo` resets both it and its loaded flag
   * before deciding whether to refetch. Without the reset, `fetchAcronymMap`'s
   * `acronymMapLoaded && !forceRefresh` early return skips the new site's fetch entirely and site B
   * renders site A's casing -- and on the `'off'` path, where no fetch runs at all, site A's map
   * would simply stay put.
   */
  describe('site switch (#2599)', () => {
    it('refetches the acronym map for the new site rather than keeping the previous one', async () => {
      const store = useSiteStore()
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve({ uss: 'USS' })
      })
      store.applySiteInfo(siteInfoFixture({ id: 'site-a', pathDisplayCase: 'title' }))
      await vi.waitFor(() => expect(store.acronymMap).toEqual({ uss: 'USS' }))

      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve({ irv: 'IRV' })
      })
      store.applySiteInfo(siteInfoFixture({ id: 'site-b', pathDisplayCase: 'title' }))

      expect(store.acronymMapLoaded).toBe(false)
      expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-b/glossary/acronyms')
      await vi.waitFor(() => expect(store.acronymMapLoaded).toBe(true))
      expect(store.acronymMap).toEqual({ irv: 'IRV' })
    })

    it('replaces the map wholesale, dropping a key the new site does not carry', async () => {
      const store = useSiteStore()
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve({ uss: 'USS', irv: 'IRV' })
      })
      store.applySiteInfo(siteInfoFixture({ id: 'site-a', pathDisplayCase: 'title' }))
      await vi.waitFor(() => expect(store.acronymMapLoaded).toBe(true))

      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve({ irv: 'IRV' })
      })
      store.applySiteInfo(siteInfoFixture({ id: 'site-b', pathDisplayCase: 'title' }))
      await vi.waitFor(() => expect(store.acronymMapLoaded).toBe(true))

      expect(store.acronymMap).toEqual({ irv: 'IRV' })
    })

    it('clears the previous map with no fetch when the new site has the setting off', async () => {
      const store = useSiteStore()
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve({ uss: 'USS' })
      })
      store.applySiteInfo(siteInfoFixture({ id: 'site-a', pathDisplayCase: 'title' }))
      await vi.waitFor(() => expect(store.acronymMapLoaded).toBe(true))
      API_CLIENT.get.mockClear()

      store.applySiteInfo(siteInfoFixture({ id: 'site-b', pathDisplayCase: 'off' }))

      expect(store.acronymMap).toEqual({})
      expect(store.acronymMapLoaded).toBe(false)
      expect(API_CLIENT.get).not.toHaveBeenCalled()
    })
  })
})

describe('site store: fetchAcronymMap()', () => {
  it('populates acronymMap from the endpoint and marks it loaded', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ uss: 'USS', irv: 'IRV' })
    })

    await store.fetchAcronymMap()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/glossary/acronyms')
    expect(store.acronymMap).toEqual({ uss: 'USS', irv: 'IRV' })
    expect(store.acronymMapLoaded).toBe(true)
  })

  it('does not re-fetch once loaded, unless forceRefresh is passed', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    store.$patch({ acronymMap: { uss: 'USS' }, acronymMapLoaded: true })

    await store.fetchAcronymMap()
    expect(API_CLIENT.get).not.toHaveBeenCalled()

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ irv: 'IRV' })
    })
    await store.fetchAcronymMap(true)
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/glossary/acronyms')
    expect(store.acronymMap).toEqual({ irv: 'IRV' })
  })

  it('swallows a failed request, leaving the map empty rather than throwing', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network down')
    })

    await expect(store.fetchAcronymMap()).resolves.toBeUndefined()
    expect(store.acronymMap).toEqual({})
    expect(store.acronymMapLoaded).toBe(false)
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
      features: { search: true },
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
    expect(store.features.search).toBe(true)
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
      json: () => Promise.resolve({ mode: 'static', items: [{ id: 'item-1' }] })
    })

    await store.fetchNavigation('nav-1')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(store.nav).toEqual({
      currentId: 'nav-1',
      items: [{ id: 'item-1' }],
      mode: 'static',
      rootPath: '',
      rootId: null,
      inFlightId: 'nav-1'
    })
  })

  /**
   * OpenProject #2442: the response's `rootPath`/`rootId` -- the generator's own root for an
   * `auto`/`mixed` menu, distinct from the locale root a `static` menu's absent values default to
   * -- land on `nav` the same way `mode`/`items` already do, so `NavSidebar.vue`'s root-level
   * "create here" action can read them straight off the store.
   */
  it('stores rootPath/rootId from the response', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          mode: 'auto',
          items: [{ id: 'item-1' }],
          rootPath: 'docs/section',
          rootId: 'section-folder-id'
        })
    })

    await store.fetchNavigation('nav-1')

    expect(store.nav.rootPath).toBe('docs/section')
    expect(store.nav.rootId).toBe('section-folder-id')
  })

  it('skips the request for an id already cached, unless forceRefresh is passed', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    store.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'stale' }], mode: 'static' } })

    await store.fetchNavigation('nav-1')
    expect(API_CLIENT.get).not.toHaveBeenCalled()
    expect(store.nav.items).toEqual([{ id: 'stale' }])

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ mode: 'auto', items: [{ id: 'fresh' }] })
    })
    await store.fetchNavigation('nav-1', true)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(store.nav.items).toEqual([{ id: 'fresh' }])
    expect(store.nav.mode).toBe('auto')
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
    store.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'old' }], mode: 'static' } })

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ mode: 'static', items: [{ id: 'new' }] })
    })
    await store.fetchNavigation('nav-2')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-2')
    expect(store.nav).toEqual({
      currentId: 'nav-2',
      items: [{ id: 'new' }],
      mode: 'static',
      rootPath: '',
      rootId: null,
      inFlightId: 'nav-2'
    })
  })

  /**
   * OpenProject #1791: `currentId` used to be written only inside the post-await `$patch`, so two
   * overlapping calls could settle out of order and leave `currentId` naming the wrong menu -- with
   * the `id === currentId` short-circuit above then preventing the correct menu from ever being
   * refetched. `inFlightId` is set synchronously before each request and re-checked after it
   * resolves, so a response for an id that is no longer the most recently requested one is discarded
   * instead of clobbering the newer menu.
   */
  it('discards a stale response when an earlier call resolves after a later one', async () => {
    const store = useSiteStore()
    store.id = 'site-1'

    let resolveFirst
    let resolveSecond
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const secondResponse = new Promise((resolve) => {
      resolveSecond = resolve
    })
    API_CLIENT.get.mockReturnValueOnce({ json: () => firstResponse })
    API_CLIENT.get.mockReturnValueOnce({ json: () => secondResponse })

    const firstCall = store.fetchNavigation('nav-1')
    const secondCall = store.fetchNavigation('nav-2')

    // The later call (nav-2) resolves first; the earlier call (nav-1) resolves last.
    resolveSecond({ mode: 'static', items: [{ id: 'nav-2-item' }] })
    await secondCall
    expect(store.nav.currentId).toBe('nav-2')

    resolveFirst({ mode: 'static', items: [{ id: 'nav-1-item' }] })
    await firstCall

    // The stale nav-1 response must not have overwritten the newer nav-2 menu.
    expect(store.nav.currentId).toBe('nav-2')
    expect(store.nav.items).toEqual([{ id: 'nav-2-item' }])
  })

  it('leaves the correct menu rendered when switching sites twice in quick succession', async () => {
    const store = useSiteStore()
    store.id = 'site-1'

    let resolveSiteA
    let resolveSiteB
    const siteAResponse = new Promise((resolve) => {
      resolveSiteA = resolve
    })
    const siteBResponse = new Promise((resolve) => {
      resolveSiteB = resolve
    })
    API_CLIENT.get.mockReturnValueOnce({ json: () => siteAResponse })
    API_CLIENT.get.mockReturnValueOnce({ json: () => siteBResponse })

    // Two rapid site switches, each kicking off a fetch for that site's nav before the previous one
    // has resolved.
    const fetchA = store.fetchNavigation('site-a-nav')
    const fetchB = store.fetchNavigation('site-b-nav')

    // Site A's slower response lands after site B's, as it would for a genuinely slower request.
    resolveSiteB({ mode: 'static', items: [{ id: 'site-b-item' }] })
    await fetchB
    resolveSiteA({ mode: 'static', items: [{ id: 'site-a-item' }] })
    await fetchA

    expect(store.nav.currentId).toBe('site-b-nav')
    expect(store.nav.items).toEqual([{ id: 'site-b-item' }])
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

  // -> 'still resolves isRTL correctly against a Chrome-shaped Intl.Locale (getTextInfo() method,
  //    no .textInfo getter)' (feature 413, task 727) moved to site.flaky.test.js (OpenProject
  //    #2738): it flaked once in CI for an unconfirmed reason, not reproducible locally.
})

/**
 * OpenProject #1911: Page Data / Page Data Templates was decided OUT (#1890) rather than built out --
 * the dialogs, the disabled rail entry point and this store slot were all dead weight behind an
 * `experimental` flag with no save path. `pageDataTemplates` must not exist on the store any more.
 */
describe('site store: Page Data removal (#1911)', () => {
  it('does not expose a pageDataTemplates slot', () => {
    const store = useSiteStore()

    expect(store.$state).not.toHaveProperty('pageDataTemplates')
    expect(store).not.toHaveProperty('pageDataTemplates')
  })
})

/**
 * OpenProject #2530: `openOverlay(name, opts)` is the one generic entry point for opening any
 * `MainOverlayDialog` overlay with initial state -- `MainOverlayDialog.vue` forwards `overlayOpts` to
 * the mounted component as a prop, so a future overlay (Inbox/Profile) calls this rather than
 * inventing its own store field or action.
 */
describe('site store: openOverlay()', () => {
  it('sets overlay and overlayOpts together', () => {
    const store = useSiteStore()

    store.openOverlay('PageHistory', { pageId: 'page-1' })

    expect(store.overlay).toBe('PageHistory')
    expect(store.overlayOpts).toEqual({ pageId: 'page-1' })
  })

  it('defaults overlayOpts to an empty object when no opts are given', () => {
    const store = useSiteStore()

    store.openOverlay('Welcome')

    expect(store.overlay).toBe('Welcome')
    expect(store.overlayOpts).toEqual({})
  })
})

/**
 * `openFileManager` is now a thin wrapper over `openOverlay` -- this locks down that its own
 * pre-existing `insertMode` default/shape survived the refactor.
 */
describe('site store: openFileManager()', () => {
  it('opens the FileManager overlay with insertMode defaulted to false', () => {
    const store = useSiteStore()

    store.openFileManager()

    expect(store.overlay).toBe('FileManager')
    expect(store.overlayOpts).toEqual({ insertMode: false })
  })

  it('carries insertMode: true through when given', () => {
    const store = useSiteStore()

    store.openFileManager({ insertMode: true })

    expect(store.overlay).toBe('FileManager')
    expect(store.overlayOpts).toEqual({ insertMode: true })
  })
})
