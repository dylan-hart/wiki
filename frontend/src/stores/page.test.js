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

/** A site with two active locales, `en` primary — the shape `useLocales` and the prefix rule need. */
function makeMultiLocaleSite({ forcePrefix = false } = {}) {
  const siteStore = useSiteStore()
  siteStore.$patch({
    locales: {
      primary: 'en',
      showMenu: true,
      forcePrefix,
      active: [
        { code: 'en', language: 'en', name: 'English', nativeName: 'English' },
        { code: 'fr', language: 'fr', name: 'French', nativeName: 'Français' }
      ]
    }
  })
  return siteStore
}

describe('page store: breadcrumbs', () => {
  it('leaves the path unprefixed on a single-locale site', () => {
    const pageStore = usePageStore()
    pageStore.$patch({ path: 'foo/bar', locale: 'en' })
    expect(pageStore.breadcrumbs.map((b) => b.path)).toEqual(['/foo', '/foo/bar'])
  })

  it('leaves the primary locale unprefixed on a multi-locale site', () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.$patch({ path: 'foo/bar', locale: 'en' })
    expect(pageStore.breadcrumbs.map((b) => b.path)).toEqual(['/foo', '/foo/bar'])
  })

  it('prefixes a non-primary locale on a multi-locale site', () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.$patch({ path: 'foo/bar', locale: 'fr' })
    expect(pageStore.breadcrumbs.map((b) => b.path)).toEqual(['/fr/foo', '/fr/foo/bar'])
  })

  it('prefixes the primary locale too when forcePrefix is on', () => {
    makeMultiLocaleSite({ forcePrefix: true })
    const pageStore = usePageStore()
    pageStore.$patch({ path: 'foo/bar', locale: 'en' })
    expect(pageStore.breadcrumbs.map((b) => b.path)).toEqual(['/en/foo', '/en/foo/bar'])
  })
})

describe('page store: editorExitPath', () => {
  it('leaves the primary locale unprefixed on a multi-locale site', () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.$patch({ path: 'foo/bar', locale: 'en' })
    expect(pageStore.editorExitPath).toBe('/foo/bar')
  })

  it('prefixes a non-primary locale on a multi-locale site', () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.$patch({ path: 'foo/bar', locale: 'fr' })
    expect(pageStore.editorExitPath).toBe('/fr/foo/bar')
  })

  it('keeps the ?redirect=no query after the prefix', () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.$patch({ path: 'foo/bar', locale: 'fr', editor: 'redirect' })
    expect(pageStore.editorExitPath).toBe('/fr/foo/bar?redirect=no')
  })
})
