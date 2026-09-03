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

  /**
   * Regression for OpenProject #816: `App.vue`'s router guard reads `editorStore.hasPendingChanges`
   * on every navigation, including the one `pageSave()` fires itself after a create. If that internal
   * `router.replace()` ran before the timestamps were equalized, the guard would read the just-saved
   * page as still dirty and prompt to discard the save that had just succeeded.
   */
  it('marks the editor clean (hasPendingChanges false) before navigating away on a create-mode save', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.$patch({
      mode: 'create',
      lastSaveTimestamp: 'save-1',
      lastChangeTimestamp: 'change-1'
    })
    pageStore.$patch({
      id: 0,
      contentLoaded: true,
      locale: 'en',
      path: 'new-page',
      updatedAt: ''
    })

    let hasPendingChangesAtReplace = null
    pageStore.router = {
      replace: () => {
        hasPendingChangesAtReplace = editorStore.hasPendingChanges
        return Promise.resolve()
      }
    }

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: { id: '9', updatedAt: '2026-01-02T00:00:00.000Z', relations: [], tocDepth: {} }
        })
    })

    await pageStore.pageSave()

    expect(hasPendingChangesAtReplace).toBe(false)
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
    // -> Shaped as ky's real `HTTPError`: `data` is what ky parsed from the body before throwing,
    //    and `response`'s own body stream is already consumed by then -- no working `json()` on it.
    conflictErr.data = { ok: false, message: 'conflict', page: conflictSnapshot }
    conflictErr.response = { status: 409 }
    API_CLIENT.patch.mockReturnValueOnce({
      json: () => Promise.reject(conflictErr)
    })

    await expect(pageStore.pageSave()).rejects.toThrow('ERR_SAVE_CONFLICT')

    expect(editorStore.saveConflict).toEqual(conflictSnapshot)
  })

  /**
   * Escape-hatch guarantee for OpenProject #838 (upstream requarks/wiki #2256: "Conflict after
   * editing a page which can't be resolved"). A refused save must never be a dead end -- this
   * author's edit has to stay saveable one way or another. `EditorMarkdown.vue`'s conflict dialog
   * offers exactly this "Save Anyway" path: adopt the conflicting save's `updatedAt` as the new
   * optimistic-concurrency baseline and resubmit the same content unchanged. This test drives that
   * same sequence directly against the store, without the dialog, and confirms it actually lands --
   * the retry is accepted, and what gets persisted is this author's content, not the version that
   * caused the conflict.
   */
  it("always has an escape hatch: retrying with the conflicting save's updatedAt as the new baseline persists this author's content", async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      content: "this author's unsaved edit"
    })

    const conflictSnapshot = {
      updatedAt: '2026-01-01T05:00:00.000Z',
      title: 'Server Title',
      content: "somebody else's content",
      authorName: 'Ada Lovelace'
    }
    const conflictErr = new Error('Conflict')
    // -> Shaped as ky's real `HTTPError`: `data` is what ky parsed from the body before throwing,
    //    and `response`'s own body stream is already consumed by then -- no working `json()` on it.
    conflictErr.data = { ok: false, message: 'conflict', page: conflictSnapshot }
    conflictErr.response = { status: 409 }
    API_CLIENT.patch.mockReturnValueOnce({
      json: () => Promise.reject(conflictErr)
    })

    await expect(pageStore.pageSave()).rejects.toThrow('ERR_SAVE_CONFLICT')

    // -> The refusal doesn't touch this author's own edit -- nothing has been discarded, so there is
    //    still something to save once the conflict is resolved.
    expect(pageStore.content).toBe("this author's unsaved edit")

    // -> "Save Anyway": adopt the server's updatedAt as the new baseline and resubmit.
    pageStore.updatedAt = editorStore.saveConflict.updatedAt

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: {
            id: '5',
            updatedAt: '2026-01-01T05:00:01.000Z',
            content: "this author's unsaved edit",
            relations: [],
            tocDepth: {}
          }
        })
    })

    // -> `pageSave()` now resolves `{ classificationConflicts }` on an update (OpenProject #1080) --
    //    empty here, since this response carries none.
    await expect(pageStore.pageSave()).resolves.toEqual({ classificationConflicts: [] })

    const [, retryOpts] = API_CLIENT.patch.mock.calls[1]
    expect(retryOpts.json.expectedUpdatedAt).toBe(conflictSnapshot.updatedAt)
    expect(retryOpts.json.content).toBe("this author's unsaved edit")
    expect(pageStore.content).toBe("this author's unsaved edit")
    expect(pageStore.updatedAt).toBe('2026-01-01T05:00:01.000Z')
  })

  /**
   * OpenProject #1762: `unwrap()` used to compensate for `boot/api.js` resolving a 400 instead of
   * throwing. Now that a refusal is a real rejection, this is the ky `HTTPError` shape (`.response`,
   * `.data.message`) it arrives in -- and the server's own message must survive onto the thrown
   * error's `.message`, since callers such as `PageHeader.vue` read `err.message` directly rather
   * than going through `apiErrorMessage()` themselves.
   */
  it('on an update refused with a non-conflict error, rejects with the server message', async () => {
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

    const refusalErr = new Error('Bad Request')
    refusalErr.response = { status: 400 }
    refusalErr.data = { message: 'Path already exists.' }
    API_CLIENT.patch.mockReturnValueOnce({
      json: () => Promise.reject(refusalErr)
    })

    await expect(pageStore.pageSave()).rejects.toThrow('Path already exists.')
  })

  it('on a create refused with a non-conflict error, rejects with the server message', async () => {
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

    const refusalErr = new Error('Bad Request')
    refusalErr.response = { status: 400 }
    refusalErr.data = { message: 'A page already exists at this path.' }
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject(refusalErr)
    })

    await expect(pageStore.pageSave()).rejects.toThrow('A page already exists at this path.')
  })
})

/**
 * OpenProject #1012: a newly created page can change what an `auto`/`mixed` menu generates from the
 * tree -- it is a new entry, not an edit to one already there -- with nothing on the backend to tell
 * an already-open tab. An ordinary content update never adds or removes a tree entry, so it must NOT
 * pay for the same force-refetch on every save.
 */
describe('page store: pageSave() same-tab navigation invalidation (OpenProject #1012)', () => {
  it('force-refetches the sidebar menu after a create-mode save, even with the same nav id already cached', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    // -> Already cached under this id -- the plain "id changed" gate `fetchNavigation()` otherwise
    //    applies would skip a refetch here if this test didn't force past it.
    siteStore.nav.currentId = 'nav-1'
    editorStore.$patch({ mode: 'create' })
    pageStore.$patch({ id: 0, contentLoaded: true, locale: 'en', path: 'new-page', updatedAt: '' })
    pageStore.router = { replace: () => Promise.resolve() }

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: {
            id: '9',
            navigationId: 'nav-1',
            updatedAt: '2026-01-02T00:00:00.000Z',
            relations: [],
            tocDepth: {}
          }
        })
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ mode: 'static', items: [{ id: 'item-new' }] })
    })

    await pageStore.pageSave()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(siteStore.nav.items).toEqual([{ id: 'item-new' }])
  })

  it('does not touch the sidebar menu on an ordinary (non-create) save', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      navigationId: 'nav-1'
    })

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: {
            id: '5',
            navigationId: 'nav-1',
            updatedAt: '2026-01-01T01:00:00.000Z',
            relations: [],
            tocDepth: {}
          }
        })
    })

    await pageStore.pageSave()

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })
})

describe('page store: pageSave() reads the live editor first (OpenProject #806)', () => {
  it('flushes editorStore.contentFlusher before building the save body, replacing a stale content/render pair', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      // -> What the store would still hold if the debounced sync from `EditorMarkdown.vue` had not
      //    caught up yet -- the dead `blob:` URL a pasted image is inserted as before its upload lands
      content: '![pasted](blob:http://localhost/abc123)',
      render: '<p><img src="blob:http://localhost/abc123"></p>'
    })
    // -> Stands in for `EditorMarkdown.vue` registering `flushEditorContent` while mounted
    editorStore.contentFlusher = () => {
      pageStore.content = '![pasted](/assets/pasted.png)'
      pageStore.render = '<p><img src="/assets/pasted.png"></p>'
    }

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: { id: '5', updatedAt: '2026-01-02T00:00:00.000Z', relations: [], tocDepth: {} }
        })
    })

    await pageStore.pageSave()

    const [, opts] = API_CLIENT.patch.mock.calls[0]
    expect(opts.json.content).toBe('![pasted](/assets/pasted.png)')
    expect(opts.json.render).toBe('<p><img src="/assets/pasted.png"></p>')
    expect(opts.json.content).not.toContain('blob:')
    expect(opts.json.render).not.toContain('blob:')
  })

  it('awaits an asynchronous contentFlusher before building the save body (EditorAsciidoc.vue)', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      content: 'stale',
      render: 'stale'
    })
    // -> Stands in for `EditorAsciidoc.vue`'s `flushEditorContent`, genuinely asynchronous because
    //    Asciidoctor's `convert` is (`renderers/asciidoc.js`)
    editorStore.contentFlusher = async () => {
      await Promise.resolve()
      pageStore.content = '= Typed\n\nBody.'
      pageStore.render = '<h1>Typed</h1><p>Body.</p>'
    }

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: { id: '5', updatedAt: '2026-01-02T00:00:00.000Z', relations: [], tocDepth: {} }
        })
    })

    await pageStore.pageSave()

    const [, opts] = API_CLIENT.patch.mock.calls[0]
    expect(opts.json.content).toBe('= Typed\n\nBody.')
    expect(opts.json.render).toBe('<h1>Typed</h1><p>Body.</p>')
  })

  it('leaves content/render exactly as stored when no editor is mounted (contentFlusher unset)', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      content: 'stored content',
      render: '<p>stored content</p>'
    })

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: { id: '5', updatedAt: '2026-01-02T00:00:00.000Z', relations: [], tocDepth: {} }
        })
    })

    await pageStore.pageSave()

    const [, opts] = API_CLIENT.patch.mock.calls[0]
    expect(opts.json.content).toBe('stored content')
    expect(opts.json.render).toBe('<p>stored content</p>')
  })

  it('does not force contentLoaded from the flush, so a page whose source was withheld still drops content', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: false,
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    // -> Even a flush that writes something must not be trusted to also mean "loaded" -- see the
    //    guard in `pageSave()`
    editorStore.contentFlusher = () => {
      pageStore.content = 'should never be sent'
    }

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: { id: '5', updatedAt: '2026-01-02T00:00:00.000Z', relations: [], tocDepth: {} }
        })
    })

    await pageStore.pageSave()

    const [, opts] = API_CLIENT.patch.mock.calls[0]
    expect(Object.hasOwn(opts.json, 'content')).toBe(false)
  })
})
