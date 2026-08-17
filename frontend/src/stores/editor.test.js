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
