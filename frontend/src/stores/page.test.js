import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { usePageStore } from './page.js'
import { useEditorStore } from './editor.js'
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
    conflictErr.response = {
      status: 409,
      json: () => Promise.resolve({ ok: false, message: 'conflict', page: conflictSnapshot })
    }
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

    await expect(pageStore.pageSave()).resolves.toBeUndefined()

    const [, retryOpts] = API_CLIENT.patch.mock.calls[1]
    expect(retryOpts.json.expectedUpdatedAt).toBe(conflictSnapshot.updatedAt)
    expect(retryOpts.json.content).toBe("this author's unsaved edit")
    expect(pageStore.content).toBe("this author's unsaved edit")
    expect(pageStore.updatedAt).toBe('2026-01-01T05:00:01.000Z')
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
