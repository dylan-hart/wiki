import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { usePageStore } from './page.js'
import { useSiteStore } from './site.js'
import { makeMultiLocaleSite } from './pageStoreFixtures.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

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

  it('carries the page locale and localized cumulative paths', () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.$patch({ path: 'guides/deep/page', locale: 'fr' })
    const crumbs = pageStore.breadcrumbs
    expect(crumbs.map((c) => c.path)).toEqual([
      '/fr/guides',
      '/fr/guides/deep',
      '/fr/guides/deep/page'
    ])
    expect(crumbs.every((c) => c.locale === 'fr')).toBe(true)
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

describe('page store: pageWatch()', () => {
  it('reverts isWatching and rethrows when the request is refused, for the caller to report', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.$patch({ id: 'page-1', isWatching: false })

    const refusal = { data: { message: 'You may not watch this page.' } }
    API_CLIENT.put.mockReturnValueOnce(Promise.reject(refusal))

    await expect(pageStore.pageWatch(true)).rejects.toBe(refusal)

    expect(pageStore.isWatching).toBe(false)
    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/watch')
  })

  it('sets isWatching optimistically and keeps it on success', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.$patch({ id: 'page-1', isWatching: false })

    API_CLIENT.put.mockReturnValueOnce(Promise.resolve({ ok: true }))

    await pageStore.pageWatch(true)

    expect(pageStore.isWatching).toBe(true)
  })
})
