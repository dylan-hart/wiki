import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useEditorStore } from './editor.js'

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

/*
  OpenProject #806 follow-up: every browser hands a clipboard-pasted file the same literal name,
  "image.png", so every paste on every page used to upload to the same asset path -- and the site's
  default overwrite conflict behavior made each one clobber the last, leaving every pasted image
  rendering as whichever one was pasted most recently. `generateUniqueName` is the paste path's opt-in
  into the unique-naming the sibling non-File (raw blob) branch already had; a drop must NOT opt in,
  since a dropped file's name is real user intent ("quarterly-report.pdf") worth keeping.
*/
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
