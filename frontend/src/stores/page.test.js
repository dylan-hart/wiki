import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { usePageStore } from './page.js'
import { useEditorStore } from './editor.js'
import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('page store: pageSave() concurrency', () => {
  it('sends expectedUpdatedAt on the PATCH body when saving an existing page', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    })

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: { id: '5', updatedAt: '2026-01-02T00:00:00.000Z', relations: [], tocDepth: {} }
        })
    })

    await pageStore.pageSave()

    expect(API_CLIENT.patch).toHaveBeenCalledWith(
      'sites/site-1/pages/5',
      expect.objectContaining({
        json: expect.objectContaining({ expectedUpdatedAt: '2026-01-01T00:00:00.000Z' })
      })
    )
  })

  it('does not send expectedUpdatedAt when creating a page', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'create'
    pageStore.$patch({
      id: 0,
      contentLoaded: true,
      locale: 'en',
      path: 'new-page',
      updatedAt: ''
    })
    // -> `router` is normally injected into every store by the pinia plugin in `stores/index.js`;
    //    stubbed directly here since `pageSave()` navigates away after a create.
    pageStore.router = { replace: () => Promise.resolve() }

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: { id: '9', updatedAt: '2026-01-02T00:00:00.000Z', relations: [], tocDepth: {} }
        })
    })

    await pageStore.pageSave()

    const [, opts] = API_CLIENT.post.mock.calls[0]
    expect(Object.hasOwn(opts.json, 'expectedUpdatedAt')).toBe(false)
  })

  it('on a 409 conflict, surfaces the server snapshot on the editor store instead of a generic error', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    })

    const conflictSnapshot = {
      updatedAt: '2026-01-01T05:00:00.000Z',
      title: 'Server Title',
      content: 'Server content',
      authorName: 'Ada Lovelace'
    }
    const conflictErr = new Error('Conflict')
    conflictErr.response = {
      status: 409,
      json: () => Promise.resolve({ ok: false, message: 'conflict', page: conflictSnapshot })
    }
    API_CLIENT.patch.mockReturnValueOnce({
      json: () => Promise.reject(conflictErr)
    })

    await expect(pageStore.pageSave()).rejects.toThrow('ERR_SAVE_CONFLICT')

    expect(editorStore.saveConflict).toEqual(conflictSnapshot)
  })
})

describe('page store: viewer.activeEditors (task 546)', () => {
  it('applyViewerState() carries activeEditors onto the store as-is', () => {
    const pageStore = usePageStore()

    pageStore.applyViewerState({
      permissions: [],
      isWatching: false,
      activeEditors: { count: 2, names: ['Ada Lovelace', 'Grace Hopper'] }
    })

    expect(pageStore.activeEditors).toEqual({ count: 2, names: ['Ada Lovelace', 'Grace Hopper'] })
  })

  it('applyViewerState() defaults to zero when the server omits activeEditors', () => {
    const pageStore = usePageStore()
    // -> Not a real response shape (the route always sends it), but the same defensive fallback
    //    every other viewer field gets here
    pageStore.applyViewerState({ permissions: [] })

    expect(pageStore.activeEditors).toEqual({ count: 0, names: [] })
  })

  it('pageLoad() -- the editor entry point load, when there are no pending local edits -- reaches the store with what the GET page route answered', async () => {
    const pageStore = usePageStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: '5',
          relations: [],
          tocDepth: {},
          viewer: {
            permissions: ['write:pages'],
            isWatching: false,
            activeEditors: { count: 1, names: ['Ada Lovelace'] }
          }
        })
    })

    await pageStore.pageLoad({ id: '5' })

    expect(pageStore.activeEditors).toEqual({ count: 1, names: ['Ada Lovelace'] })
  })
})
