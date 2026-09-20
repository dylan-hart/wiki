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

  /**
   * Unconditional, not gated on the scripts panel being open: an actor without `write:scripts`/
   * `write:styles` has no panel to change these with, and `api/pages/write.ts` refuses a real
   * change anyway, so an unrelated save merely round-trips the current values.
   */
  it('sends scriptJsLoad/scriptJsUnload/scriptCss on the PATCH body', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      scriptJsLoad: 'console.log("load")',
      scriptJsUnload: 'console.log("unload")',
      scriptCss: 'body { color: red }'
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
        json: expect.objectContaining({
          scriptJsLoad: 'console.log("load")',
          scriptJsUnload: 'console.log("unload")',
          scriptCss: 'body { color: red }'
        })
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
    // -> `router` is normally injected by the pinia plugin in `stores/index.js`; stubbed here
    //    because `pageSave()` navigates away after a create.
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
   * `App.vue`'s router guard reads `editorStore.hasPendingChanges` on every navigation, including
   * the one `pageSave()` fires itself: equalize the timestamps first, or the guard reads the
   * just-saved page as dirty and prompts to discard the save that succeeded.
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

  /**
   * `editorStore.originPageId` must not outlive the create session that set it: left set, a later
   * edit-mode `cancelPageEdit()` loads that stale origin page instead of the page being edited.
   */
  it('resets originPageId once a create-mode save commits', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.$patch({ mode: 'create', originPageId: 'origin-page-1' })
    pageStore.$patch({
      id: 0,
      contentLoaded: true,
      locale: 'en',
      path: 'new-page',
      updatedAt: ''
    })
    pageStore.router = { replace: () => Promise.resolve() }

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: { id: '9', updatedAt: '2026-01-02T00:00:00.000Z', relations: [], tocDepth: {} }
        })
    })

    await pageStore.pageSave()

    expect(editorStore.originPageId).toBe('')
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
    // -> Shaped as ky's real `HTTPError`: `data` is the body ky parsed before throwing, and
    //    `response`'s own stream is already consumed by then -- no working `json()` on it.
    conflictErr.data = { ok: false, message: 'conflict', page: conflictSnapshot }
    conflictErr.response = { status: 409 }
    API_CLIENT.patch.mockReturnValueOnce({
      json: () => Promise.reject(conflictErr)
    })

    await expect(pageStore.pageSave()).rejects.toThrow('ERR_SAVE_CONFLICT')

    expect(editorStore.saveConflict).toEqual(conflictSnapshot)
  })

  /**
   * A refused save must never be a dead end (upstream requarks/wiki #2256, "Conflict after editing
   * a page which can't be resolved"). This drives the conflict dialog's "Save Anyway" sequence --
   * adopt the conflicting save's `updatedAt` as the new optimistic-concurrency baseline and
   * resubmit unchanged -- straight against the store, confirming this author's content is what
   * lands.
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
    conflictErr.data = { ok: false, message: 'conflict', page: conflictSnapshot }
    conflictErr.response = { status: 409 }
    API_CLIENT.patch.mockReturnValueOnce({
      json: () => Promise.reject(conflictErr)
    })

    await expect(pageStore.pageSave()).rejects.toThrow('ERR_SAVE_CONFLICT')

    expect(pageStore.content).toBe("this author's unsaved edit")

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

    await expect(pageStore.pageSave()).resolves.toEqual({ classificationConflicts: [] })

    const [, retryOpts] = API_CLIENT.patch.mock.calls[1]
    expect(retryOpts.json.expectedUpdatedAt).toBe(conflictSnapshot.updatedAt)
    expect(retryOpts.json.content).toBe("this author's unsaved edit")
    expect(pageStore.content).toBe("this author's unsaved edit")
    expect(pageStore.updatedAt).toBe('2026-01-01T05:00:01.000Z')
  })

  /**
   * The server's own message has to survive onto the thrown error's `.message`: callers such as
   * `composables/pageSaveFlow.js` read `err.message` directly rather than going through
   * `apiErrorMessage()`.
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
 * A newly created page changes what an `auto`/`mixed` menu generates from the tree, with nothing on
 * the backend to tell an already-open tab. An ordinary content update never adds or removes a tree
 * entry, so it must NOT pay for the same force-refetch on every save.
 */
describe('page store: pageSave() same-tab navigation invalidation (OpenProject #1012)', () => {
  it('force-refetches the sidebar menu after a create-mode save, even with the same nav id already cached', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    // -> Already cached under this id, so the plain "id changed" gate in `fetchNavigation()` would
    //    skip the refetch unless the save forces past it.
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

  it('does not touch the sidebar menu on an ordinary (non-create) save that leaves icon/title untouched', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      navigationId: 'nav-1',
      icon: 'mdi:file-document',
      title: 'Unchanged Title',
      // -> Pre-edit baseline, matching the live fields: nothing was picked in the properties dialog
      savedIcon: 'mdi:file-document',
      savedTitle: 'Unchanged Title'
    })

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: {
            id: '5',
            navigationId: 'nav-1',
            updatedAt: '2026-01-01T01:00:00.000Z',
            icon: 'mdi:file-document',
            title: 'Unchanged Title',
            relations: [],
            tocDepth: {}
          }
        })
    })

    await pageStore.pageSave()

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })
})

/**
 * A plain content save cannot add or remove a tree entry, but it CAN change what an existing entry
 * displays: `NavSidebarItem.vue` draws a cached entry's icon and title straight off the nav-tree
 * response, so those two need the same force-refresh a tree-shape change gets.
 *
 * `icon`/`title` are live-bound into `PagePropertiesDialog.vue` and `PageHeader.vue`, so by save
 * time they already hold the newly picked value and a real server echoes it back. The fixtures keep
 * that shape -- OLD in `savedIcon`/`savedTitle`, NEW in `icon`/`title`, echoed in the response --
 * because a value the response never carries would not exercise the comparison at all.
 */
describe('page store: pageSave() nav-tree display invalidation (OpenProject #2824, #2884)', () => {
  it('force-refetches the sidebar menu when an ordinary save changes the page icon', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    siteStore.nav.currentId = 'nav-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      navigationId: 'nav-1',
      savedIcon: 'mdi:file-document',
      savedTitle: 'Unchanged Title',
      icon: 'mdi:new-icon',
      title: 'Unchanged Title'
    })

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: {
            id: '5',
            navigationId: 'nav-1',
            updatedAt: '2026-01-01T01:00:00.000Z',
            icon: 'mdi:new-icon',
            title: 'Unchanged Title',
            relations: [],
            tocDepth: {}
          }
        })
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ mode: 'static', items: [{ id: 'item-updated' }] })
    })

    await pageStore.pageSave()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(siteStore.nav.items).toEqual([{ id: 'item-updated' }])
    expect(pageStore.savedIcon).toBe('mdi:new-icon')
  })

  it('force-refetches the sidebar menu when an ordinary save changes the page title', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    siteStore.nav.currentId = 'nav-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      navigationId: 'nav-1',
      savedIcon: 'mdi:file-document',
      savedTitle: 'Old Title',
      icon: 'mdi:file-document',
      title: 'New Title'
    })

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: {
            id: '5',
            navigationId: 'nav-1',
            updatedAt: '2026-01-01T01:00:00.000Z',
            icon: 'mdi:file-document',
            title: 'New Title',
            relations: [],
            tocDepth: {}
          }
        })
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ mode: 'static', items: [{ id: 'item-updated' }] })
    })

    await pageStore.pageSave()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(siteStore.nav.items).toEqual([{ id: 'item-updated' }])
    expect(pageStore.savedTitle).toBe('New Title')
  })

  it('does not force-refresh when icon/title were live-bound but never actually changed from the saved baseline', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    siteStore.nav.currentId = 'nav-1'
    editorStore.mode = 'edit'
    pageStore.$patch({
      id: '5',
      contentLoaded: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      navigationId: 'nav-1',
      savedIcon: 'mdi:file-document',
      savedTitle: 'Unchanged Title',
      icon: 'mdi:file-document',
      title: 'Unchanged Title'
    })

    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: {
            id: '5',
            navigationId: 'nav-1',
            updatedAt: '2026-01-01T01:00:00.000Z',
            icon: 'mdi:file-document',
            title: 'Unchanged Title',
            relations: [],
            tocDepth: {}
          }
        })
    })

    await pageStore.pageSave()

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('does not force-refresh on a create-mode save just because it lacks the wasCreate short-circuit -- the flag alone is enough', async () => {
    const pageStore = usePageStore()
    const editorStore = useEditorStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    siteStore.nav.currentId = 'nav-1'
    editorStore.$patch({ mode: 'create' })
    pageStore.$patch({
      id: 0,
      contentLoaded: true,
      locale: 'en',
      path: 'new-page',
      updatedAt: '',
      icon: 'mdi:file-document',
      title: 'Draft Title'
    })
    pageStore.router = { replace: () => Promise.resolve() }

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          page: {
            id: '9',
            navigationId: 'nav-1',
            updatedAt: '2026-01-02T00:00:00.000Z',
            icon: 'mdi:file-document',
            title: 'Draft Title',
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
      // -> What a not-yet-caught-up debounced editor sync leaves behind: the dead `blob:` URL a
      //    pasted image is inserted as before its upload lands
      content: '![pasted](blob:http://localhost/abc123)',
      render: '<p><img src="blob:http://localhost/abc123"></p>'
    })
    // -> Stands in for the flusher `EditorMarkdown.vue` registers while mounted
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
    // -> `EditorAsciidoc.vue`'s flusher is genuinely asynchronous, because Asciidoctor's `convert`
    //    is (`renderers/asciidoc.js`)
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
