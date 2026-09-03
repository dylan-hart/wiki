import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { usePageStore } from './page.js'
import { useEditorStore } from './editor.js'
import { useSiteStore } from './site.js'
import { pagePathHash } from '@/helpers/pagePaths'

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

  it('normalizes an embedded space the same way the backend does before hashing (OpenProject #1933)', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse())

    const pageStore = usePageStore()
    await pageStore.pageLoad({ path: '/my page' })

    const [url] = API_CLIENT.get.mock.calls[0]
    // -> `normalizePagePath('/my page')` -> `'my-page'`, matching `backend/api/pages.ts`'s by-path
    //    lookup for the same input. A drifted local copy that skipped the whitespace-to-hyphen step
    //    would hash `'my page'` instead, resolving to a hash the server never assigns.
    expect(url).toBe(`sites/site-1/pages/${pagePathHash('my-page')}`)
  })

  /*
   * OpenProject #1785: `isStale` is the hook `Index.vue`'s route-path watcher passes so a slower,
   * now-superseded call's response cannot stomp whatever a faster, later navigation already wrote.
   * Driven directly here (rather than through a full `Index.vue` mount) to pin the store's own half
   * of the guard in isolation -- the watcher-level wiring gets its own coverage in `Index.test.js`.
   */
  describe('isStale guard (OpenProject #1785)', () => {
    it('performs no store write when isStale() is true once the response resolves', async () => {
      const siteStore = useSiteStore()
      siteStore.id = 'site-1'
      API_CLIENT.get.mockReturnValueOnce(
        stubPageResponse({ id: 'page-a', path: 'page-a', title: 'Page A' })
      )

      const pageStore = usePageStore()
      // -> A page already on screen, standing in for whatever a faster, later navigation already
      //    landed on -- asserted unchanged below.
      pageStore.$patch({ id: 'page-b', path: 'page-b', title: 'Page B' })

      await pageStore.pageLoad({ path: '/page-a', isStale: () => true })

      expect(pageStore.id).toBe('page-b')
      expect(pageStore.title).toBe('Page B')
    })

    it('does not throw ERR_PAGE_NOT_FOUND for a stale response, even when the page truly is missing', async () => {
      const siteStore = useSiteStore()
      siteStore.id = 'site-1'
      // -> The default stub shape: no `id` on the payload is what a 404 lookup resolves to
      //    (`pageLoad`'s own `!pageData?.id` check), which would normally throw.
      API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(undefined) })

      const pageStore = usePageStore()
      await expect(
        pageStore.pageLoad({ path: '/gone', isStale: () => true })
      ).resolves.toBeUndefined()
    })

    it('writes the store as usual when isStale() is false', async () => {
      const siteStore = useSiteStore()
      siteStore.id = 'site-1'
      API_CLIENT.get.mockReturnValueOnce(
        stubPageResponse({ id: 'page-a', path: 'page-a', title: 'Page A' })
      )

      const pageStore = usePageStore()
      await pageStore.pageLoad({ path: '/page-a', isStale: () => false })

      expect(pageStore.id).toBe('page-a')
      expect(pageStore.title).toBe('Page A')
    })

    it('writes the store as usual when isStale is omitted, unchanged for every other caller', async () => {
      const siteStore = useSiteStore()
      siteStore.id = 'site-1'
      API_CLIENT.get.mockReturnValueOnce(
        stubPageResponse({ id: 'page-a', path: 'page-a', title: 'Page A' })
      )

      const pageStore = usePageStore()
      await pageStore.pageLoad({ path: '/page-a' })

      expect(pageStore.id).toBe('page-a')
      expect(pageStore.title).toBe('Page A')
    })
  })
})

describe('page store: pageEdit()', () => {
  it('forwards the given locale to the pageLoad() request', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const editorStore = useEditorStore()
    // -> Already loaded, so pageEdit()'s own fetchConfigs() call doesn't add a second GET to the mock
    editorStore.$patch({ configIsLoaded: true })
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse())

    const pageStore = usePageStore()
    await pageStore.pageEdit({ path: '/some/page', locale: 'fr' })

    const [, opts] = API_CLIENT.get.mock.calls[0]
    expect(opts.searchParams).toEqual({ withContent: true, locale: 'fr' })
  })

  it('falls back to the store locale when none is given', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const editorStore = useEditorStore()
    editorStore.$patch({ configIsLoaded: true })
    API_CLIENT.get.mockReturnValueOnce(stubPageResponse())

    const pageStore = usePageStore()
    pageStore.$patch({ locale: 'de' })
    await pageStore.pageEdit({ path: '/some/page' })

    const [, opts] = API_CLIENT.get.mock.calls[0]
    expect(opts.searchParams).toEqual({ withContent: true, locale: 'de' })
  })
})

/** A site with two active locales, `en` primary — the shape `useLocales` and the prefix rule need. */
function makeMultiLocaleSite({ forcePrefix = false } = {}) {
  const siteStore = useSiteStore()
  siteStore.$patch({
    id: 'site-1',
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

describe('page store: pageAlias()', () => {
  it('returns the resolved id, path and locale', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue({ id: 'page-1', path: 'docs/target', locale: 'fr' })
    })

    const pageStore = usePageStore()
    const target = await pageStore.pageAlias('some-alias')

    expect(target).toEqual({ id: 'page-1', path: 'docs/target', locale: 'fr' })
  })

  it('throws ERR_PAGE_NOT_FOUND when nothing claims the alias', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({ json: vi.fn().mockResolvedValue(undefined) })

    const pageStore = usePageStore()
    await expect(pageStore.pageAlias('missing')).rejects.toThrow('ERR_PAGE_NOT_FOUND')
  })
})

describe('page store: pageCreate()', () => {
  /** A stand-in for the router the pinia plugin normally injects — see `stores/index.js`. */
  function stubRouter(currentPath = '/fr/some-page') {
    return {
      currentRoute: { value: { path: currentPath } },
      push: vi.fn()
    }
  }

  it('carries the current locale as ?locale= on the /_create push, on a multi-locale site', async () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    pageStore.$patch({ locale: 'fr' })

    await pageStore.pageCreate({ editor: 'markdown' })

    expect(pageStore.router.push).toHaveBeenCalledWith({
      path: '/_create/markdown',
      query: { locale: 'fr' }
    })
  })

  it('an explicit locale argument wins over the current page locale', async () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    pageStore.$patch({ locale: 'fr' })

    await pageStore.pageCreate({ editor: 'markdown', locale: 'en' })

    expect(pageStore.router.push).toHaveBeenCalledWith({
      path: '/_create/markdown',
      query: { locale: 'en' }
    })
  })

  it('sends no locale query on a single-locale site', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    pageStore.$patch({ locale: 'en' })

    await pageStore.pageCreate({ editor: 'markdown' })

    expect(pageStore.router.push).toHaveBeenCalledWith({
      path: '/_create/markdown',
      query: undefined
    })
  })

  it('does not push again when already navigating from the route watcher', async () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.router = stubRouter('/_create/markdown')
    pageStore.$patch({ locale: 'fr' })

    await pageStore.pageCreate({ editor: 'markdown', fromNavigate: true })

    expect(pageStore.router.push).not.toHaveBeenCalled()
  })

  /*
   * OpenProject #813: the breadcrumb bar's "Last modified" line now stays mounted through editing
   * and reads straight off this store, so a page being created has to actually blank these rather
   * than leave whatever a previous `pageLoad` left standing -- otherwise New Page from an existing
   * page (or a direct `/_create` visit right after browsing one) would report THAT page's save time
   * as its own.
   */
  it('blanks updatedAt and createdAt, not just whatever the previous page left behind', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.router = stubRouter('/_create/markdown')
    pageStore.$patch({
      updatedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2025-06-01T00:00:00.000Z'
    })

    await pageStore.pageCreate({ editor: 'markdown', fromNavigate: true })

    expect(pageStore.updatedAt).toBe('')
    expect(pageStore.createdAt).toBe('')
  })

  /**
   * Regression for OpenProject #816: `App.vue`'s router guard reads `editorStore.hasPendingChanges`
   * on every navigation, including `pageCreate()`'s own un-awaited `router.push()` into `/_create/...`
   * -- fired here from a call site standing in for the header's New Page menu, mid-edit on another
   * page. Left un-equalized, that OLD page's dirty state would still read true at the moment of this
   * navigation and the guard would prompt to discard changes belonging to a session `pageCreate()`
   * is about to overwrite regardless of the answer.
   */
  it('starts the new session clean (hasPendingChanges false), even when opened while another page is dirty', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const editorStore = useEditorStore()
    const pageStore = usePageStore()
    pageStore.router = stubRouter('/some/other/page')
    editorStore.$patch({
      isActive: true,
      lastSaveTimestamp: 'save-1',
      lastChangeTimestamp: 'change-1'
    })

    await pageStore.pageCreate({ editor: 'markdown' })

    expect(editorStore.hasPendingChanges).toBe(false)
  })

  /**
   * OpenProject #1092: a `format: 'markdown'` import's front-matter tags need somewhere to land --
   * `tags` used to be hardcoded to `[]` here regardless of what was passed in.
   */
  it('carries an explicit tags argument through, instead of always starting empty', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.router = stubRouter('/_create/markdown')

    await pageStore.pageCreate({ editor: 'markdown', tags: ['alpha', 'beta'] })

    expect(pageStore.tags).toEqual(['alpha', 'beta'])
  })

  it('defaults tags to an empty array when none is passed', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.router = stubRouter('/_create/markdown')

    await pageStore.pageCreate({ editor: 'markdown' })

    expect(pageStore.tags).toEqual([])
  })

  /**
   * OpenProject #1792: the page store's `state()` declares no `mode` -- that key belongs to
   * `editorStore`, which this same call already patches to `mode: 'create'`. A stray
   * `mode: 'edit'` on the page-store `$patch` used to grow the state with an untyped, unread
   * property asserting the post-save state at the moment a create session begins.
   */
  it('does not add a mode key to the page store state', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.router = stubRouter('/_create/markdown')

    await pageStore.pageCreate({ editor: 'markdown' })

    expect(pageStore.$state).not.toHaveProperty('mode')
  })
})

/**
 * OpenProject #1787: `pageDuplicate` called `this.pageCreate({...})` at the end of its try block with
 * no `await` and no `.catch` -- `pageCreate` is itself `async` and rejects readily (its first act is
 * `editorStore.fetchConfigs()`, a network call that rethrows on failure), so the rejection escaped
 * the enclosing try entirely and became an unhandled rejection nobody in `frontend/src` catches,
 * instead of reaching an awaiting caller (`PageActionsCol.vue`'s duplicate handler).
 */
describe('page store: pageDuplicate() (OpenProject #1787)', () => {
  function stubRouter(currentPath = '/_create/markdown') {
    return {
      currentRoute: { value: { path: currentPath } },
      push: vi.fn()
    }
  }

  it('rejects when the pageCreate it calls rejects, instead of resolving as if it had succeeded', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const pageStore = usePageStore()
    pageStore.router = stubRouter()

    // -> First call: the source-page fetch, which succeeds. Second call: `pageCreate`'s own
    //    `editorStore.fetchConfigs()` reaching for the site config, which fails -- this is the
    //    rejection that used to vanish as an unhandled rejection instead of reaching this awaiter.
    API_CLIENT.get
      .mockReturnValueOnce(stubPageResponse({ editor: 'markdown', content: 'hello' }))
      .mockReturnValueOnce({ json: vi.fn().mockRejectedValue(new Error('network down')) })

    await expect(
      pageStore.pageDuplicate({ sourcePageId: 'page-1', title: 'Copy', path: 'copy' })
    ).rejects.toThrow('network down')
  })
})

/**
 * A move can now change a page's locale as well as its path (backend task 8), which is why the
 * follow-link is built through `localizedPagePath` rather than as a bare `/${path}`: landing on an
 * unprefixed link to a page that now lives in a non-primary locale round-trips through locale
 * detection and shows whichever translation that picks, not the page just moved.
 */
describe('page store: pageMove()', () => {
  function stubRouter() {
    return { currentRoute: { value: { path: '/some-page' } }, replace: vi.fn() }
  }

  it('sends the locale in the body and follows the page into its new locale', async () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    pageStore.$patch({ id: 'page-1', locale: 'en', path: 'some-page' })

    await pageStore.pageMove({ id: 'page-1', path: 'some-page', locale: 'fr' })

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/path', {
      json: { path: 'some-page', locale: 'fr' }
    })
    expect(pageStore.router.replace).toHaveBeenCalledWith('/fr/some-page')
  })

  it('omits the locale when none is asked for, and follows the page within its own locale', async () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    pageStore.$patch({ id: 'page-1', locale: 'en', path: 'some-page' })

    await pageStore.pageMove({ id: 'page-1', path: 'elsewhere' })

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/path', {
      json: { path: 'elsewhere' }
    })
    // -> `en` is the primary locale, so it carries no prefix
    expect(pageStore.router.replace).toHaveBeenCalledWith('/elsewhere')
  })

  it('does not follow a page other than the one being viewed', async () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    pageStore.$patch({ id: 'page-1', locale: 'en', path: 'some-page' })

    await pageStore.pageMove({ id: 'page-2', path: 'elsewhere', locale: 'fr' })

    expect(pageStore.router.replace).not.toHaveBeenCalled()
  })

  it('sends includeTranslations when the caller asks for the cascade (OpenProject #1026)', async () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    pageStore.$patch({ id: 'page-1', locale: 'en', path: 'some-page' })

    await pageStore.pageMove({ id: 'page-1', path: 'elsewhere', includeTranslations: true })

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/path', {
      json: { path: 'elsewhere', includeTranslations: true }
    })
  })

  it('omits includeTranslations from the body when falsy', async () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    pageStore.$patch({ id: 'page-1', locale: 'en', path: 'some-page' })

    await pageStore.pageMove({ id: 'page-1', path: 'elsewhere', includeTranslations: false })

    expect(API_CLIENT.put).toHaveBeenCalledWith('sites/site-1/pages/page-1/path', {
      json: { path: 'elsewhere' }
    })
  })

  /**
   * OpenProject #1012: a move can change what an `auto`/`mixed` menu generates from the tree behind
   * an unchanged `navigationId` -- the moved page's new parent, its position among siblings -- with
   * nothing telling an already-open tab. Confirmed here with `siteStore.nav.currentId` ALREADY equal
   * to the id being force-refetched, which is exactly the case `fetchNavigation()`'s own "already
   * showing this menu" gate would otherwise skip.
   */
  it("force-refetches the currently viewed page's own nav menu after a move, even though the moved page is a different one entirely", async () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    const siteStore = useSiteStore()
    pageStore.router = stubRouter()
    // -> The page actually being viewed in this tab -- distinct from `page-1`, the one being moved.
    pageStore.$patch({ id: 'page-2', locale: 'en', path: 'viewed-page', navigationId: 'nav-1' })
    siteStore.nav.currentId = 'nav-1'

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ mode: 'static', items: [{ id: 'item-after-move' }] })
    })

    await pageStore.pageMove({ id: 'page-1', path: 'elsewhere' })

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(siteStore.nav.items).toEqual([{ id: 'item-after-move' }])
  })

  /**
   * OpenProject #1762: `unwrap()` used to compensate for `boot/api.js` resolving a 400 instead of
   * throwing. Now that a refusal is a real rejection (a ky `HTTPError`, with the server's message
   * under `.data.message`), the store must still surface that message on the thrown error's own
   * `.message` -- callers such as `PageActionsCol.vue` read `err.message` directly.
   */
  it('rejects with the server message when the move is refused', async () => {
    makeMultiLocaleSite()
    const pageStore = usePageStore()
    pageStore.router = stubRouter()
    pageStore.$patch({ id: 'page-1', locale: 'en', path: 'some-page' })

    const refusalErr = new Error('Bad Request')
    refusalErr.response = { status: 400 }
    refusalErr.data = { message: 'A page already exists at that path.' }
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.reject(refusalErr) })

    await expect(pageStore.pageMove({ id: 'page-1', path: 'taken' })).rejects.toThrow(
      'A page already exists at that path.'
    )
    expect(pageStore.router.replace).not.toHaveBeenCalled()
  })
})

describe('page store: pageRename()', () => {
  it('patches the title and, for the currently viewed page, updates the store', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    const pageStore = usePageStore()
    pageStore.$patch({ id: 'page-1', title: 'Old Title' })

    await pageStore.pageRename({ id: 'page-1', title: 'New Title' })

    expect(API_CLIENT.patch).toHaveBeenCalledWith('sites/site-1/pages/page-1', {
      json: { title: 'New Title' }
    })
    expect(pageStore.title).toBe('New Title')
  })

  it('rejects with the server message when the rename is refused', async () => {
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'

    const refusalErr = new Error('Bad Request')
    refusalErr.response = { status: 400 }
    refusalErr.data = { message: 'Title cannot be empty.' }
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.reject(refusalErr) })

    const pageStore = usePageStore()
    pageStore.$patch({ id: 'page-1', title: 'Old Title' })

    await expect(pageStore.pageRename({ id: 'page-1', title: '' })).rejects.toThrow(
      'Title cannot be empty.'
    )
    // -> A refused rename must not be applied optimistically.
    expect(pageStore.title).toBe('Old Title')
  })
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
