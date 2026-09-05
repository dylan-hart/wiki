import { defineStore } from 'pinia'

import { pick } from 'es-toolkit/object'

import { i18n } from '@/boot/i18n'
import { useSiteStore } from './site'
import { useEditorStore } from './editor'
import { useUserStore } from './user'
import { isHomePath, localizedPagePath, normalizePagePath, pagePathHash } from '@/helpers/pagePaths'
import { apiErrorBody, apiErrorMessage } from '@/helpers/apiError'
import { usePathDisplay } from '@/composables/pathDisplay'

/**
 * The icon a page starts with.
 *
 * An Iconify reference, so that the icon picker opens on its search tab with this one selected rather
 * than on the custom tab. Kept to a set seeded on every instance (`mdi`), so that it resolves without
 * an administrator having added anything.
 */
export const DEFAULT_PAGE_ICON = 'mdi:file-document-outline'

/**
 * A page response, shaped for `$patch`.
 *
 * Three actions apply a page the server just handed back -- `pageLoad`, `pageUnlock` and the tail of
 * `pageSave` -- and each has to do the same three things to it first: keep only the relation fields
 * this store models, keep only the two `tocDepth` bounds, and clear the password fields, which the
 * API never returns (OpenProject #2232) and which must therefore not be left holding the previous
 * page's -- or the just-saved -- typed value.
 */
function pagePatch(pageData) {
  return {
    ...pageData,
    relations: (pageData.relations ?? []).map((r) =>
      pick(r, ['id', 'position', 'label', 'caption', 'icon', 'target'])
    ),
    tocDepth: pick(pageData.tocDepth, ['min', 'max']),
    password: '',
    removePassword: false
  }
}

/**
 * The page fields shared by the two resets -- `pageNotFound` and `pageCreate`.
 *
 * Neither is showing a stored page, so every one of these has to stop saying whatever the previously
 * open page said. Each caller spreads this first and then states what IS true of its own case: a
 * page that does not exist is `notFound`, a page being created has a path, a title and content.
 */
const BLANK_PAGE = {
  id: '',
  path: '',
  title: '',
  description: '',
  icon: DEFAULT_PAGE_ICON,
  content: '',
  contentLoaded: false,
  render: '',
  tags: [],
  relations: [],
  publishState: '',
  // -> The server resolves the default (the parent page's own level, or the most-open configured
  //    one) when a create request omits it; blank here so neither reset shows the last page's level
  classification: '',
  // -> Nothing here should carry the previously-open page's typed-but-unsaved password value
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
     * Classification level id (OpenProject #1079). Empty on a page not loaded yet; on `pageCreate`
     * it stays empty deliberately -- the server resolves the default (the parent page's own level,
     * or the most-open configured one) when the create request omits it, rather than this store
     * guessing at a value the picker component has not shown yet.
     */
    classification: '',
    commentsCount: 0,
    content: '',
    /**
     * Whether `content` above is this page's actual source, rather than just the state it starts in.
     *
     * The API leaves `content` out of a page unless an editor asked for it and the session may see it,
     * so an empty string in this store means either "the page is empty" or "nobody fetched it" — and
     * `pageSave` must not write the second one over a page that has content. See the guard there.
     */
    contentLoaded: false,
    createdAt: '',
    description: '',
    editor: '',
    icon: DEFAULT_PAGE_ICON,
    id: '',
    isBrowsable: true,
    /**
     * Whether the server withheld this page's body because it is password protected and this reader
     * has not entered the password. `render`, `toc` and `content` are empty while it is set — the API
     * never sent them — so nothing here can display a locked page by mistake.
     */
    isLocked: false,
    isSearchable: true,
    locale: 'en',
    navigationId: null,
    navigationMode: 'inherit',
    /**
     * Whether the path in the URL has no page at all. Set by `pageNotFound`, which empties everything
     * else here at the same time — so this being true means the store holds the *absence* of a page,
     * not a page that failed to load with the previous one's title and body still in it.
     */
    notFound: false,
    /**
     * A new password to protect the page with, in plaintext, never a value the server sent back
     * (OpenProject #2232 -- the API only ever hashes this and never returns it again, see
     * `hasPassword`). Empty means "no change" on save unless `removePassword` is also set; the server
     * hashes whatever is typed here before it touches the database.
     */
    password: '',
    /** Whether the page currently has a password set, as the server last reported it. Informational
     *  only -- `password` above is what actually changes it on save. */
    hasPassword: false,
    /**
     * Set when the password toggle is turned off in the editor, to tell `pageSave` this save means
     * "take the password off", distinct from "the field was never touched" -- which `password` alone
     * cannot say once the server stopped echoing the current value back (OpenProject #2232).
     */
    removePassword: false,
    path: '',
    publishEndDate: '',
    publishStartDate: '',
    publishState: '',
    relations: [],
    render: '',
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
     * Whether this reader may suggest edits to this page, i.e. an enabled approval rule covers it and
     * names a group they are in. Answered by the server, since neither the rules nor the reader's
     * groups are known here — and left false until it does, so the button never flashes into view on
     * a page that turns out not to take suggestions.
     */
    canSuggestEdits: false,
    /** Whether the reader already has a suggestion open on this page, which they would carry on with. */
    hasOpenSuggestion: false,
    /**
     * What became of this reader's most recently resolved suggestion on this page, if a reviewer has
     * acted on one -- `{ status: 'approved' | 'declined', reason: string | null, resolvedAt }`, or
     * null while nothing of theirs has been resolved yet, or for a guest. `hasOpenSuggestion` going
     * false on its own says nothing about what happened; this is the return leg.
     */
    resolvedSubmission: null,
    /** Whether this reader reviews this page, which is what shows the review button on it. */
    canReview: false,
    /** The suggestions waiting on this page, oldest first. Empty for everybody who is not its reviewer. */
    pendingSubmissions: [],
    /**
     * Whether this reader has asked to be told about changes to this page. Always false for a guest:
     * a watch belongs to an account, which is what a notification would eventually be sent to.
     */
    isWatching: false,
    /**
     * Who else already has this page open in a live collaboration room, on the instance that answered
     * this request — a same-instance approximation, not a cluster-wide count. What lets the editor say
     * "N other people have this page open" before a collab session of its own has even started; see
     * `EditorMarkdown.vue`. Always `{ count: 0, names: [] }` on a site without collaborative editing.
     */
    activeEditors: { count: 0, names: [] },
    /**
     * An unsaved draft recorded when this page's collaboration room last closed with edits still
     * pending (OpenProject #2455) -- `{ updatedAt, authorName }`, or `null` when there is none. What
     * `composables/collab.js` offers to restore once its session syncs. Content is not carried here;
     * it is fetched only once the reader actually chooses to restore it.
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
        //    for a segment with no real title of its own (Feature #2574) -- see `usePathDisplay()`.
        title: humanize(value),
        icon: 'la:file-alt',
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
     * Where to send someone who is leaving the editor on this page.
     *
     * Its own path, except for a redirection, which is held on arrival: whoever just wrote down where
     * this page sends people is the one person who does not want to be sent there. `?redirect=no` is
     * what holds it — see `PageRedirect.vue` — and the screen it lands on offers to follow it.
     *
     * Carries the page's own locale prefix, same rule as `breadcrumbs` — this is a real navigation
     * target (`router.replace` lands on it directly), so an unprefixed link to a non-primary-locale
     * page would round-trip through the locale-detection default and land on the wrong translation.
     */
    editorExitPath: (state) => {
      const siteStore = useSiteStore()
      const path = localizedPagePath(state.path, state.locale, siteStore.localeRouting)
      return `${path}${state.editor === 'redirect' ? '?redirect=no' : ''}`
    }
  },
  actions: {
    /**
     * PAGE - LOAD
     *
     * @param {object} args
     * @param {() => boolean} [args.isStale] Checked once the request resolves, before the store is
     *   touched at all -- a caller that can start a second, overlapping load for a different target
     *   (`Index.vue`'s route-path watcher, navigating A -> B while A is still in flight) passes this
     *   so a slower, now-superseded response cannot stomp whatever a faster, later one already wrote.
     *   Every other caller leaves it unset and keeps the unconditional write this always had
     *   (OpenProject #1785).
     */
    async pageLoad({ path, id, withContent = false, locale, isStale }) {
      const editorStore = useEditorStore()
      const siteStore = useSiteStore()
      /*
        The lock, and the absence of a page, belong to the page being loaded rather than to the one
        before it.

        Everything else in this store stays put until the reply arrives, deliberately -- blanking it
        would flash an empty page on every navigation. These two cannot be treated that way: they are
        read as "the page on screen is protected" and "there is no page on screen", and left standing
        they make the NEXT page look protected, or missing, for as long as the request takes.
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
              //    the site's primary one -- see `parseLocalePrefix` in `helpers/pagePaths.js` for
              //    where this comes from.
              ...(locale ? { locale } : {})
            }
          }
        ).json()
        // -> Bail before any of it: not just the $patch below, but also the not-found throw, which
        //    would otherwise send a stale ERR_PAGE_NOT_FOUND back to a caller that has already moved
        //    on (`Index.vue`'s catch branch guards its own end independently, but there is no reason
        //    to raise a superseded error at all).
        if (isStale?.()) {
          return
        }
        if (!pageData?.id) {
          throw new Error('ERR_PAGE_NOT_FOUND')
        }
        // Update page store
        this.$patch({
          ...pagePatch(pageData),
          // -> The field is present exactly when the source came with the page, which is what makes
          //    the copy in this store safe to save; a view-mode load leaves the previous one in place
          contentLoaded: Object.hasOwn(pageData, 'content')
        })
        this.applyViewerState(pageData.viewer)
        // -> Nothing has been typed into this freshly-loaded page yet
        editorStore.markClean()
      } catch (err) {
        // -> A missing page is an ordinary outcome, not a failure: it is what puts a new instance in
        //    front of the welcome screen, and what offers to create the page anywhere else
        if (err.response?.status === 404) {
          throw new Error('ERR_PAGE_NOT_FOUND')
        }
        /*
          Nor is a page the reader may not open: the group rules say so deliberately, and the reader
          is owed the unauthorized screen -- which offers signing in as somebody else -- rather than
          an error banner over an empty page view.
        */
        if (err.response?.status === 403) {
          throw new Error('ERR_PAGE_UNAUTHORIZED')
        }
        console.warn(err)
        throw err
      }
    },
    /**
     * PAGE - UNLOCK
     *
     * Hands a password for a protected page to the server, which answers with the page — body
     * included — when it matches. The reply is what fills the content in, rather than this store
     * flipping `isLocked` and re-reading a page it already had: there is nothing here to unlock, the
     * body was never sent.
     *
     * The server also remembers the unlock for the session, so navigating away and back does not ask
     * again.
     *
     * @param {string} password
     * @throws When the password is wrong (401) or the request fails; the caller reports it.
     */
    async pageUnlock(password) {
      const siteStore = useSiteStore()
      const pageData = await API_CLIENT.post(`sites/${siteStore.id}/pages/${this.id}/unlock`, {
        json: { password }
      }).json()
      this.$patch({
        ...pagePatch(pageData),
        contentLoaded: Object.hasOwn(pageData, 'content')
      })
    },
    /**
     * PAGE - WATCH / UNWATCH
     *
     * Asks to be told about changes to this page, or stops asking.
     *
     * The store is moved first and put back if the server refuses. A bell that waits for a round trip
     * before it rings is a bell that feels broken, and the request behind it either succeeds or is
     * worth an error — there is no third outcome to leave the button guessing at.
     *
     * @throws Whatever the request failed with, for the caller to report.
     */
    async pageWatch(watching) {
      const siteStore = useSiteStore()
      const previous = this.isWatching
      this.isWatching = watching
      try {
        const url = `sites/${siteStore.id}/pages/${this.id}/watch`
        await (watching ? API_CLIENT.put(url) : API_CLIENT.delete(url))
      } catch (err) {
        this.isWatching = previous
        console.warn(err)
        throw err
      }
    },
    /**
     * PAGE - APPLY VIEWER STATE
     *
     * Takes in the `viewer` block the page came with: what this reader may do here, whether they may
     * suggest an edit, and what they have to review on this page. The page view used to ask three
     * further endpoints for exactly this, each of which loaded the page again to answer — so the one
     * request now settles what the whole view draws.
     *
     * The page permissions go to the user store, which is where everything reads them from: they are
     * the reader's, not the page's, and `userStore.can()` consults them for the path in front of them.
     *
     * @param viewer Absent from a page that came back from a save or an unlock, which changes none of
     *               this — so nothing here is touched in that case.
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
     * PAGE - NOT FOUND
     *
     * Puts the store in front of a path that has no page, so that the view can offer to create one.
     *
     * A load that fails leaves the previous page standing — see `pageLoad`, where that is on purpose —
     * and for a path with nothing behind it that means the reader is left reading the page they came
     * from under a URL that is not its own. So everything the page view draws is emptied here, and
     * `path` becomes the one that was asked for — the only thing about a page that does not exist that
     * is actually known, and what the create button goes on to make a page at.
     *
     * @param {string} path The path that was requested, with or without its leading slash.
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
     * PAGE - RESOLVE ALIAS
     *
     * Returns the `{ id, path, locale }` the alias points at -- the locale as well as the bare path,
     * so the caller can build a properly-prefixed link (`localizedPagePath`) instead of landing on
     * the primary-locale default for a translation that isn't. `routes.js`'s `/a/:alias` is the only
     * caller.
     */
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
        console.warn(err)
        throw err
      }
    },
    /**
     * PAGE - CREATE
     */
    async pageCreate({
      editor,
      locale,
      path,
      basePath,
      title = '',
      description = '',
      tags = [],
      content = '',
      fromNavigate = false
    } = {}) {
      const editorStore = useEditorStore()
      const siteStore = useSiteStore()

      // -> Load editor config
      await editorStore.ensureConfigs()

      // -> Path normalization
      if (path?.startsWith('/')) {
        path = path.substring(1)
      }
      if (basePath?.startsWith('/')) {
        basePath = basePath.substring(1)
      }
      if (basePath?.endsWith('/')) {
        basePath = basePath.substring(0, basePath.length - 1)
      }

      // -> Redirect if not at /_create path
      if (!this.router.currentRoute.value.path.startsWith('/_create/') && !fromNavigate) {
        editorStore.$patch({ ignoreRouteChange: true })
        /*
          `/_create` has no page segment of its own to carry a locale in, so the app router's own
          locale-prefix guard (`App.vue`'s `beforeEach`, via `resolveRouteLocale`) would otherwise
          reset `pageStore.locale` to the site's primary the instant this navigation resolves --
          overwriting whatever gets patched in below before anything downstream can read it back.
          Carrying it here, as `?locale=`, is what that guard falls back to instead. Skipped for a
          single-locale site, where that guard never runs at all.
        */
        const createLocale = locale || this.locale
        this.router.push({
          path: `/_create/${editor}`,
          query: siteStore.useLocales && createLocale ? { locale: createLocale } : undefined
        })
      }

      /*
        -> Init editor
        `lastChangeTimestamp`/`lastSaveTimestamp` are equalized here the same way `pageLoad()` and
        `pageSuggest()` already do for their own fresh sessions -- this one starts with nothing typed
        into it yet. Without this, calling `pageCreate()` while already editing another page dirty
        (the header's New Page menu, mid-edit) would leave `hasPendingChanges` still reading that OLD
        page's pending state. The `router.push()` above is not awaited, so this synchronous patch runs
        (and clears it) before `App.vue`'s router guard -- which only runs once that push's own promise
        machinery gets a turn -- ever gets to read `hasPendingChanges` for this navigation.
      */
      editorStore.markClean({
        originPageId: editorStore.isActive ? editorStore.originPageId : this.id, // Don't replace if already in edit mode
        isActive: true,
        mode: 'create',
        editor
      })

      // -> Default Page Path
      let newPath = path
      if (!path && path !== '') {
        const parentPath =
          basePath || basePath === '' ? basePath : this.path.split('/').slice(0, -1).join('/')
        newPath = parentPath ? `${parentPath}/new-page` : 'new-page'
      }

      // -> Set Default Page Data
      this.$patch({
        ...BLANK_PAGE,
        id: 0,
        locale: locale || this.locale,
        path: newPath,
        /*
          The editor is a field of the page being written, not just of the editor holding it: anything
          asking what KIND of page is on screen reads it here. Left unset, the store kept the last
          page's answer -- so opening a new page from a redirection said it was one too.
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
        /*
          A redirection is browsable like any other page and findable in none: a search result for one
          would stand in front of the page the reader actually wanted. The server settles this either
          way -- see `createPage` in `models/pages.ts` -- so this is the store agreeing with it rather
          than deciding it.
        */
        isSearchable: editor !== 'redirect',
        /*
          Neither is real yet, so both are blanked rather than left as whatever `pageLoad` last put
          here -- unblanked, a page created from an existing one (the header's New Page button, a
          direct `/_create` visit, `pageDuplicate`) would report THAT page's last-saved and created
          times as its own (OpenProject #813: the breadcrumb bar now stays up during editing and reads
          this).
        */
        updatedAt: '',
        createdAt: ''
      })
    },
    /**
     * PAGE - DUPLICATE
     */
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
        //    readily (its first act is `editorStore.fetchConfigs()`, a network request that rethrows
        //    on failure) -- left un-awaited, that rejection escaped this try entirely and became an
        //    unhandled rejection nobody in `frontend/src` catches (OpenProject #1787).
        await this.pageCreate({
          editor: pageData.editor,
          title,
          path,
          content: pageData.content,
          description: pageData.description
        })
      } catch (err) {
        console.warn(err)
        throw err
      }
    },
    /**
     * PAGE - SUGGEST EDITS
     *
     * Opens the editor on a suggestion rather than on the page. The source comes from the suggestion
     * endpoint rather than from the page: it hands back whatever this reader already suggested, so
     * that coming back to the button carries on from where they left off, and it is also the only way
     * an anonymous reader gets the source at all.
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
    /**
     * PAGE - SUBMIT SUGGESTED EDITS
     *
     * @param {object} [guest] Name and email, required when nobody is logged in
     */
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
    /**
     * PAGE - EDIT
     */
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
          A hash only identifies a page within a locale (`pageLoad`'s own comment above), so an editor
          entry point addressed by path has to carry one along too -- `this.locale` is what App.vue's
          router guard already resolved from `?locale=` for this route, or the site's primary when
          none was given, so an un-migrated caller still gets today's behavior.
        */
        loadArgs.locale = locale ?? this.locale
      } else {
        loadArgs.id = this.id
      }

      /*
        Edits made OUTSIDE the editor have to survive opening it.

        The page properties panel writes straight to this store, and the header then offers to save
        them — so a page can arrive here with a changed title and an unchanged everything else. A full
        load would replace every field with what is stored and reset the change timestamps, throwing
        those edits away without a word. The source is the only thing missing in that state, so the
        source is the only thing fetched.
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
     * PAGE - LOAD SOURCE ONLY
     *
     * Fetches the source and nothing else, for opening the editor on a page whose other fields have
     * already been edited elsewhere. Deliberately touches neither the rest of the page nor the editor's
     * change timestamps: what is pending stays pending, and stays saveable.
     */
    async pageLoadSource() {
      const siteStore = useSiteStore()
      try {
        const pageData = await API_CLIENT.get(`sites/${siteStore.id}/pages/${this.id}`, {
          searchParams: { withContent: true }
        }).json()
        // -> Absent rather than empty means the server withheld it; see `contentLoaded`
        if (!Object.hasOwn(pageData ?? {}, 'content')) {
          throw new Error('ERR_PAGE_SOURCE_UNAVAILABLE')
        }
        this.$patch({
          content: pageData.content,
          contentLoaded: true
        })
      } catch (err) {
        console.warn(err)
        throw err
      }
    },
    /**
     * PAGE - MOVE
     */
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
        throw new Error(apiErrorMessage(err, 'An unexpected error occured.'))
      }
      // -> Following the page only makes sense when it is the one being viewed. Moved from the file
      //    manager, it is some other page, and the reader is still on theirs.
      if (id === this.id) {
        // -> Through `localizedPagePath` rather than a bare `/${path}`: a move can now change the
        //    page's locale, and an unprefixed link to a non-primary-locale page round-trips through
        //    locale detection and lands on whichever translation that picks.
        this.router.replace(localizedPagePath(path, locale ?? this.locale, siteStore.localeRouting))
      }
      /*
        OpenProject #1012: a move does not touch the page's own `navigationId` (`movePage()` never
        writes it), but it CAN change what an `auto`/`mixed` menu generates from the tree behind that
        same unchanged id -- the moved page's new parent folder, its position among siblings -- with
        nothing on the backend to tell an already-open tab. Force-refetches whatever menu THIS tab's
        currently viewed page resolves to, whether or not that is the page that got moved: a no-op
        re-fetch of unrelated, still-correct data when it isn't, the fix itself when it is.
      */
      await siteStore.fetchNavigation(this.navigationId, true)
    },
    /**
     * PAGE - Rename
     */
    async pageRename({ id, title } = {}) {
      const siteStore = useSiteStore()
      try {
        await API_CLIENT.patch(`sites/${siteStore.id}/pages/${id}`, {
          json: { title }
        }).json()
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'An unexpected error occured.'))
      }

      // Update page store
      if (id === this.id) {
        this.$patch({ title })
      }
    },
    /**
     * PAGE SAVE
     */
    async pageSave() {
      const editorStore = useEditorStore()
      const siteStore = useSiteStore()
      try {
        /*
          Read the mounted editor directly before anything below touches `content`/`render`.

          The editor only syncs those into this store on a 500ms debounce (see `EditorMarkdown.vue`'s
          `onDidChangeModelContent` handler), so a save issued right after an edit -- pasting an image
          and saving immediately, before that debounce has fired, is what surfaced this (OpenProject
          #806) -- could otherwise read a stale pair here and send a dead `blob:` URL to the server.
          `contentFlusher` is a read-through the editor registers while it is mounted; a save with no
          editor mounted (a scripted call, for instance) leaves it null and this is a no-op. Awaited
          rather than called bare: `EditorMarkdown.vue`'s own flusher is synchronous and resolves
          immediately either way, but `EditorAsciidoc.vue`'s is genuinely asynchronous -- Asciidoctor's
          `convert` is (`renderers/asciidoc.js`) -- and a save that read `render` before that settled
          would send up the render from before this edit. Deliberately does not touch `contentLoaded`
          itself -- that stays exactly what the load or a real edit set it to, which is what the guard
          just below is reading.
        */
        await editorStore.contentFlusher?.()

        // -> The render goes up with the content: the markdown pipeline runs here, in the editor, and
        //    what the preview shows is what gets stored. The server post-processes it — sanitizing it
        //    against what this author may embed, and deriving the table of contents — so the page it
        //    returns is the authority on what was actually saved.
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
            'showSidebar',
            'showTags',
            'showToc',
            'tags',
            'title',
            'tocDepth'
          ]),
          /*
            Not a page field: it describes the save rather than the page, and the server records it on
            the history version this save produces. Collected by the reason-for-change dialog before
            `pageSave` is called, and cleared below once it has gone up.
          */
          reasonForChange: editorStore.reasonForChange ?? ''
        }

        /*
          The password is write-only and never round-trips from the server (OpenProject #2232), so
          unlike every other field above it cannot simply be picked off `this` -- an untouched field
          reads as `''` here whether the page has a password or not, and sending that on every save
          would silently strip one every time an author changed the title. Sent only on an actual
          intent: a new value to hash and store, or an explicit removal from the password toggle
          being turned off (`toggleRequirePassword` in `PagePropertiesDialog.vue`). Anything else
          omits the key entirely, which `updatePage` reads as "leave the stored password alone".
        */
        if (this.password) {
          body.password = this.password
        } else if (this.removePassword) {
          body.password = ''
        }

        /*
          Never save a source this store never received.

          An editor that came up empty because the source was withheld — an expired session, a failed
          load — is indistinguishable from an empty page by the time the payload is built, and sending
          the empty string replaces the stored HTML's source with nothing. Dropping the key instead
          leaves it exactly as it was: `updatePage` only writes `content` when it is not `undefined`.

          Typing into an editor sets the flag, so deliberately clearing a page still works — that empty
          string came from the author, not from a load that never happened. A page being created always
          has it set, which is also why this cannot leave the POST short of a required field.
        */
        if (!this.contentLoaded) {
          delete body.content
          console.warn('Page source was never loaded; saving without touching the stored content.')
        }
        /*
          OpenProject #1079: an unset classification on create means "let the server pick the
          default" (the parent page's own level, or the most-open configured one) -- an empty string
          would fail the API's uuid format validation, so this is dropped rather than sent. A page
          already loaded always has a real value here (the server never omits it), so this never
          fires on a save that is not a create.
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
              with. The server compares this against what it actually has stored and refuses the
              write on a mismatch -- see the 409 branch below -- which is what stops one editor's
              save from silently overwriting another's.
            */
            json: { ...body, expectedUpdatedAt: this.updatedAt }
          }).json()
          pageData = resp?.page
          if (!pageData?.id) {
            throw new Error('ERR_PAGE_NOT_FOUND')
          }
          // -> OpenProject #1080: only ever present on an update that raised the page's own
          //    classification and left descendants below the new floor -- see the PATCH route.
          classificationConflicts = resp?.classificationConflicts ?? []
        }

        const wasCreate = editorStore.mode === 'create'

        // -> Whatever was just sent has already been written, so `pagePatch`'s password reset is
        //    what stops a plaintext secret sitting there, pending, past the save it was for
        this.$patch(pagePatch(pageData))

        /*
          OpenProject #1012: a newly created page can change what an `auto`/`mixed` menu generates
          from the tree -- it is a new entry, not an edit to one already there -- with nothing on the
          backend to tell an already-open tab. `this.navigationId` is already the just-created page's
          own (`this.$patch()` above just applied it, from the server's `models/tree.ts`-assigned
          value), which is exactly the menu the reader is about to land on via `editorExitPath` below
          -- an ordinary content update (`wasCreate` false) never adds or removes a tree entry, so it
          is left alone rather than force-refetching on every save.
        */
        if (wasCreate) {
          await siteStore.fetchNavigation(this.navigationId, true)
        }

        /*
          Ahead of the create-mode navigation just below: `App.vue`'s router guard reads
          `hasPendingChanges` on every navigation, including this one, so the save has to register as
          clean before it navigates anywhere -- done after, this internal redirect would read as
          leaving the editor with unsaved changes and prompt to discard the very save that just
          succeeded.
        */
        editorStore.markClean({ reasonForChange: '' })

        if (editorStore.mode === 'create') {
          editorStore.$patch({ mode: 'edit' })
          /*
            Awaited, because the caller closes the editor the moment this resolves. An unawaited
            navigation leaves one render of the page view at the route the EDITOR was on -- which for
            a redirection is a page that reads its own query to decide whether to follow itself, sees
            the editor's route, and takes its author to the target they just typed in.
          */
          await this.router.replace(this.editorExitPath)
        }

        return { classificationConflicts }
      } catch (err) {
        /*
          Somebody else saved this page first. The server's reply carries the page as it now stands
          -- see the `expectedUpdatedAt` mismatch handling in `PATCH /sites/:siteId/pages/:pageId`
          -- which is handed to the editor store rather than reported as an ordinary failure: there is
          a page to react to here, not just an error to show. `EditorMarkdown.vue` watches it to put
          up the resolution dialog.
        */
        if (err.response?.status === 409) {
          editorStore.saveConflict = apiErrorBody(err)?.page ?? null
          throw new Error('ERR_SAVE_CONFLICT')
        }
        console.warn(err)
        /*
          A refused write (ky's `HTTPError`, identified the same way the 409 branch above does --
          via `.response`) carries the server's real message under `.data.message`, not in `.message`
          itself -- so it is converted here before rethrowing. The store's own plain `Error`s thrown
          just above (`ERR_CREATED_PAGE_NOT_FOUND`, `ERR_PAGE_NOT_FOUND`) and a `contentFlusher`
          failure both already carry the message a caller should show, and pass through unchanged.
        */
        throw err.response ? new Error(apiErrorMessage(err, 'An unexpected error occured.')) : err
      }
    },
    async cancelPageEdit() {
      const editorStore = useEditorStore()
      await this.pageLoad({ id: editorStore.originPageId ? editorStore.originPageId : this.id })
      // -> Awaited for the same reason as in `pageSave`: the editor closes when this resolves
      await this.router.replace(this.editorExitPath)
    }
  }
})
