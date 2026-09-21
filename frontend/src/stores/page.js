import { defineStore } from 'pinia'

import { pick } from 'es-toolkit/object'

import { i18n } from '@/boot/i18n'
import { useSiteStore } from './site'
import { useEditorStore } from './editor'
import { useUserStore } from './user'
import { isHomePath, localizedPagePath, normalizePagePath, pagePathHash } from '@/helpers/pagePaths'
import { apiErrorBody, apiErrorMessage } from '@/helpers/apiError'
import { log } from '@/helpers/log'
import { duplicatedPageProps } from '@/helpers/duplicatedPageProps'
import { usePathDisplay } from '@/composables/pathDisplay'

/**
 * An Iconify reference rather than a custom one, so the picker opens on its search tab with this
 * selected, and from a set seeded on every instance so it resolves before an administrator adds one.
 */
export const DEFAULT_PAGE_ICON = 'tabler:file-text'

const PAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The password fields are write-only -- the API never returns them -- so they are cleared rather
 * than carried over: left standing they hold the previous page's, or the just-saved, typed value.
 * `pages.icon` is nullable and an empty one renders as nothing, so the default stands in for it.
 */
function pagePatch(pageData) {
  return {
    ...pageData,
    icon: pageData.icon || DEFAULT_PAGE_ICON,
    relations: (pageData.relations ?? []).map((r) =>
      pick(r, ['id', 'position', 'label', 'caption', 'icon', 'target'])
    ),
    tocDepth: pick(pageData.tocDepth, ['min', 'max']),
    password: '',
    removePassword: false
  }
}

/**
 * Spread by `pageNotFound` and `pageCreate`, neither of which is showing a stored page: every field
 * here has to stop saying whatever the previously open page said.
 */
const BLANK_PAGE = {
  id: '',
  path: '',
  title: '',
  description: '',
  icon: DEFAULT_PAGE_ICON,
  savedIcon: DEFAULT_PAGE_ICON,
  savedTitle: '',
  content: '',
  contentLoaded: false,
  render: '',
  scriptJsLoad: '',
  scriptJsUnload: '',
  scriptCss: '',
  tags: [],
  relations: [],
  publishState: '',
  classification: '',
  revision: null,
  password: '',
  hasPassword: false,
  removePassword: false,
  notFound: false
}

export const usePageStore = defineStore('page', {
  state: () => ({
    alias: '',
    allowComments: false,
    allowContributions: true,
    authorId: 0,
    authorName: '',
    /**
     * Empty means "let the server resolve the default" -- the parent page's own level, or the
     * most-open configured one -- which is what `pageCreate` leaves it as rather than guessing.
     */
    classification: '',
    commentsCount: 0,
    content: '',
    /**
     * The API omits `content` unless an editor asked for it and the session may see it, so an empty
     * string means either "the page is empty" or "nobody fetched it" -- `pageSave` guards on this.
     */
    contentLoaded: false,
    createdAt: '',
    description: '',
    editor: '',
    icon: DEFAULT_PAGE_ICON,
    /**
     * The pre-edit baseline `pageSave()`'s `navDisplayChanged` compares against, and only ever set
     * from a server response: `icon`/`title` above are bound live into `PagePropertiesDialog.vue`
     * and `PageHeader.vue`, so by the time Save is clicked they already hold the new value and
     * comparing them is always "new vs. new".
     */
    savedIcon: DEFAULT_PAGE_ICON,
    savedTitle: '',
    id: '',
    isBrowsable: true,
    /**
     * `render`, `toc` and `content` are empty while this is set — the API never sent them for a
     * password-protected page this reader has not unlocked — so nothing can draw one by mistake.
     */
    isLocked: false,
    isSearchable: true,
    locale: 'en',
    navigationId: null,
    navigationMode: 'inherit',
    notFound: false,
    /**
     * Plaintext, and never a value the server sent back: the API only ever hashes this and never
     * returns it (see `hasPassword`). Empty means "no change" unless `removePassword` is also set.
     */
    password: '',
    /** Informational only -- `password` above is what actually changes it on save. */
    hasPassword: false,
    /**
     * Says this save means "take the password off", distinct from "the field was never touched" --
     * which `password` alone cannot say when the server never echoes the current value back.
     */
    removePassword: false,
    path: '',
    publishEndDate: '',
    publishStartDate: '',
    publishState: '',
    relations: [],
    render: '',
    /**
     * `scriptJsLoad`/`scriptJsUnload` run once this page loads and just before it is torn down,
     * `scriptCss` is injected as a `<style>`. Changing any of them needs `write:scripts`/
     * `write:styles` ON THIS PAGE -- page-scoped, so `userStore.pagePermissions`, not `can()`.
     */
    scriptJsLoad: '',
    scriptJsUnload: '',
    scriptCss: '',
    showSidebar: true,
    showTags: true,
    showToc: true,
    tags: [],
    title: '',
    toc: [],
    tocDepth: {
      min: 1,
      max: 2
    },
    updatedAt: '',
    /**
     * `{ ordinal, changeCount, via: 'editor' | 'mcp' }`, riding the page read rather than costing
     * the metadata rail a request of its own. `null` is what a requester without `read:history`
     * gets -- "not allowed to know", not "no history" -- and `changeCount` is likewise absent rather
     * than zero with nothing to diff against. Never default either to a number.
     */
    revision: null,
    /**
     * Whether an enabled approval rule covers this page and names a group this reader is in --
     * server-answered, and false until it answers, so the button never flashes into view on a page
     * that takes no suggestions.
     */
    canSuggestEdits: false,
    hasOpenSuggestion: false,
    /**
     * `{ status: 'approved' | 'declined', reason: string | null, resolvedAt }`, or null for a guest
     * and while nothing of theirs has been resolved. `hasOpenSuggestion` going false says nothing
     * about what happened; this is the return leg.
     */
    resolvedSubmission: null,
    canReview: false,
    /** Oldest first, and empty for everybody who is not this page's reviewer. */
    pendingSubmissions: [],
    /** Always false for a guest: a watch belongs to an account, which is what gets notified. */
    isWatching: false,
    /**
     * Bumped only once a `pageWatch()` request has resolved, never on the optimistic flip ahead of
     * it: `isWatching` changes before the write commits, so a watcher-list re-fetch keyed on that
     * races the PUT/DELETE and gets back the state from before the click.
     */
    watchersRevision: 0,
    /**
     * A same-instance approximation of who else has this page open in a live collaboration room --
     * the instance that answered the request, not a cluster-wide count.
     */
    activeEditors: { count: 0, names: [] },
    /**
     * `{ updatedAt, authorName }` for edits left pending when this page's collaboration room last
     * closed, or `null`. The content is fetched only once the reader chooses to restore it.
     */
    draft: null
  }),
  getters: {
    breadcrumbs: (state) => {
      const siteStore = useSiteStore()
      const { humanize } = usePathDisplay()
      const segments = state.path.split('/')
      return segments.map((value, key) => ({
        id: key,
        // -> A deliberate override when the site's path-display setting is on, not just a fallback
        //    for a segment with no real title of its own -- see `usePathDisplay()`.
        title: humanize(value),
        icon: 'tabler:file-text',
        locale: state.locale,
        path: localizedPagePath(
          segments.slice(0, key + 1).join('/'),
          state.locale,
          siteStore.localeRouting
        )
      }))
    },
    folderPath: (state) => {
      return state.path.split('/').slice(0, -1).join('/')
    },
    isHome: (state) => {
      return isHomePath(state.path)
    },
    /**
     * The page's own path, except for a redirection, which is held on arrival: whoever just wrote
     * down where this page sends people is the one person who does not want to be sent there
     * (`?redirect=no`, see `PageRedirect.vue`). Locale-prefixed because this is a real navigation
     * target -- unprefixed, it round-trips through locale detection and lands on the wrong one.
     */
    editorExitPath: (state) => {
      const siteStore = useSiteStore()
      const path = localizedPagePath(state.path, state.locale, siteStore.localeRouting)
      return `${path}${state.editor === 'redirect' ? '?redirect=no' : ''}`
    }
  },
  actions: {
    /**
     * @param {object} args
     * @param {() => boolean} [args.isStale] Checked once the request resolves, before the store is
     *   touched at all, so a caller that can start a second, overlapping load (navigating A -> B
     *   while A is in flight) is not stomped by the slower, superseded response. Unset leaves the
     *   write unconditional.
     */
    async pageLoad({ path, id, withContent = false, locale, isStale }) {
      const editorStore = useEditorStore()
      const siteStore = useSiteStore()
      /*
        The lock, and the absence of a page, belong to the page being loaded rather than the one
        before it. Everything else stays put until the reply arrives -- blanking it would flash an
        empty page on every navigation -- but these two read as "protected" and "not there", and
        left standing they say that about the NEXT page for as long as the request takes.
      */
      this.isLocked = false
      this.notFound = false
      try {
        const pageData = await API_CLIENT.get(
          `sites/${siteStore.id}/pages/${id ?? pagePathHash(normalizePagePath(path) || 'home')}`,
          {
            searchParams: {
              withContent,
              // -> A hash only identifies a page within a locale; omitted, the server falls back to
              //    the site's primary one.
              ...(locale ? { locale } : {})
            }
          }
        ).json()
        // -> Ahead of the not-found throw as well as the `$patch` below: a superseded load has no
        //    reason to raise `ERR_PAGE_NOT_FOUND` at a caller that has already moved on.
        if (isStale?.()) {
          return
        }
        if (!pageData?.id) {
          throw new Error('ERR_PAGE_NOT_FOUND')
        }
        const patchedPage = pagePatch(pageData)
        this.$patch({
          ...patchedPage,
          savedIcon: patchedPage.icon,
          savedTitle: patchedPage.title,
          // -> Present, not truthy: an empty string is a real empty page, not a withheld one
          contentLoaded: Object.hasOwn(pageData, 'content'),
          /*
            Stated rather than left to the spread above: the server omits the key entirely for a
            reader without `read:history` on the page, and a spread that does not carry it leaves
            the PREVIOUS page's ordinal standing in the rail, against a page it says nothing about.
          */
          revision: pageData.revision ?? null
        })
        this.applyViewerState(pageData.viewer)
        editorStore.markClean()
      } catch (err) {
        // -> A missing page is an ordinary outcome, not a failure: it is what puts a new instance in
        //    front of the welcome screen, and what offers to create the page anywhere else
        if (err.response?.status === 404) {
          throw new Error('ERR_PAGE_NOT_FOUND')
        }
        /*
          Nor is a page the reader may not open: they are owed the unauthorized screen, which offers
          signing in as somebody else, rather than an error banner over an empty page view.
        */
        if (err.response?.status === 403) {
          throw new Error('ERR_PAGE_UNAUTHORIZED')
        }
        log.warn('page', 'could not load the page', err)
        throw err
      }
    },
    /**
     * The reply is what fills the content in, rather than this store flipping `isLocked` and
     * re-reading a page it already had: there is nothing here to unlock, the body was never sent.
     * The server remembers the unlock for the session, so going away and back does not ask again.
     */
    async pageUnlock(password) {
      const siteStore = useSiteStore()
      const pageData = await API_CLIENT.post(`sites/${siteStore.id}/pages/${this.id}/unlock`, {
        json: { password }
      }).json()
      const patchedPage = pagePatch(pageData)
      this.$patch({
        ...patchedPage,
        savedIcon: patchedPage.icon,
        savedTitle: patchedPage.title,
        contentLoaded: Object.hasOwn(pageData, 'content')
      })
    },
    /**
     * Optimistic: the store is moved first and put back if the server refuses, because a bell that
     * waits for a round trip before it rings is a bell that feels broken. The response is applied
     * on top all the same, so the server has the last word rather than the guess.
     */
    async pageWatch(watching) {
      const siteStore = useSiteStore()
      const previous = this.isWatching
      this.isWatching = watching
      try {
        const url = `sites/${siteStore.id}/pages/${this.id}/watch`
        const resp = await (watching ? API_CLIENT.put(url) : API_CLIENT.delete(url)).json()
        this.isWatching = resp?.isWatching ?? watching
        this.watchersRevision++
      } catch (err) {
        this.isWatching = previous
        log.warn('page', 'could not change whether this page is being watched', err)
        throw err
      }
    },
    /**
     * The page permissions go to the user store rather than staying here: they are the reader's,
     * not the page's, and `userStore.can()` consults them for the path in front of them.
     *
     * @param viewer Absent from a page that came back from a save or an unlock, which changes none
     *               of this — so nothing here is touched in that case.
     */
    applyViewerState(viewer) {
      if (!viewer) {
        return
      }
      const userStore = useUserStore()
      userStore.$patch({ pagePermissions: viewer.permissions ?? [] })
      this.$patch({
        canSuggestEdits: viewer.canSuggestEdits === true,
        hasOpenSuggestion: viewer.hasOpenSuggestion === true,
        resolvedSubmission: viewer.resolvedSubmission ?? null,
        canReview: viewer.canReview === true,
        pendingSubmissions: viewer.pendingSubmissions ?? [],
        isWatching: viewer.isWatching === true,
        activeEditors: viewer.activeEditors ?? { count: 0, names: [] },
        draft: viewer.draft ?? null
      })
    },
    /**
     * A failed load leaves the previous page standing (`pageLoad`, deliberately), which for a path
     * with nothing behind it means reading the page you came from under a URL that is not its own.
     * So everything the page view draws is emptied here, and `path` becomes the one asked for.
     *
     * @param {string} path With or without its leading slash.
     */
    pageNotFound({ path }) {
      this.$patch({
        ...BLANK_PAGE,
        path: (path ?? '').replace(/^\/+/, ''),
        toc: [],
        createdAt: '',
        updatedAt: '',
        isLocked: false,
        canSuggestEdits: false,
        hasOpenSuggestion: false,
        resolvedSubmission: null,
        canReview: false,
        pendingSubmissions: [],
        isWatching: false,
        activeEditors: { count: 0, names: [] },
        draft: null,
        notFound: true
      })
    },
    /**
     * Returns the locale as well as the path, so the caller can build a properly-prefixed link
     * instead of landing on the primary-locale default for a translation that isn't.
     */
    async pageVersionById(versionId) {
      const siteStore = useSiteStore()
      return API_CLIENT.get(`sites/${siteStore.id}/versions/${versionId}`).json()
    },
    async pageAlias(alias) {
      const siteStore = useSiteStore()
      try {
        const target = await API_CLIENT.get(`sites/${siteStore.id}/pages/alias/${alias}`).json()
        if (!target?.id) {
          throw new Error('ERR_PAGE_NOT_FOUND')
        }
        return target
      } catch (err) {
        if (err.response?.status === 404) {
          throw new Error('ERR_PAGE_NOT_FOUND')
        }
        log.warn('page', 'could not resolve the page alias', err)
        throw err
      }
    },
    async pageById(id) {
      const siteStore = useSiteStore()
      if (!PAGE_ID_PATTERN.test(id)) {
        throw new Error('ERR_PAGE_NOT_FOUND')
      }
      try {
        const target = await API_CLIENT.get(`sites/${siteStore.id}/pages/${id}`).json()
        if (!target?.id) {
          throw new Error('ERR_PAGE_NOT_FOUND')
        }
        return target
      } catch (err) {
        if (err.response?.status === 404) {
          throw new Error('ERR_PAGE_NOT_FOUND')
        }
        log.warn('page', 'could not resolve the page by id', err)
        throw err
      }
    },
    async pageCreate({
      editor,
      locale,
      path,
      basePath,
      title = '',
      description = '',
      tags = [],
      content = '',
      carry = {},
      fromNavigate = false
    } = {}) {
      const editorStore = useEditorStore()
      const siteStore = useSiteStore()

      await editorStore.ensureConfigs()

      if (path?.startsWith('/')) {
        path = path.substring(1)
      }
      if (basePath?.startsWith('/')) {
        basePath = basePath.substring(1)
      }
      if (basePath?.endsWith('/')) {
        basePath = basePath.substring(0, basePath.length - 1)
      }

      if (!this.router.currentRoute.value.path.startsWith('/_create/') && !fromNavigate) {
        editorStore.$patch({ ignoreRouteChange: true })
        /*
          `/_create` has no page segment of its own to carry a locale in, so `App.vue`'s
          locale-prefix guard would otherwise reset `pageStore.locale` to the site's primary the
          instant this navigation resolves, overwriting whatever gets patched in below. `?locale=`
          is that guard's fallback. Skipped for a single-locale site, where it never runs at all.
        */
        const createLocale = locale || this.locale
        this.router.push({
          path: `/_create/${editor}`,
          query: siteStore.useLocales && createLocale ? { locale: createLocale } : undefined
        })
      }

      /*
        This session starts with nothing typed into it, so both timestamps are equalized -- opening
        a create while already editing another page dirty otherwise leaves `hasPendingChanges`
        reading that OLD page's state. The `router.push()` above is not awaited, so this synchronous
        patch clears it before `App.vue`'s router guard reads it for that navigation.
      */
      editorStore.markClean({
        originPageId: editorStore.isActive ? editorStore.originPageId : this.id,
        isActive: true,
        mode: 'create',
        editor
      })

      let newPath = path
      if (!path && path !== '') {
        const parentPath =
          basePath || basePath === '' ? basePath : this.path.split('/').slice(0, -1).join('/')
        newPath = parentPath ? `${parentPath}/new-page` : 'new-page'
      }

      const carriedProps = { ...carry }
      if (!carriedProps.icon) {
        delete carriedProps.icon
      }

      this.$patch({
        ...BLANK_PAGE,
        id: 0,
        locale: locale || this.locale,
        path: newPath,
        /*
          Also a field of the page being written, not just of the editor holding it: anything asking
          what KIND of page is on screen reads it here. Left unset, the store keeps the last page's
          answer -- so a new page opened from a redirection would say it is one too.
        */
        editor,
        title: title ?? '',
        description: description ?? '',
        alias: '',
        publishState: 'published',
        tags: tags ?? [],
        content: content ?? '',
        // -> A page being created has no stored source to lose: whatever it starts with IS the source
        contentLoaded: true,
        isBrowsable: true,
        allowComments: true,
        /*
          A redirection is browsable like any other page and findable in none: a search result for
          one would stand in front of the page the reader actually wanted. The server settles this
          either way, so this is the store agreeing with it rather than deciding it.
        */
        isSearchable: editor !== 'redirect',
        /*
          Neither is real yet, so both are blanked rather than left as whatever `pageLoad` last put
          here -- unblanked, a page created from an existing one would report THAT page's created
          and last-saved times as its own in the breadcrumb bar, which stays up during editing.
        */
        updatedAt: '',
        createdAt: '',
        ...carriedProps
      })
    },
    async pageDuplicate({ sourcePageId, title, path }) {
      const siteStore = useSiteStore()
      try {
        const pageData = await API_CLIENT.get(
          `sites/${siteStore.id}/pages/${sourcePageId ?? this.id}`,
          { searchParams: { withContent: true } }
        ).json()
        if (!pageData?.id) {
          throw new Error('ERR_PAGE_NOT_FOUND')
        }
        // -> Awaited so this call's own catch owns the failure: `pageCreate` is async and rejects
        //    readily (its first act fetches the editor configs over the network), and un-awaited
        //    that rejection escapes this try and becomes an unhandled rejection nobody catches.
        await this.pageCreate({
          editor: pageData.editor,
          title,
          path,
          content: pageData.content,
          carry: duplicatedPageProps(pageData)
        })
      } catch (err) {
        log.warn('page', 'could not duplicate the page', err)
        throw err
      }
    },
    /**
     * The source comes from the suggestion endpoint rather than from the page: it hands back
     * whatever this reader already suggested, so coming back carries on from where they left off.
     */
    async pageSuggest() {
      const editorStore = useEditorStore()
      const siteStore = useSiteStore()

      const resp = await API_CLIENT.get(`sites/${siteStore.id}/pages/${this.id}/suggestions/self`, {
        searchParams: { withContent: true }
      }).json()
      if (!resp?.canSubmit) {
        throw new Error('ERR_SUGGESTIONS_NOT_ALLOWED')
      }

      this.$patch({
        content: resp.content ?? '',
        contentLoaded: true,
        canSuggestEdits: true,
        hasOpenSuggestion: Boolean(resp.submission)
      })

      await editorStore.ensureConfigs()

      editorStore.markClean({
        isActive: true,
        mode: 'suggest',
        editor: this.editor
      })
    },
    /** `guestName`/`guestEmail` are required when nobody is logged in. */
    async pageSubmitSuggestion({ guestName, guestEmail } = {}) {
      const siteStore = useSiteStore()
      const resp = await API_CLIENT.put(`sites/${siteStore.id}/pages/${this.id}/suggestions/self`, {
        json: {
          content: this.content,
          ...(guestName ? { guestName } : {}),
          ...(guestEmail ? { guestEmail } : {})
        }
      }).json()
      this.hasOpenSuggestion = true
      return resp.submission
    },
    async pageEdit({ path, id, locale, fromNavigate = false } = {}) {
      const editorStore = useEditorStore()

      const loadArgs = {
        withContent: true
      }

      if (id) {
        loadArgs.id = id
      } else if (path) {
        loadArgs.path = path
        /*
          A path lookup needs a locale (see `pageLoad`); `this.locale` is what `App.vue`'s router
          guard resolved from `?locale=`, or the site's primary when none was given.
        */
        loadArgs.locale = locale ?? this.locale
      } else {
        loadArgs.id = this.id
      }

      /*
        Edits made OUTSIDE the editor have to survive opening it: the page properties panel writes
        straight to this store, and a full load would replace every field with what is stored and
        reset the change timestamps, throwing those edits away without a word. The source is the
        only thing missing in that state, so the source is the only thing fetched.
      */
      if (editorStore.hasPendingChanges) {
        await this.pageLoadSource()
      } else {
        await this.pageLoad(loadArgs)
      }

      await editorStore.ensureConfigs()

      editorStore.$patch({
        isActive: true,
        mode: 'edit',
        editor: this.editor
      })
    },
    /**
     * Deliberately touches neither the rest of the page nor the editor's change timestamps: what is
     * pending stays pending, and stays saveable.
     */
    async pageLoadSource() {
      const siteStore = useSiteStore()
      try {
        const pageData = await API_CLIENT.get(`sites/${siteStore.id}/pages/${this.id}`, {
          searchParams: { withContent: true }
        }).json()
        // -> Absent rather than empty means the server withheld it (locked, or no `read:source` grant
        //    on this page) -- see `contentLoaded`
        if (!Object.hasOwn(pageData ?? {}, 'content')) {
          throw new Error('ERR_PAGE_SOURCE_UNAVAILABLE')
        }
        this.$patch({
          content: pageData.content,
          contentLoaded: true
        })
      } catch (err) {
        log.warn('page', 'could not load the page source', err)
        throw err
      }
    },
    async pageMove({ id, title, path, locale, includeTranslations } = {}) {
      const siteStore = useSiteStore()
      try {
        await API_CLIENT.put(`sites/${siteStore.id}/pages/${id}/path`, {
          json: {
            path,
            ...(title ? { title } : {}),
            ...(locale ? { locale } : {}),
            ...(includeTranslations ? { includeTranslations } : {})
          }
        }).json()
      } catch (err) {
        throw new Error(apiErrorMessage(err, i18n.global.t('common.error.unexpected')))
      }
      // -> Following the page only makes sense when it is the one being viewed. Moved from the file
      //    manager, it is some other page, and the reader is still on theirs.
      if (id === this.id) {
        // -> A move can change the page's locale, and an unprefixed link round-trips through locale
        //    detection and lands on whichever translation that picks.
        this.router.replace(localizedPagePath(path, locale ?? this.locale, siteStore.localeRouting))
      }
      /*
        A move never writes the page's own `navigationId`, but it CAN change what an `auto`/`mixed`
        menu generates from the tree behind that same id -- the new parent folder, the position
        among siblings -- with nothing on the backend to tell an already-open tab. So THIS tab's
        menu is force-refetched either way: a no-op when the moved page is not the one on screen.
      */
      await siteStore.fetchNavigation(this.navigationId, true)
    },
    async pageRename({ id, title } = {}) {
      const siteStore = useSiteStore()
      try {
        await API_CLIENT.patch(`sites/${siteStore.id}/pages/${id}`, {
          json: { title }
        }).json()
      } catch (err) {
        throw new Error(apiErrorMessage(err, i18n.global.t('common.error.unexpected')))
      }

      if (id === this.id) {
        this.$patch({ title })
      }
    },
    /**
     * Only carries the flip to the server: `PageConvertDialog.vue`'s render-equality guard has
     * already run client-side.
     */
    async convertEditor({ id, editor } = {}) {
      const siteStore = useSiteStore()
      let page
      try {
        ;({ page } = await API_CLIENT.put(`sites/${siteStore.id}/pages/${id}/editor`, {
          json: { editor }
        }).json())
      } catch (err) {
        throw new Error(apiErrorMessage(err, i18n.global.t('common.error.unexpected')))
      }

      if (id === this.id) {
        this.$patch({ editor: page.editor })
      }
    },
    async pageSave() {
      const editorStore = useEditorStore()
      const siteStore = useSiteStore()
      try {
        /*
          Read the mounted editor before anything below touches `content`/`render`: the editor only
          syncs those into this store on a 500ms debounce, so a save issued right after an edit --
          pasting an image and saving immediately -- could otherwise send a dead `blob:` URL. A
          read-through the editor registers while mounted, so null with none mounted. Awaited
          because `EditorAsciidoc.vue`'s is genuinely asynchronous and would settle after the read.
        */
        await editorStore.contentFlusher?.()

        // -> The render goes up with the content: the pipeline runs here, in the editor, and what
        //    the preview shows is what gets stored. The server post-processes it — sanitizing
        //    against what this author may embed, deriving the ToC — so its reply is the authority.
        const body = {
          ...pick(this, [
            'alias',
            'allowComments',
            'allowContributions',
            'classification',
            'content',
            'description',
            'icon',
            'isBrowsable',
            'isSearchable',
            'publishEndDate',
            'publishStartDate',
            'publishState',
            'relations',
            'render',
            'scriptCss',
            'scriptJsLoad',
            'scriptJsUnload',
            'showSidebar',
            'showTags',
            'showToc',
            'tags',
            'title',
            'tocDepth'
          ]),
          /*
            Not a page field: it describes the save rather than the page, and the server records it
            on the history version this save produces. Cleared below once it has gone up.
          */
          reasonForChange: editorStore.reasonForChange ?? ''
        }

        /*
          The password is write-only and never round-trips, so unlike every other field above it
          cannot simply be picked off `this`: an untouched field reads as `''` whether the page has
          a password or not, and sending that on every save would strip one every time an author
          changed the title. Sent only on a real intent -- a new value, or the toggle being turned
          off -- and otherwise omitted, which `updatePage` reads as "leave the stored one alone".
        */
        if (this.password) {
          body.password = this.password
        } else if (this.removePassword) {
          body.password = ''
        }

        /*
          Never save a source this store never received. An editor that came up empty because the
          source was withheld is indistinguishable from an empty page by then, and sending the empty
          string replaces the stored source with nothing; dropping the key leaves it as it was,
          since `updatePage` only writes `content` when it is defined. Typing sets the flag, so
          clearing a page deliberately still works, and a create always has it set.
        */
        if (!this.contentLoaded) {
          delete body.content
          log.warn('page', 'the page source was never loaded; saving without touching it')
        }
        /*
          An unset classification on create means "let the server pick the default"; an empty string
          would fail the API's uuid format validation, so the key is dropped rather than sent. A page
          already loaded always has a real value, so this only ever fires on a create.
        */
        if (!this.classification) {
          delete body.classification
        }

        let pageData
        let classificationConflicts = []
        if (editorStore.mode === 'create') {
          const resp = await API_CLIENT.post(`sites/${siteStore.id}/pages`, {
            json: {
              ...body,
              locale: this.locale,
              path: this.path,
              editor: editorStore.editor
            }
          }).json()
          pageData = resp?.page
          if (!pageData?.id) {
            throw new Error('ERR_CREATED_PAGE_NOT_FOUND')
          }
        } else {
          const resp = await API_CLIENT.patch(`sites/${siteStore.id}/pages/${this.id}`, {
            /*
              Not a page field either, and not sent on create: there is nothing yet to conflict
              with. The server refuses the write on a mismatch -- the 409 branch below -- which is
              what stops one editor's save from silently overwriting another's.
            */
            json: { ...body, expectedUpdatedAt: this.updatedAt }
          }).json()
          pageData = resp?.page
          if (!pageData?.id) {
            throw new Error('ERR_PAGE_NOT_FOUND')
          }
          // -> Only ever present on an update that raised the page's own classification and left
          //    descendants below the new floor.
          classificationConflicts = resp?.classificationConflicts ?? []
        }

        const wasCreate = editorStore.mode === 'create'

        /*
          `NavSidebarItem.vue` draws a cached tree entry's icon and title from the nav-tree response,
          not from a live page fetch, so a save that changes either leaves the sidebar on the
          pre-save glyph until something unrelated forces a refetch. Against `savedIcon`/`savedTitle`
          rather than the live pair, which already holds the new value by then, and against the
          normalized `icon`, so a `''` -> default fallback is not a change.
        */
        const patchedPage = pagePatch(pageData)
        const navDisplayChanged =
          !wasCreate &&
          (patchedPage.icon !== this.savedIcon || patchedPage.title !== this.savedTitle)

        this.$patch({
          ...patchedPage,
          savedIcon: patchedPage.icon,
          savedTitle: patchedPage.title,
          /*
            A save moves the page along its own history and the response deliberately carries no
            `revision` (history data, present only on a page fetched on its own), so what this store
            holds is one version out of date the moment the write lands. Absence is what the wire
            format means by "unknown"; reporting the pre-save count as current would be a lie.
          */
          revision: null
        })

        /*
          A newly created page is a new tree entry, so an `auto`/`mixed` menu generates something
          different from it, with nothing on the backend to tell an already-open tab --
          `this.navigationId` is by now the created page's own, which is the menu the reader is
          about to land on. An ordinary content update adds or removes no entry and is left alone,
          except when it changed what an existing entry *displays* (`navDisplayChanged` above).
        */
        if (wasCreate || navDisplayChanged) {
          await siteStore.fetchNavigation(this.navigationId, true)
        }

        /*
          Ahead of the create-mode navigation just below: `App.vue`'s router guard reads
          `hasPendingChanges` on every navigation, so done after, this internal redirect reads as
          leaving the editor unsaved and prompts to discard the very save that just succeeded.
        */
        editorStore.markClean({ reasonForChange: '' })

        if (editorStore.mode === 'create') {
          /*
            This create session is committing, so `originPageId` must not outlive it -- left set, a
            later, unrelated edit-mode discard's `cancelPageEdit()` would load this stale origin
            page instead of the page being edited.
          */
          editorStore.$patch({ mode: 'edit', originPageId: '' })
          /*
            Awaited, because the caller closes the editor the moment this resolves. Unawaited, one
            render of the page view happens at the route the EDITOR was on -- which for a
            redirection reads its own query, sees that route, and follows itself to the new target.
          */
          await this.router.replace(this.editorExitPath)
        }

        return { classificationConflicts }
      } catch (err) {
        /*
          Somebody else saved this page first. The reply carries the page as it now stands, handed
          to the editor store rather than reported as an ordinary failure: there is a page to react
          to, not just an error. `EditorMarkdown.vue` watches it to put up the resolution dialog.
        */
        if (err.response?.status === 409) {
          editorStore.saveConflict = apiErrorBody(err)?.page ?? null
          throw new Error('ERR_SAVE_CONFLICT')
        }
        log.warn('page', 'could not save the page', err)
        /*
          A refused write (ky's `HTTPError`, identified by `.response` as the 409 branch above does)
          carries the server's real message under `.data.message`, not `.message`, so it is
          converted before rethrowing. The store's own plain `Error`s above already carry the
          message a caller should show and pass through unchanged.
        */
        throw err.response
          ? new Error(apiErrorMessage(err, i18n.global.t('common.error.unexpected')))
          : err
      }
    },
    async cancelPageEdit() {
      const editorStore = useEditorStore()
      await this.pageLoad({ id: editorStore.originPageId ? editorStore.originPageId : this.id })
      // -> Awaited: the caller closes the editor the moment this resolves
      await this.router.replace(this.editorExitPath)
    }
  }
})
