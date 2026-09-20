import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useEditorStore } from './editor.js'
import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('editor store: fetchUserSettings()', () => {
  it("fetches this user's settings for the given editor and patches them into their own slice", async () => {
    const store = useEditorStore()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ previewShown: false, fontSize: 22 })
    })

    const result = await store.fetchUserSettings('markdown')

    expect(API_CLIENT.get).toHaveBeenCalledWith('users/profile/editor-settings/markdown')
    expect(result).toEqual({ previewShown: false, fontSize: 22 })
    expect(store.userSettings.markdown).toEqual({ previewShown: false, fontSize: 22 })
  })

  it('defaults to the markdown editor when none is given', async () => {
    const store = useEditorStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ fontSize: 18 }) })

    await store.fetchUserSettings()

    expect(API_CLIENT.get).toHaveBeenCalledWith('users/profile/editor-settings/markdown')
    expect(store.userSettings.markdown).toEqual({ fontSize: 18 })
  })

  it('is kept apart from the site-level editors config, never conflated with it', async () => {
    const store = useEditorStore()
    store.$patch({ editors: { markdown: { linkify: true } } })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ fontSize: 12 }) })

    await store.fetchUserSettings('markdown')

    expect(store.editors.markdown).toEqual({ linkify: true })
    expect(store.userSettings.markdown).toEqual({ fontSize: 12 })
  })

  it("does not clobber another editor's already-fetched settings", async () => {
    const store = useEditorStore()
    store.$patch({ userSettings: { wysiwyg: { fontSize: 30 } } })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ fontSize: 12 }) })

    await store.fetchUserSettings('markdown')

    expect(store.userSettings).toEqual({
      wysiwyg: { fontSize: 30 },
      markdown: { fontSize: 12 }
    })
  })

  it('rethrows and leaves the slice untouched on failure, mirroring fetchConfigs()', async () => {
    const store = useEditorStore()
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network')
    })

    await expect(store.fetchUserSettings('markdown')).rejects.toThrow('network')
    expect(store.userSettings.markdown).toBeUndefined()
  })
})

describe('editor store: fetchConfigs() glossary terms (OpenProject #870)', () => {
  it("folds the resolved glossary terms into the markdown editor's config", async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const store = useEditorStore()
    API_CLIENT.get.mockImplementationOnce((url) => {
      expect(url).toBe('sites/site-1')
      return {
        json: () => Promise.resolve({ editors: { markdown: { config: { underline: true } } } })
      }
    })
    API_CLIENT.get.mockImplementationOnce((url) => {
      expect(url).toBe('sites/site-1/glossary/terms')
      return {
        json: () =>
          Promise.resolve([
            { term: 'API', definition: 'Application Programming Interface', link: null }
          ])
      }
    })

    await store.fetchConfigs()

    expect(store.editors.markdown).toEqual({
      underline: true,
      glossaryTerms: [{ term: 'API', definition: 'Application Programming Interface', link: null }]
    })
  })

  it('defaults to an empty glossary term list rather than leaving it undefined', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const store = useEditorStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({}) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(undefined) })

    await store.fetchConfigs()

    expect(store.editors.markdown).toEqual({ glossaryTerms: [] })
  })
})

describe('editor store: ensureConfigs() keeps the glossary term list fresh (OpenProject #2789)', () => {
  it('fetches the full config on the first call, when nothing is loaded yet', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const store = useEditorStore()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ editors: { markdown: { config: { underline: true } } } })
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          { term: 'API', definition: 'Application Programming Interface', link: null }
        ])
    })

    await store.ensureConfigs()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)
    expect(store.configIsLoaded).toBe(true)
    expect(store.editors.markdown).toEqual({
      underline: true,
      glossaryTerms: [{ term: 'API', definition: 'Application Programming Interface', link: null }]
    })
  })

  it('re-fetches only the glossary terms on a later call, once the config is already loaded', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const store = useEditorStore()
    store.$patch({
      configIsLoaded: true,
      editors: { markdown: { underline: true, glossaryTerms: [] } }
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([{ term: 'Widget', definition: 'A small reusable thing.', link: null }])
    })

    await store.ensureConfigs()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/glossary/terms')
    expect(store.editors.markdown).toEqual({
      underline: true,
      glossaryTerms: [{ term: 'Widget', definition: 'A small reusable thing.', link: null }]
    })
  })

  it('a second, later session refresh sees a term added after the first fetch', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const store = useEditorStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({}) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve([]) })
    await store.ensureConfigs()
    expect(store.editors.markdown.glossaryTerms).toEqual([])

    // -> A term is added to the glossary in the same SPA session, with no page reload
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          { term: 'API', definition: 'Application Programming Interface', link: null }
        ])
    })

    await store.ensureConfigs()

    expect(store.editors.markdown.glossaryTerms).toEqual([
      { term: 'API', definition: 'Application Programming Interface', link: null }
    ])
  })

  it('refreshGlossaryTerms() does not throw when the request fails, degrading to whatever this session already had', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const store = useEditorStore()
    store.$patch({
      configIsLoaded: true,
      editors: { markdown: { underline: true, glossaryTerms: [{ term: 'API' }] } }
    })
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network')
    })

    await expect(store.ensureConfigs()).resolves.toBeUndefined()

    expect(store.editors.markdown.glossaryTerms).toEqual([{ term: 'API' }])
  })

  it('refreshGlossaryTerms() is a no-op with no siteId to ask', async () => {
    const store = useEditorStore()

    await store.refreshGlossaryTerms()

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })
})

describe('editor store: addPendingAsset() (OpenProject #806 follow-up)', () => {
  it('mints a unique fileName for each pasted File, ignoring the identical browser-supplied name', () => {
    const store = useEditorStore()
    const first = new File(['a'], 'image.png', { type: 'image/png' })
    const second = new File(['b'], 'image.png', { type: 'image/png' })

    store.addPendingAsset(first, { generateUniqueName: true })
    store.addPendingAsset(second, { generateUniqueName: true })

    const [firstAsset, secondAsset] = store.pendingAssets
    expect(firstAsset.fileName).not.toBe('image.png')
    expect(secondAsset.fileName).not.toBe('image.png')
    expect(firstAsset.fileName).not.toBe(secondAsset.fileName)
    expect(firstAsset.fileName.endsWith('.png')).toBe(true)
    expect(secondAsset.fileName.endsWith('.png')).toBe(true)
  })

  it('preserves a dropped File name unchanged, the default (no `generateUniqueName`)', () => {
    const store = useEditorStore()
    const file = new File(['a'], 'quarterly-report.pdf', { type: 'application/pdf' })

    store.addPendingAsset(file)

    expect(store.pendingAssets[0].fileName).toBe('quarterly-report.pdf')
  })

  it('falls back to the mime-type table when a uniquely-named File has no extension of its own', () => {
    const store = useEditorStore()
    const file = new File(['a'], 'image', { type: 'image/webp' })

    store.addPendingAsset(file, { generateUniqueName: true })

    expect(store.pendingAssets[0].fileName.endsWith('.webp')).toBe(true)
  })
})

/**
 * This branch is unreachable from the app today -- the only caller always passes real `File`
 * instances -- so these are the only thing keeping it working for a caller that hands it a raw Blob
 * (canvas `toBlob()` output, say).
 */
describe('editor store: addPendingAsset() Blob branch (OpenProject #952)', () => {
  it('queues a raw (non-File) Blob without throwing', () => {
    const store = useEditorStore()
    const blob = new Blob(['a'], { type: 'image/png' })

    expect(() => store.addPendingAsset(blob)).not.toThrow()
    expect(store.pendingAssets).toHaveLength(1)
  })

  it('wraps the Blob in a real File, named from the mime-type table', () => {
    const store = useEditorStore()
    const blob = new Blob(['a'], { type: 'image/webp' })

    store.addPendingAsset(blob)

    const asset = store.pendingAssets[0]
    expect(asset.kind).toBe('blob')
    expect(asset.file).toBeInstanceOf(File)
    expect(asset.file.type).toBe('image/webp')
    expect(asset.fileName.endsWith('.webp')).toBe(true)
    expect(asset.file.name).toBe(asset.fileName)
  })

  it('preserves the blob content in the wrapped File', async () => {
    const store = useEditorStore()
    const blob = new Blob(['hello blob'], { type: 'text/plain' })

    store.addPendingAsset(blob)

    const text = await store.pendingAssets[0].file.text()
    expect(text).toBe('hello blob')
  })
})

describe('editor store: discardedContent (OpenProject #2073)', () => {
  it('defaults to null, so no toast offers an undo with nothing behind it', () => {
    const store = useEditorStore()

    expect(store.discardedContent).toBeNull()
  })

  it("stashDiscardedContent() retains the author's previous content for undo", () => {
    const store = useEditorStore()

    store.stashDiscardedContent('My unsaved paragraph.')

    expect(store.discardedContent).toBe('My unsaved paragraph.')
  })

  it('stashDiscardedContent() overwrites a prior stash -- only the latest discard is offered back', () => {
    const store = useEditorStore()
    store.stashDiscardedContent('First discard.')

    store.stashDiscardedContent('Second discard.')

    expect(store.discardedContent).toBe('Second discard.')
  })

  it('clearDiscardedContent() resets it to null once restored (or no longer offered)', () => {
    const store = useEditorStore()
    store.stashDiscardedContent('My unsaved paragraph.')

    store.clearDiscardedContent()

    expect(store.discardedContent).toBeNull()
  })
})
