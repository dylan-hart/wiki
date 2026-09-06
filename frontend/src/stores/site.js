import { defineStore } from 'pinia'

import { sortBy } from 'es-toolkit/array'

import { log } from '@/helpers/log'

/**
 * Turn the site's active locale CODES into the descriptors the UI reads.
 *
 * The API stores and returns `locales.active` as bare codes -- `['en']` -- because that is what the
 * admin screen writes back and what the server validates against its installed set. Everything that
 * DISPLAYS a locale, though, wants a name for it: the sidebar's locale menu, the language filter on
 * the search screen, and the check in App.vue that a requested locale is one this site offers. They
 * were each reading `.code` / `.language` / `.nativeName` off a string, so every one of them rendered
 * blank -- the locale menu showed an empty row rather than "English".
 *
 * Resolved here rather than server-side so the write shape stays a plain list of codes, and with
 * `Intl.DisplayNames` rather than a table, which gives the name in the reader's own language for
 * free. Asking for a code's name IN that code is what produces the native spelling.
 *
 * `isRTL` is resolved the same way, with `Intl.Locale`'s own text-direction info rather than a
 * second request to `/_api/locales` (which also carries `isRTL`, sourced from CLDR via
 * `backend/models/locales.ts`). Every page load already reaches this function for the name fields,
 * and `Intl.Locale` reads from the same CLDR-backed data the ICU build ships with -- so folding the
 * direction in here keeps this store the single source of truth for locale descriptors without a
 * second locale-list round trip on every load.
 *
 * `textDirection()` below feature-detects between the two shapes real engines actually ship for
 * this: verified live (feature 413, task 727) against a real Chromium build (Playwright's, a recent
 * one) rather than assumed, since Node's own V8 -- what every Vitest run in this repo executes
 * against -- silently accepted the OTHER shape and never caught the mismatch. Chrome/Chromium
 * implements `Intl.Locale.prototype.getTextInfo()` as a METHOD (the shape the "Intl Locale Info"
 * proposal settled on); this environment's Node instead exposes the EARLIER draft's `.textInfo`
 * GETTER, which Chrome does not have at all. Reading `.textInfo.direction` -- what this function did
 * before task 727 -- throws in Chrome (`.textInfo` is `undefined`), which the surrounding `try/catch`
 * swallows, silently defaulting every single locale to `isRTL: false`. That is a whole-feature
 * regression, not a cosmetic one: it means `dir="rtl"` never actually applied in a real browser
 * regardless of anything task 716/721/723 built on top of it, and the existing Vitest suite could not
 * have caught it because it runs on Node's shape, not Chrome's.
 */
function textDirection(locale) {
  if (typeof locale.getTextInfo === 'function') {
    return locale.getTextInfo().direction
  }
  return locale.textInfo?.direction
}

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
      //    fall back to left-to-right, the safer default for a direction nothing could be read for
    }
    return {
      code,
      // -> The bare language, for the two-letter badge beside each entry
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
    /**
     * Keyed by provider key (`google`, `gtm`, `matomo`, ...) — see `backend/modules/analytics/*`.
     * Read once, on app load, by `boot/analytics.js` to inject each enabled provider's tracking
     * snippet; nothing else in the app consumes this.
     */
    analytics: {
      providers: {}
    },
    company: '',
    contentLicense: '',
    footerExtra: '',
    title: '',
    description: '',
    logoText: true,
    /**
     * Whether this instance can render a page to PDF — i.e. whether the Puppeteer extension is
     * installed. Instance-wide, not something a site configures, so the export UI reads this to hide
     * or disable the PDF option with an explanatory tooltip rather than offering a control that would
     * always 503.
     */
    pdfExportAvailable: false,
    /**
     * This site's enabled blocks, keyed by tag, as `{ id, isCustom }` — `backend/api/sites.ts`'s
     * `siteBlocksInfoFor()`, carried on the same public site-info response `pdfExportAvailable`
     * above travels on. Lets `Index.vue`'s block-loading scan resolve an undefined `block-*` element
     * to a custom block's `/_blocks/custom/:siteId/:id.js` import URL (`blockImportUrl()` in
     * `stores/common.js`) without calling the manage:sites-gated `GET /sites/:siteId/blocks` route,
     * which every reader who isn't also an author gets refused (OpenProject #954).
     */
    blocksIndex: {},
    /**
     * The extensions this site's content is written in, lowercase and without the dot. A path ending
     * in one of them addresses the page underneath it — `/foo/bar.md` is `/foo/bar` — which the
     * router acts on for links inside pages and the server acts on for requests that reach it.
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
      profile: false,
      reasonForChange: 'required',
      search: false,
      showOtherGroups: false
    },
    /** How this site handles signing in. Set in the admin area's Login section. */
    auth: {
      /**
       * Send a visitor who is not logged in straight to the login screen instead of showing them
       * the unauthorized page. For a wiki that is closed to the public, that screen is a dead end
       * with a login button on it, and this skips the step.
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
      `PageNewMenu.vue`'s page-import item was the original caller but no longer needs it (OpenProject
      #1092: `format: 'markdown'` needs no Pandoc extension, and every other format is now gated at
      conversion time instead of at menu-render time) -- kept here as the general-purpose presence
      check `GET system/extensions/status` itself is documented as (task 668), for the next feature
      that needs to ask. Fetched lazily via `fetchExtensionsStatus`, same cached-until-asked-again
      shape as `tags` / `tagsLoaded` below.
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
     * The case style (Feature #2574/#2577) applied to a path-derived label at every render site --
     * breadcrumbs, sidebar/tree nav, auto-nav, and a page's own heading (#2578) -- via
     * `composables/pathDisplay.js#usePathDisplay()`. `'off'` (the default) means every one of those
     * sites shows its label unchanged, exactly as before this feature existed.
     */
    pathDisplayCase: 'off',
    /**
     * The site's lowercase-surface-form -> canonical-display-casing acronym lookup
     * (`GET sites/:siteId/glossary/acronyms`), consulted by `usePathDisplay()`'s humanizer so e.g.
     * "uss" renders as "USS" rather than the case style's own guess. Fetched lazily by
     * `fetchAcronymMap` -- triggered from `applySiteInfo` itself, once per site load, only when
     * `pathDisplayCase` is not `'off'` -- since a site with the setting off never needs it.
     */
    acronymMap: {},
    acronymMapLoaded: false,
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
      contentWidth: 'centered',
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
     * (`WIKI.config.docsBase`, from `backend/base.yml`), so this holds no hardcoded fallback: it
     * reads as `''` until `applySiteInfo` (via `loadSite` or `bootstrap`) fills it in.
     */
    docsBase: '',
    /**
     * This site's default menu id for its default locale (`backend/api/sites.ts`'s
     * `buildSitePayload`, resolved via `WIKI.models.navigation.ensureSiteNav`) -- always server-
     * provided, same as `docsBase` above. What `MainLayout.vue` and `NavSidebar.vue` fall back to on
     * a route with no page-inherited `navigationId` of its own (the knowledge graph, tags browse),
     * instead of leaving the sidebar with nothing to load (OpenProject #2527).
     */
    navigationId: null,
    nav: {
      currentId: null,
      items: [],
      mode: 'static',
      /** The generator's own root for the current `auto`/`mixed` menu -- what `NavSidebar.vue`'s
       *  root-level "create here" action targets instead of always the locale root, since a
       *  page/folder-level override's own root is not always the locale root (OpenProject #2442).
       *  Meaningless for a `static` menu. */
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
    /** The exact triple `shouldPrefixLocale` / `localizedPagePath` take -- built once here instead of
     *  by hand at every call site. */
    localeRouting() {
      return {
        useLocales: this.useLocales,
        primary: this.locales.primary,
        forcePrefix: this.locales.forcePrefix
      }
    }
  },
  actions: {
    /**
     * The one entry point for opening any `MainOverlayDialog` overlay with initial state --
     * `MainOverlayDialog.vue` forwards `overlayOpts` to the mounted component as a prop, so a new
     * overlay reads its initial params off that prop rather than off this store directly (OpenProject
     * #2530). `opts` defaults to `{}` rather than being left `undefined`, matching what `overlayOpts`
     * already defaults to at rest.
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
     * Take in a site configuration that arrived with something else — `bootstrap` hands it over with
     * the flags and the session, which is how an app load gets all three in one request.
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
        navigationId: siteInfo.navigationId ?? null,
        blocksIndex: siteInfo.blocksIndex ?? {},
        pageExtensions: siteInfo.pageExtensions ?? [],
        pathDisplayCase: siteInfo.pathDisplayCase ?? 'off',
        company: siteInfo.company,
        contentLicense: siteInfo.contentLicense,
        footerExtra: siteInfo.footerExtra,
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
        // -> Spread over the state defaults, as `features` and `theme` above do, so a key the
        //    site config has never been saved with reads as its default rather than undefined
        locales: {
          ...this.locales,
          ...siteInfo.locales,
          active: sortBy(describeLocales(siteInfo.locales.active), ['nativeName', 'name'])
        },
        tags: [],
        tagsLoaded: false,
        theme: {
          ...this.theme,
          ...siteInfo.theme
        }
      })
      // -> Only a site with the setting on ever needs its acronym lookup; not awaited, since every
      //    render site (`usePathDisplay()`) reads `acronymMap` reactively off this store and updates
      //    on its own once the fetch resolves -- the same lazy, swallow-on-failure shape as
      //    `fetchExtensionsStatus` below, just triggered from here instead of on demand, so every
      //    caller of `applySiteInfo` (`loadSite`, `bootstrap`) picks it up with no call of its own.
      if (this.pathDisplayCase !== 'off') {
        this.fetchAcronymMap()
      }
    },
    /**
     * The site's acronym lookup (Feature #2574/#2575), for `usePathDisplay()`'s humanizer. Same
     * cached-until-asked-again, swallow-on-failure shape as `fetchExtensionsStatus` below: a reader
     * seeing a path-derived label without its acronym override is the safe fallback for a failed or
     * not-yet-finished fetch, not an uncaught rejection.
     *
     * Written through the function form of `$patch` rather than an object -- `acronymMap`'s own keys
     * come and go as the glossary's acronym entries do, and the object form deep-merges a plain
     * object field instead of replacing it, which would leave a term removed from the glossary since
     * the last fetch stuck around forever on `forceRefresh`.
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
    /**
     * Fetch which optional extensions are installed, e.g. to decide whether the page-import menu
     * item should offer itself.
     *
     * Swallows its own failure rather than rethrowing, unlike `fetchTags` above: this only ever
     * gates a menu item's visibility, and a caller that cannot reach the check should get the item
     * hidden -- the safe default, since showing it would promise a conversion this instance cannot
     * actually be sure it can do -- not an uncaught rejection.
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
     * Load the sidebar menu a page resolves to.
     *
     * @param id The page's `navigationId`, which addresses either a tree entry that overrides the menu
     *           or the site itself for the one every page inherits
     * @param forceRefresh Skip the "already showing this menu" check below and refetch anyway
     *           (OpenProject #1012). The check exists so a plain route change within the same menu
     *           doesn't re-trigger `generateFromTree`'s tree walk for an `auto`/`mixed` menu on every
     *           navigation -- but it also means the same `id` can go stale the moment a nav-mutating
     *           action changes what THAT id resolves to. Every same-tab invalidation after an admin
     *           nav edit, a nav copy, or a page create/move/delete passes `true` here for exactly that
     *           reason; `NavSidebar.vue`'s passive `pageStore.navigationId` watcher is the only caller
     *           that leaves it `false`, since nothing changed there for a menu it already has cached.
     */
    async fetchNavigation(id, forceRefresh = false) {
      if (!id || (!forceRefresh && id === this.nav.currentId)) {
        return
      }
      // -> Set synchronously, before the request goes out, so a second overlapping call can mark
      //    this one stale the instant it starts -- not only once it too has a response in hand.
      this.nav.inFlightId = id
      try {
        const { mode, items, rootPath, rootId } = await API_CLIENT.get(
          `sites/${this.id}/navigation/${id}`
        ).json()
        // -> A newer call may have started (and even finished) while this one was in flight; if so,
        //    its id is no longer the one this response is for, so discard rather than clobber it.
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
        // -> An empty sidebar is the right outcome for a menu nobody has set up, rather than an error
        //    in front of a reader who cannot act on it
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
