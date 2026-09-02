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

describe('page store: pageUnlock()', () => {
  /**
   * The password the reader just typed to get in is not the page's stored one, and the response
   * carries no `password` back to overwrite it with (the API only ever hashes it -- OpenProject
   * #2232). Unlocking used to leave it sitting in the store, where the next save would have sent it
   * as a password change; `pagePatch()` clears it the same way `pageLoad` and `pageSave` always did.
   */
  it('clears the typed password and the remove flag once the page is unlocked', async () => {
    const pageStore = usePageStore()
    const siteStore = useSiteStore()

    siteStore.id = 'site-1'
    pageStore.$patch({ id: 'page-1', password: 'hunter2', removePassword: true })

    API_CLIENT.post.mockReturnValueOnce(
      stubPageResponse({ id: 'page-1', title: 'Locked Page', content: 'secret' })
    )

    await pageStore.pageUnlock('hunter2')

    expect(pageStore.title).toBe('Locked Page')
    expect(pageStore.contentLoaded).toBe(true)
    expect(pageStore.password).toBe('')
    expect(pageStore.removePassword).toBe(false)
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
      json: () => Promise.resolve([{ id: 'item-after-move' }])
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
