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

  /**
   * Humanizing a crumb title is an unconditional transform, not a fallback: a breadcrumb has
   * nothing but the raw path segment to work with, so there is no real title being overridden.
   */
  it('leaves each crumb title as the raw segment when the setting is off', () => {
    const pageStore = usePageStore()
    pageStore.$patch({ path: 'getting-started/uss-enterprise', locale: 'en' })
    expect(pageStore.breadcrumbs.map((c) => c.title)).toEqual(['getting-started', 'uss-enterprise'])
  })

  it('humanizes each crumb title per the site case style, honoring the acronym map', () => {
    const siteStore = useSiteStore()
    siteStore.$patch({ pathDisplayCase: 'title', acronymMap: { uss: 'USS' } })
    const pageStore = usePageStore()
    pageStore.$patch({ path: 'getting-started/uss-enterprise', locale: 'en' })
    expect(pageStore.breadcrumbs.map((c) => c.title)).toEqual(['Getting Started', 'USS Enterprise'])
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
    pageStore.$patch({ id: 'page-1', isWatching: false, watchersRevision: 0 })

    const refusal = { data: { message: 'You may not watch this page.' } }
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.reject(refusal) })

    await expect(pageStore.pageWatch(true)).rejects.toBe(refusal)

    expect(pageStore.isWatching).toBe(false)
    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/watch')
    // -> Nothing changed server-side, so there is nothing for the rail to re-fetch
    expect(pageStore.watchersRevision).toBe(0)
  })

  it('sets isWatching optimistically and keeps it on success', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.$patch({ id: 'page-1', isWatching: false })

    API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, isWatching: true })
    })

    await pageStore.pageWatch(true)

    expect(pageStore.isWatching).toBe(true)
  })

  /**
   * The rail's watcher-list re-fetch keys off `watchersRevision`, not `isWatching`, because this
   * action flips `isWatching` optimistically and synchronously. The revision must therefore move
   * only once the request has genuinely settled, or the re-fetch races ahead of the write.
   */
  it('bumps watchersRevision only once the request resolves, and reads isWatching back from it', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.$patch({ id: 'page-1', isWatching: false, watchersRevision: 5 })

    let resolveJson
    API_CLIENT.put.mockReturnValueOnce({
      json: () =>
        new Promise((resolve) => {
          resolveJson = resolve
        })
    })

    const pending = pageStore.pageWatch(true)
    // -> Flipped instantly: the bell must not wait on a round trip
    expect(pageStore.isWatching).toBe(true)
    // -> The revision has not moved: nothing has committed on the server yet
    expect(pageStore.watchersRevision).toBe(5)

    resolveJson({ ok: true, isWatching: true })
    await pending

    expect(pageStore.isWatching).toBe(true)
    expect(pageStore.watchersRevision).toBe(6)
  })

  it('unwatches through DELETE, reading isWatching back as false', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.$patch({ id: 'page-1', isWatching: true, watchersRevision: 0 })

    API_CLIENT.delete.mockReturnValueOnce({
      json: () => Promise.resolve({ ok: true, isWatching: false })
    })

    await pageStore.pageWatch(false)

    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/pages/page-1/watch')
    expect(pageStore.isWatching).toBe(false)
    expect(pageStore.watchersRevision).toBe(1)
  })
})
