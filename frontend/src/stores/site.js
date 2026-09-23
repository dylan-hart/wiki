import { defineStore } from 'pinia'

import { sortBy } from 'es-toolkit/array'

import { log } from '@/helpers/log'

/**
 * Real engines ship two shapes: Chrome/Chromium implements `Intl.Locale.prototype.getTextInfo()` as
 * a METHOD (what the "Intl Locale Info" proposal settled on), while Node exposes the earlier draft's
 * `.textInfo` GETTER, which Chrome lacks entirely. Reading `.textInfo.direction` alone therefore
 * throws in a browser and `describeLocales`'s `try/catch` swallows it into `isRTL: false` for every
 * locale -- a loss of `dir="rtl"` no Vitest run can catch, since those execute against Node's shape.
 */
function textDirection(locale) {
  if (typeof locale.getTextInfo === 'function') {
    return locale.getTextInfo().direction
  }
  return locale.textInfo?.direction
}

/**
 * The API stores and returns `locales.active` as bare codes -- that is what the admin screen writes
 * back and what the server validates against its installed set -- but everything that displays a
 * locale needs a name for it. Resolving here keeps the write shape a plain list of codes, and
 * `Intl.DisplayNames` gives the name in the reader's own language for free; asking for a code's name
 * IN that code is what produces the native spelling. `isRTL` comes from `Intl.Locale`'s own
 * CLDR-backed direction info rather than a second `/_api/locales` round trip on every page load.
 */
function describeLocales(codes) {
  const localized = new Intl.DisplayNames(undefined, { type: 'language' })

  return (codes ?? []).map((code) => {
    let name = code
    let nativeName = code
    let isRTL = false
    try {
      name = localized.of(code) ?? code
      nativeName = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code
      isRTL = textDirection(new Intl.Locale(code)) === 'rtl'
    } catch {
      // -> An unregistered or malformed tag throws rather than returning nothing; show the code and
      //    fall back to left-to-right
    }
    return {
      code,
      language: code.split('-')[0],
      name,
      nativeName,
      isRTL
    }
  })
}

export const useSiteStore = defineStore('site', {
  state: () => ({
    id: null,
    hostname: '',
    /** Keyed by provider key (`google`, `gtm`, `matomo`, ...) — see `backend/modules/analytics/*`. */
    analytics: {
      providers: {}
    },
    company: '',
    contentLicense: '',
    footerExtra: '',
    banner: {
      isEnabled: false,
      title: '',
      content: ''
    },
    title: '',
    description: '',
    logoText: true,
    /**
     * Whether the Puppeteer extension is installed -- instance-wide, not something a site
     * configures, so the export UI can disable the PDF option rather than offer a control that
     * would always 503.
     */
    pdfExportAvailable: false,
    /**
     * This site's enabled blocks, keyed by tag, as `{ id, isCustom }`. Carried on the public
     * site-info response so `Index.vue`'s block-loading scan can resolve a custom block's import URL
     * without the `manage:sites`-gated `GET /sites/:siteId/blocks`, which a reader who is not also
     * an author gets refused.
     */
    blocksIndex: {},
    /**
     * Non-null only when this site's active comment provider is a `codeTemplate` one
     * (Disqus/Commento/Artalk): `{ module, title, config, origin }`. `origin` is computed
     * server-side from the request that served this payload, never re-derived here. See
     * `models/commentProviders.ts` for the permission/canonical-URL contract.
     */
    commentsProvider: null,
    /**
     * Lowercase and without the dot. A path ending in one of them addresses the page underneath it
     * -- `/foo/bar.md` is `/foo/bar` -- both for links inside pages and for requests reaching the
     * server.
     */
    pageExtensions: [],
    search: '',
    searchLastQuery: '',
    searchIsLoading: false,
    showSideNav: true,
    showSidebar: true,
    overlay: null,
    overlayOpts: {},
    features: {
      browse: false,
      collaborativeEditing: false,
      comments: false,
      notes: true,
      /**
       * The site-wide execution kill switch for per-page scripts/styles. Off by default, same
       * rationale as `comments` above: a consumer should have a real `false` to gate on before the
       * backend's site-info response ever overrides it.
       */
      pageScripts: false,
      profile: false,
      reasonForChange: 'required',
      search: false,
      /**
       * True only when BOTH `CARDINAL.capabilities.semanticSearch` (boot-time pgvector
       * availability) AND this site's own `search.semanticEnabled` setting are. False here so
       * `Search.vue`'s Keyword/Semantic toggle stays hidden until the site-info response says
       * otherwise, rather than flashing on for an instant on a slow fetch.
       */
      semanticSearch: false,
      showOtherGroups: false
    },
    auth: {
      /**
       * Send a logged-out visitor straight to the login screen instead of the unauthorized page,
       * which on a wiki closed to the public is a dead end with a login button on it.
       */
      bypassUnauthorized: false
    },
    editors: {
      asciidoc: false,
      code: false,
      markdown: false,
      wysiwyg: false
    },
    /*
      Whether an optional, system-wide extension is installed -- key -> boolean, from
      `GET system/extensions/status`. Unlike `editors` above, this has nothing to do with any one
      site's config: it is what gates a feature that needs a tool this instance may not have.
      Fetched lazily via `fetchExtensionsStatus`, same cached-until-asked-again shape as
      `tags` / `tagsLoaded` below.
    */
    extensionsStatus: {},
    extensionsStatusLoaded: false,
    locales: {
      primary: 'en',
      showMenu: true,
      active: [
        {
          code: 'en',
          language: 'en',
          name: 'English',
          nativeName: 'English',
          isRTL: false
        }
      ]
    },
    tags: [],
    tagsLoaded: false,
    /**
     * The Header Search "Popular Tags" widget's own, narrower list: at most 10 tags, ranked by
     * 60-day content activity rather than `tags`' all-time usage count. Deliberately separate
     * state/fetch from `tags`/`tagsLoaded`/`fetchTags()` above, which stay the complete, unlimited,
     * all-time list the tag-edit autocomplete and the browse/search screens need.
     */
    popularTags: [],
    popularTagsLoaded: false,
    /**
     * The case style applied to a path-derived label at every render site -- breadcrumbs,
     * sidebar/tree nav, auto-nav, a page's own heading -- via
     * `composables/pathDisplay.js#usePathDisplay()`. `'off'` leaves every one of them unchanged.
     */
    pathDisplayCase: 'off',
    /**
     * Lowercase surface form -> canonical display casing (`GET sites/:siteId/glossary/acronyms`),
     * consulted by `usePathDisplay()`'s humanizer so "uss" renders as "USS" rather than the case
     * style's own guess. Fetched lazily by `fetchAcronymMap`, triggered from `applySiteInfo` only
     * when `pathDisplayCase` is not `'off'`. Both fields are per-site and are reset on every site
     * load, so a switch never renders the previous site's casing.
     */
    acronymMap: {},
    acronymMapLoaded: false,
    /**
     * The pre-load shape, before `applySiteInfo` overwrites it with the real site config. The color
     * fields are literal hex rather than `var(--color-*)` on purpose: they mirror
     * `backend/models/sites.ts`'s `DEFAULT_THEME_COLORS` seed, so a fresh install and a
     * not-yet-loaded site both start on Cardinal's own colors rather than an arbitrary CSS
     * fallback. A seed value, not a token consumer.
     */
    theme: {
      dark: false,
      injectCSS: '',
      injectHead: '',
      injectBody: '',
      colorPrimary: '#c14a52',
      colorSecondary: '#3f7a66',
      colorAccent: '#c14a52',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7',
      codeBlocksTheme: '',
      contentWidth: 'measured',
      sidebarPosition: 'left',
      tocPosition: 'right',
      showPrintBtn: true,
      baseFont: 'barlow',
      contentFont: 'barlow'
    },
    sideDialogShown: false,
    sideDialogComponent: '',
    /**
     * Base URL every in-app "view docs" / help link is built from -- always server-provided
     * (`CARDINAL.config.docsBase`, from `backend/base.yml`), so this holds no hardcoded fallback: it
     * reads as `''` until `applySiteInfo` (via `loadSite` or `bootstrap`) fills it in.
     */
    docsBase: '',
    /** Instance-wide, not per-site; same always-server-provided shape as `docsBase` above. */
    isReplicationEnabled: false,
    /**
     * Instance-wide, and the only way a guest's browser learns it: `GET users/profile-visibility`
     * needs `read:users`. Decides whether a guest's avatars are clickable at all.
     */
    guestsMayViewProfiles: false,
    /**
     * This site's default menu id for its default locale -- always server-provided, same as
     * `docsBase` above. What a route with no page-inherited `navigationId` of its own (the knowledge
     * graph, tags browse) falls back to, instead of leaving the sidebar with nothing to load.
     */
    navigationId: null,
    nav: {
      currentId: null,
      items: [],
      mode: 'static',
      /** The generator's own root for the current `auto`/`mixed` menu -- what a root-level "create
       *  here" action targets, since a page/folder-level override's own root is not always the
       *  locale root. Meaningless for a `static` menu. */
      rootPath: '',
      rootId: null,
      inFlightId: null
    }
  }),
  getters: {
    overlayIsShown: (state) => Boolean(state.overlay),
    sideNavIsDisabled: (state) => Boolean(state.theme.sidebarPosition === 'off'),
    useLocales: (state) => {
      return state.locales?.active?.length > 1
    },
    /** The exact quad `shouldPrefixLocale` / `localizedPagePath` take. */
    localeRouting() {
      return {
        useLocales: this.useLocales,
        primary: this.locales.primary,
        forcePrefix: this.locales.forcePrefix,
        aliases: this.locales.aliases ?? {}
      }
    }
  },
  actions: {
    /**
     * `MainOverlayDialog.vue` forwards `overlayOpts` to the mounted component as a prop, so a new
     * overlay reads its initial params off that prop rather than off this store directly.
     */
    openOverlay(name, opts) {
      this.$patch({
        overlay: name,
        overlayOpts: opts ?? {}
      })
    },
    openFileManager(opts) {
      this.openOverlay('FileManager', {
        insertMode: opts?.insertMode ?? false
      })
    },
    async loadSite(hostname) {
      try {
        const siteInfo = await API_CLIENT.get(`sites/${hostname}`).json()
        if (!siteInfo) {
          throw new Error('ERR_INVALID_SITE')
        }
        this.applySiteInfo(siteInfo)
      } catch (err) {
        log.warn('site', 'could not load the site configuration', err)
        throw err
      }
    },
    /**
     * Separate from `loadSite` because `bootstrap` already holds the site configuration, alongside
     * the flags and the session — one request for all three on an app load.
     */
    applySiteInfo(siteInfo) {
      this.$patch({
        id: siteInfo.id,
        hostname: siteInfo.hostname,
        analytics: {
          providers: siteInfo.analytics?.providers ?? {}
        },
        title: siteInfo.title,
        description: siteInfo.description,
        logoText: siteInfo.logoText,
        pdfExportAvailable: siteInfo.pdfExportAvailable ?? false,
        docsBase: siteInfo.docsBase,
        isReplicationEnabled: siteInfo.isReplicationEnabled ?? false,
        guestsMayViewProfiles: siteInfo.guestsMayViewProfiles ?? false,
        navigationId: siteInfo.navigationId ?? null,
        blocksIndex: siteInfo.blocksIndex ?? {},
        commentsProvider: siteInfo.commentsProvider ?? null,
        pageExtensions: siteInfo.pageExtensions ?? [],
        pathDisplayCase: siteInfo.pathDisplayCase ?? 'off',
        company: siteInfo.company,
        contentLicense: siteInfo.contentLicense,
        footerExtra: siteInfo.footerExtra,
        banner: {
          isEnabled: siteInfo.banner?.isEnabled ?? false,
          title: siteInfo.banner?.title ?? '',
          content: siteInfo.banner?.content ?? ''
        },
        features: {
          ...this.features,
          ...siteInfo.features
        },
        auth: {
          ...this.auth,
          ...siteInfo.auth
        },
        editors: {
          asciidoc: siteInfo.editors.asciidoc.isActive,
          code: siteInfo.editors.code.isActive,
          markdown: siteInfo.editors.markdown.isActive,
          wysiwyg: siteInfo.editors.wysiwyg.isActive
        },
        // -> Spread over the state defaults, as `features` and `theme` do, so a key the site config
        //    has never been saved with reads as its default rather than undefined
        locales: {
          ...this.locales,
          ...siteInfo.locales,
          active: sortBy(describeLocales(siteInfo.locales.active), ['nativeName', 'name'])
        },
        tags: [],
        tagsLoaded: false,
        popularTags: [],
        popularTagsLoaded: false,
        theme: {
          ...this.theme,
          ...siteInfo.theme
        }
      })
      // -> The acronym lookup is per-site: without this reset, `fetchAcronymMap`'s early return on
      //    `acronymMapLoaded` skips the new site's fetch and leaves the old site's casing on screen.
      //    A second, FUNCTION-form `$patch` rather than an `acronymMap: {}` field on the object one
      //    above, since the object form deep-merges a plain object field instead of replacing it.
      this.$patch((state) => {
        state.acronymMap = {}
        state.acronymMapLoaded = false
      })
      // -> Only a site with the setting on ever needs its acronym lookup; not awaited, since
      //    `usePathDisplay()` reads `acronymMap` reactively off this store and re-renders on its own
      //    once the fetch resolves. Triggered here so every caller of `applySiteInfo` picks it up.
      if (this.pathDisplayCase !== 'off') {
        this.fetchAcronymMap()
      }
    },
    /**
     * Swallows its own failure, like `fetchExtensionsStatus` below: a path-derived label without its
     * acronym override is the safe fallback for a failed or not-yet-finished fetch.
     *
     * Written through the function form of `$patch` rather than an object -- the object form
     * deep-merges a plain object field instead of replacing it, so a term dropped from the glossary
     * since the last fetch would survive a `forceRefresh` forever.
     */
    async fetchAcronymMap(forceRefresh = false) {
      if (this.acronymMapLoaded && !forceRefresh) {
        return
      }
      try {
        const map = await API_CLIENT.get(`sites/${this.id}/glossary/acronyms`).json()
        this.$patch((state) => {
          state.acronymMap = map ?? {}
          state.acronymMapLoaded = true
        })
      } catch (err) {
        log.warn('site', 'could not load the acronym map', err)
      }
    },
    async fetchTags(forceRefresh = false) {
      if (this.tagsLoaded && !forceRefresh) {
        return
      }
      try {
        const tags = await API_CLIENT.get(`sites/${this.id}/tags`).json()
        this.$patch({
          tags: tags ?? [],
          tagsLoaded: true
        })
      } catch (err) {
        log.warn('site', 'could not load the tag list', err)
        throw err
      }
    },
    async fetchPopularTags(forceRefresh = false) {
      if (this.popularTagsLoaded && !forceRefresh) {
        return
      }
      try {
        const tags = await API_CLIENT.get(`sites/${this.id}/tags/popular`).json()
        this.$patch({
          popularTags: tags ?? [],
          popularTagsLoaded: true
        })
      } catch (err) {
        log.warn('site', 'could not load the popular tag list', err)
        throw err
      }
    },
    /**
     * Swallows its own failure rather than rethrowing, unlike `fetchTags` above: this only gates a
     * menu item's visibility, and hiding it is the safe default -- showing it would promise a
     * conversion this instance cannot be sure it can do.
     */
    async fetchExtensionsStatus(forceRefresh = false) {
      if (this.extensionsStatusLoaded && !forceRefresh) {
        return
      }
      try {
        const status = await API_CLIENT.get(`system/extensions/status`).json()
        this.$patch({
          extensionsStatus: status ?? {},
          extensionsStatusLoaded: true
        })
      } catch (err) {
        log.warn('site', 'could not read which extensions are installed', err)
      }
    },
    /**
     * @param id The page's `navigationId`, which addresses either a tree entry that overrides the
     *           menu or the site itself for the one every page inherits
     * @param forceRefresh Skip the "already showing this menu" check and refetch anyway. That check
     *           keeps a plain route change from re-walking the tree for an `auto`/`mixed` menu, but
     *           it also means the same `id` goes stale the moment a nav-mutating action changes what
     *           THAT id resolves to -- so every same-tab invalidation after a nav edit, a nav copy
     *           or a page create/move/delete passes `true`.
     */
    async fetchNavigation(id, forceRefresh = false) {
      if (!id || (!forceRefresh && id === this.nav.currentId)) {
        return
      }
      // -> Set synchronously, before the request goes out, so a second overlapping call can mark
      //    this one stale the instant it starts.
      this.nav.inFlightId = id
      try {
        const { mode, items, rootPath, rootId } = await API_CLIENT.get(
          `sites/${this.id}/navigation/${id}`
        ).json()
        // -> A newer call may have started, and even finished, while this one was in flight; its id
        //    is no longer the one this response is for, so discard rather than clobber it.
        if (this.nav.inFlightId !== id) {
          return
        }
        this.$patch({
          nav: {
            currentId: id,
            items: items ?? [],
            mode: mode ?? 'static',
            rootPath: rootPath ?? '',
            rootId: rootId ?? null
          }
        })
      } catch (err) {
        if (this.nav.inFlightId !== id) {
          return
        }
        // -> An empty sidebar is the right outcome for a menu nobody has set up, rather than an
        //    error in front of a reader who cannot act on it
        log.warn('nav', 'could not load the sidebar menu', err)
        this.$patch({
          nav: {
            currentId: id,
            items: [],
            mode: 'static',
            rootPath: '',
            rootId: null
          }
        })
      }
    }
  }
})
