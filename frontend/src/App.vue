<template>
  <router-view />
  <!-- Mounted once for the whole app; driven by composables/{notify,loading,dialog}.js -->
  <w-notifications />
  <w-loading-overlay />
  <w-dialog-host />
  <component :is="DevQuickMenu" v-if="DevQuickMenu" />
</template>

<script setup>
import { defineAsyncComponent, reactive, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { bootstrapFailureRedirectFor } from '@/helpers/bootstrap'
import { setCssVar } from '@/helpers/cssVars'
import { applyFonts } from '@/helpers/fonts'
import { applyInjectCss } from '@/helpers/injectCss'
import { applyInjectBody, applyInjectHead } from '@/helpers/injectHtml'
import { resolveRouteLocale, stripPageExtension } from '@/helpers/pagePaths'
import { useDark } from '@/composables/dark'
import { confirm } from '@/composables/dialog'
import { useDirection } from '@/composables/direction'
import { notify } from '@/composables/notify'

import WDialogHost from '@/components/shared/WDialogHost.vue'
import WLoadingOverlay from '@/components/shared/WLoadingOverlay.vue'
import WNotifications from '@/components/shared/WNotifications.vue'

import { useCommonStore } from './stores/common'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/* global siteConfig */

// DEV TOOLS

/*
  The dev quick menu, and nothing of it in a release.

  `import.meta.env.DEV` is substituted at build time, so a production build sees `false ? … : null`,
  drops the branch, and with it the only reference to the dynamic import -- the component is never
  emitted as a chunk, not merely never rendered. Keep the import inside this expression for that
  reason: a top-level `import` of it would be bundled however it was guarded afterwards.
*/
const DevQuickMenu = import.meta.env.DEV
  ? defineAsyncComponent(() => import('@/components/DevQuickMenu.vue'))
  : null

// DARK MODE

const dark = useDark()
const direction = useDirection()

// STORES

const commonStore = useCommonStore()
const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const i18n = useI18n({ useScope: 'global' })

// ROUTER

const router = useRouter()

// STATE

const state = reactive({
  isInitialized: false
})

// WATCHERS

watch(
  () => userStore.appearance,
  (newValue) => {
    if (newValue === 'site') {
      dark.set(siteStore.theme.dark)
    } else {
      dark.set(newValue === 'dark')
    }
  }
)

watch(
  () => userStore.cvd,
  () => {
    applyTheme()
  }
)

watch(() => commonStore.locale, applyLocale)

// LOCALE

async function applyLocale(locale) {
  /*
    -> Direction + <html lang>
    Set synchronously, ahead of the (possibly awaited) locale-strings fetch below: this function is
    called un-awaited from the router guard, whose `afterEach` removes `.init-loading` as soon as
    navigation resolves -- it does not wait on this promise. Direction comes from `siteStore.locales`,
    already loaded by the time the guard reaches locale handling, so it does not depend on `locale`
    being in `i18n.availableLocales` or on its strings having arrived. Left this way rather than after
    `i18n.locale.value = locale` below, a reader would see the outgoing (or default LTR) layout for as
    long as the strings take to fetch -- exactly the flash `index.html`'s static `lang="en"` needs the
    boot code to correct.

    `direction.set()` rather than a bare `setAttribute()`: this runs on every navigation, not once at
    boot, so a component mounted across navigations (`PageHeader.vue`'s review-queue menu, via
    `composables/direction.js`) needs a reactive read of whatever this last resolved to, not a stale
    one from whenever it happened to first mount.
  */
  const localeInfo = siteStore.locales.active.find((entry) => entry.code === locale)
  direction.set(Boolean(localeInfo?.isRTL))
  document.documentElement.setAttribute('lang', locale)

  if (!i18n.availableLocales.includes(locale)) {
    try {
      i18n.setLocaleMessage(locale, await commonStore.fetchLocaleStrings(locale))
    } catch (err) {
      notify({
        type: 'negative',
        message: `Failed to load ${locale} locale strings.`,
        caption: err.message
      })
    }
  }
  i18n.locale.value = locale
}

// THEME

async function applyTheme() {
  // -> Dark Mode
  if (userStore.appearance === 'site') {
    dark.set(siteStore.theme.dark)
  } else {
    dark.set(userStore.appearance === 'dark')
  }

  // -> CSS Vars
  setCssVar('primary', userStore.getAccessibleColor('primary', siteStore.theme.colorPrimary))
  setCssVar('secondary', userStore.getAccessibleColor('secondary', siteStore.theme.colorSecondary))
  setCssVar('accent', userStore.getAccessibleColor('accent', siteStore.theme.colorAccent))
  setCssVar('header', userStore.getAccessibleColor('header', siteStore.theme.colorHeader))
  setCssVar('sidebar', userStore.getAccessibleColor('sidebar', siteStore.theme.colorSidebar))
  setCssVar('positive', userStore.getAccessibleColor('positive', '#02C39A'))
  setCssVar('negative', userStore.getAccessibleColor('negative', '#f03a47'))

  // -> Fonts
  applyFonts(siteStore.theme.baseFont, siteStore.theme.contentFont)

  // -> Injected CSS
  applyInjectCss(siteStore.theme.injectCSS)

  // -> Injected HTML
  applyInjectHead(siteStore.theme.injectHead)
  applyInjectBody(siteStore.theme.injectBody)

  // -> Highlight.js Theme
  await applyCodeBlocksTheme()
}

/**
 * Every highlight.js theme the admin area offers, as loaders that fetch one on demand.
 *
 * `?inline` hands back the stylesheet as a STRING rather than injecting it: these have to be scoped to
 * the page content before they are applied (see below), which cannot be done to a stylesheet the
 * bundler has already added to the document. `**` covers the `base16/` family, since that is how the
 * admin's list names half of its options.
 *
 * Only the theme in use is ever fetched; the rest sit in the build as assets nobody asks for.
 */
const HLJS_THEMES = import.meta.glob('../node_modules/highlight.js/styles/**/*.min.css', {
  query: '?inline',
  import: 'default'
})

/**
 * Paint code blocks in the theme chosen under Admin → Theme.
 *
 * The stylesheet is wrapped in `.page-contents { ... }` and applied through CSS nesting, for two
 * reasons: a highlight.js theme is written as bare `.hljs*` rules that would otherwise reach every
 * code sample in the interface, and nesting lifts its selectors to the same weight as the fallback
 * palette in `_page-contents.scss` -- so this one wins on being applied later, which is exactly the
 * relationship wanted. With no theme chosen, nothing is injected and that fallback is what shows.
 */
async function applyCodeBlocksTheme() {
  document.querySelector('#hljs-theme')?.remove()

  // -> A colour-vision-deficient palette cannot be honoured per theme, so it takes a neutral one
  const desiredHljsTheme = userStore.cvd !== 'none' ? 'github' : siteStore.theme.codeBlocksTheme
  if (!desiredHljsTheme) {
    return
  }

  const load = HLJS_THEMES[`../node_modules/highlight.js/styles/${desiredHljsTheme}.min.css`]
  if (!load) {
    // -> A name the admin area offers that highlight.js does not ship; the fallback palette stands in
    console.warn(`Unknown code blocks theme: ${desiredHljsTheme}`)
    return
  }

  const styleEl = document.createElement('style')
  styleEl.id = 'hljs-theme'
  styleEl.textContent = `.page-contents {\n${await load()}\n}`
  document.head.appendChild(styleEl)
}

// INIT SITE STORE

if (typeof siteConfig !== 'undefined') {
  siteStore.$patch({
    id: siteConfig.id,
    title: siteConfig.title
  })
  applyTheme()
}

/**
 * Everything the app has to know before it can draw: which site it is on, which system flags are set,
 * and who is asking.
 *
 * The three have endpoints of their own, and are still asked separately where they change on their
 * own — the admin area saves flags, a login changes who is asking. This is the load, where all three
 * are wanted at once and none of them is known yet.
 *
 * A failure leaves the stores at their safe, *loaded* defaults (guest user, flags off, no site)
 * rather than whatever partial state a half-finished patch might leave, and hands the error back to
 * the caller (the route guard below) — which turns it into a redirect to the matching `/_error/*`
 * screen via `bootstrapFailureRedirectFor`, distinguishing "no site at this hostname" from "site
 * disabled" the same way `bootstrap.ts` does. Nothing downstream (nav, theme application) should have
 * to handle a null site while that screen is showing, which the safe defaults below are for.
 *
 * @returns What was caught, or `null` on success.
 */
async function loadBootstrap() {
  try {
    const data = await API_CLIENT.get('bootstrap', {
      searchParams: { hostname: window.location.hostname },
      cache: 'no-store'
    }).json()
    siteStore.applySiteInfo(data.site)
    flagsStore.apply(data.flags)
    userStore.applyProfile(data.user)
    return null
  } catch (err) {
    console.warn(`Could not load the site configuration: ${err.message}`)
    flagsStore.apply({})
    userStore.applyProfile()
    return err
  }
}

// ROUTE GUARDS

/** Set once the Markdown editor settings prefetch below has fired -- see its own doc comment. */
let hasPrefetchedMarkdownSettings = false

router.beforeEach(async (to, from) => {
  commonStore.routerLoading = true

  /*
    -> Unsaved editor changes
    Every navigation vector -- breadcrumbs, side nav, search results, browser back/forward, a typed
    address -- goes through the router, so this is the one place that can catch discarding an
    in-progress edit uniformly, rather than patching each call site. `to.path !== from.path` excludes
    a query-string-only change (e.g. a hash or filter) on the page already being edited, which is not
    "leaving" it. On confirm, the editor is put back to its inactive shape -- the same one
    `PageHeader.vue`'s own `discardChanges` patches to -- so whatever the destination route is does not
    inherit a stale "an editor is open" flag; unlike that handler, there is no page state to revert
    here, since the destination is about to load its own.

    `pageStore.pageCreate()`'s own un-awaited `router.push()` into `/_create/...` (the header's New
    Page menu, mid-edit) is not a special case here: it synchronously re-patches `editorStore` --
    including equalizing these same two timestamps for the fresh session it is opening -- before this
    guard ever gets a turn to run, so `hasPendingChanges` already reads false for that navigation by
    the time this condition is checked. See the comment at that patch for why the ordering holds.
  */
  if (editorStore.isActive && editorStore.hasPendingChanges && to.path !== from.path) {
    const confirmed = await new Promise((resolve) => {
      confirm({
        title: i18n.t('editor.unsaved.title'),
        message: i18n.t('editor.unsaved.body'),
        cancel: true,
        color: 'negative',
        okLabel: i18n.t('common.actions.discard')
      })
        .onOk(() => resolve(true))
        .onCancel(() => resolve(false))
    })
    if (!confirmed) {
      // -> Aborted navigation skips `afterEach`, which is what normally clears this
      commonStore.routerLoading = false
      return false
    }
    editorStore.$patch({
      isActive: false,
      editor: '',
      mode: 'edit'
    })
  }

  /*
    -> Site info, system flags and the session
    One request for the three of them: none touches the database, so what they cost is the round trip,
    and a full load paid it three times over before it could draw anything. Asked once — a guest is an
    answer like any other, so this does not run again on the way to the next page.
  */
  if (!siteStore.id || !flagsStore.loaded || !userStore.profileLoaded) {
    const bootstrapError = await loadBootstrap()
    const bootstrapFailureRoute =
      bootstrapError && bootstrapFailureRedirectFor(to.path, bootstrapError)
    if (bootstrapFailureRoute) {
      return bootstrapFailureRoute
    }
  }

  /*
    -> Markdown editor preferences, prefetched
    A one-time head start for `EditorMarkdown.vue`'s own mount, which reads whatever landed here (or
    fetches it itself, if this hasn't resolved yet, or never ran at all) rather than depending on it --
    so a guest, a click fast enough to win the race, or this request simply failing all still work,
    just without it. `userStore.profileLoaded` is what this actually waits on -- true the moment
    `loadBootstrap()` above has ever resolved once, whichever navigation that was -- not the bootstrap
    branch itself, so this fires on the very next navigation even on a route that skipped it entirely.
    Not awaited: the earliest possible moment -- session start, in the background, while the reader is
    doing anything else -- is also the only one that reliably beats an "Edit" click, and awaiting it
    here would instead delay every navigation on the one it actually runs on for no reason. `.catch`
    rather than a `try`/`catch` around an `await`, for the same reason it is not awaited -- nothing
    here is in a position to react to the failure, only to keep it from becoming an unhandled
    rejection.
  */
  if (!hasPrefetchedMarkdownSettings && userStore.profileLoaded) {
    hasPrefetchedMarkdownSettings = true
    if (userStore.authenticated) {
      editorStore.fetchUserSettings('markdown').catch((err) => {
        console.warn(`Could not prefetch Markdown editor settings: ${err.message}`)
      })
    }
  }

  /*
    -> Page extensions
    A path ending in one of the extensions the site's content is written in addresses the page
    underneath it, so `/foo/bar.md` is `/foo/bar`. The server redirects a request that reaches it, but
    a link inside a page is followed by the router alone -- which is what this is for. Below the
    bootstrap above, since that is where the site's extensions come from. A `/_` route is the app
    itself rather than a page, and is left alone as it is by the server.
  */
  const withoutExtension = to.path.startsWith('/_')
    ? null
    : stripPageExtension(to.path, siteStore.pageExtensions)
  if (withoutExtension) {
    return { path: withoutExtension, query: to.query, hash: to.hash, replace: true }
  }

  /*
    -> Locale prefix
    A site with more than one active locale can address each in a page URL's own leading segment
    (`/fr/some/page`), which is a content decision, not a UI one -- distinct from `desiredLocale` below,
    which is the interface language and persists across pages regardless of which translation is being
    read. Resolved into `pageStore.locale` so it is there before the page itself arrives: a `/_` route
    is the app itself rather than a page, same as the extension check above, so it has no path segment
    to read one from -- `resolveRouteLocale` falls back to a `?locale=` query instead (only `/_create`
    ever sets one; see `pageStore.pageCreate`), and then to the site's primary same as an ordinary path
    whose leading segment isn't one of the site's active codes. `Index.vue`'s own route watcher does
    the matching strip of the segment off the path it hashes to look the page up -- this only resolves
    which locale that lookup asks for.
  */
  if (siteStore.useLocales) {
    pageStore.locale = resolveRouteLocale(
      to.path,
      to.query,
      siteStore.locales.active.map((l) => l.code),
      siteStore.locales.primary
    )
  }

  // -> Locale
  if (
    !commonStore.desiredLocale ||
    !siteStore.locales.active.some((l) => l.code === commonStore.desiredLocale)
  ) {
    commonStore.setLocale(siteStore.locales.primary)
  }
  applyLocale(commonStore.desiredLocale)

  /*
    -> Page Permissions
    Not fetched here any more: what this reader may do at a path comes back with the page itself, so
    a page view is one request rather than two. What is left is the routes that are not a page —
    dropping the last page's permissions on the way out of the page view, which takes no request at
    all. A path with no page behind it has nothing to carry them, and asks in `pages/Index.vue`.
  */
  if (to.path.startsWith('/_')) {
    userStore.$patch({ pagePermissions: [] })
  }
})

// GLOBAL EVENTS HANDLERS

EVENT_BUS.on('logout', ({ redirect } = {}) => {
  const target = redirect || '/'
  // -> A group or the site can send logged out users to another site entirely, which the router cannot
  //    navigate to — and leaving the wiki means there is no point notifying anyone either
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    window.location.assign(target)
    return
  }
  router.push(target)
  notify({
    type: 'positive',
    icon: 'mdi:logout',
    message: i18n.t('auth.logoutSuccess')
  })
})
EVENT_BUS.on('applyTheme', () => {
  applyTheme()
})

// LOADER

router.afterEach(() => {
  if (!state.isInitialized) {
    state.isInitialized = true
    applyTheme()
    document.querySelector('.init-loading').remove()
  }
  commonStore.routerLoading = false
})
</script>
