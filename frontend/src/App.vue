<template>
  <router-view />
  <!-- Mounted once for the whole app; driven by composables/{notify,loading,dialog}.js -->
  <w-notifications />
  <w-loading-overlay />
  <w-dialog-host />
  <user-profile-popover />
  <component :is="DevQuickMenu" v-if="DevQuickMenu" />
</template>

<script setup>
import { defineAsyncComponent, reactive, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { apiErrorMessage } from '@/helpers/apiError'
import { bootstrapFailureRedirectFor } from '@/helpers/bootstrap'
import { resolveAestheticColors } from '@/helpers/aestheticDefaults'
import { setCssVar } from '@/helpers/cssVars'
import { applyFonts } from '@/helpers/fonts'
import { replaceHeadStyle } from '@/helpers/headStyle'
import { log } from '@/helpers/log'
import { parseLocalePrefix, resolveRouteLocale, stripPageExtension } from '@/helpers/pagePaths'
import { isFollowableRedirectTarget } from '@/helpers/pageRedirect'
import { useAesthetic } from '@/composables/aesthetic'
import { handleAuthLinkResult, readAuthLinkResult } from '@/composables/authLinkResult'
import { useDark } from '@/composables/dark'
import { confirm } from '@/composables/dialog'
import { useDirection } from '@/composables/direction'
import { notify } from '@/composables/notify'

import UserProfilePopover from '@/components/UserProfilePopover.vue'
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

// Keep the import inside this expression: `import.meta.env.DEV` folds to `false` in a build, which
// drops the branch and the chunk with it. A top-level import would be bundled regardless.
const DevQuickMenu = import.meta.env.DEV
  ? defineAsyncComponent(() => import('@/components/DevQuickMenu.vue'))
  : null

const dark = useDark()
const direction = useDirection()

const aesthetic = useAesthetic()

const commonStore = useCommonStore()
const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const i18n = useI18n({ useScope: 'global' })

const router = useRouter()

const state = reactive({
  isInitialized: false
})

// Through `applyTheme()`, not `dark.set()`: the brand CSS custom properties are dark-sensitive too,
// and `dark.set()` alone only flips the body class.
watch(
  () => userStore.appearance,
  () => {
    applyTheme()
  }
)

// Likewise not `aesthetic.set()` alone: the brand custom properties derive from the resolved
// aesthetic too.
watch([() => userStore.aesthetic, () => siteStore.theme.aesthetic], () => {
  applyTheme()
})

watch(
  () => userStore.cvd,
  () => {
    applyTheme()
  }
)

watch(() => commonStore.locale, onInterfaceLocaleChanged)

/**
 * The locale the current url names in its leading path segment (`/ar/some/page` -> `ar`), or `null`
 * when it names none the site has. Not a `ref`: nothing renders off it, and every reader calls
 * `applyDocumentLocale()` explicitly.
 */
let routeLocale = null

/**
 * Writes `<html dir>`/`<html lang>` for the url's own locale segment when it has one, else the
 * interface locale. Derived from the url rather than a loaded page's `isRTL` so it also holds for a
 * "page not found" under `/ar/...`, where no page is ever loaded to ask. Same resolution as
 * `backend/helpers/appShell.ts#resolveAppShellLocale`, which stamps the served shell.
 *
 * Synchronous, and not part of `applyLocale()`'s awaited body: the guard calls that one un-awaited,
 * so the reader would see the wrong direction for as long as the locale strings take to fetch.
 * `direction.set()` rather than a bare `setAttribute()`, so a component that stays mounted across
 * navigations reads the direction reactively (`composables/direction.js`).
 */
function applyDocumentLocale() {
  const locale = routeLocale ?? commonStore.locale
  const localeInfo = siteStore.locales.active.find((entry) => entry.code === locale)
  direction.set(Boolean(localeInfo?.isRTL))
  document.documentElement.setAttribute('lang', locale)
}

function onInterfaceLocaleChanged(locale) {
  applyDocumentLocale()
  applyLocale(locale)
}

/**
 * In-flight `applyLocale()` calls, by locale. The `commonStore.locale` watcher and the router
 * guard's direct call can both fire for the same locale within a microtask (the guard's
 * `setLocale()` is what the watcher reacts to), and each would otherwise fetch the strings. Keyed by
 * locale so a switch to a different locale mid-fetch is not held up.
 */
const localeApplyPromises = new Map()

async function applyLocale(locale) {
  if (i18n.locale.value === locale && i18n.availableLocales.includes(locale)) {
    return
  }

  const inFlight = localeApplyPromises.get(locale)
  if (inFlight) {
    return inFlight
  }

  const applyPromise = (async () => {
    if (!i18n.availableLocales.includes(locale)) {
      try {
        i18n.setLocaleMessage(locale, await commonStore.fetchLocaleStrings(locale))
      } catch (err) {
        notify({
          type: 'negative',
          message: i18n.t('common.error.localeLoadFailed', { locale }),
          caption: apiErrorMessage(err)
        })
      }
    }
    i18n.locale.value = locale

    /*
      -> The `en` fallback dictionary
      Only the locale being switched to is loaded above, so without this vue-i18n's
      `fallbackLocale: 'en'` has an empty bag to fall back to and a key the active locale lacks
      renders as its raw dotted path. Not awaited: nothing downstream needs it.
    */
    if (locale !== 'en' && !i18n.availableLocales.includes('en')) {
      commonStore
        .fetchLocaleStrings('en')
        .then((strings) => {
          i18n.setLocaleMessage('en', strings)
        })
        .catch((err) => {
          log.warn('locale', 'could not load the en fallback locale strings', err)
        })
    }
  })()
  localeApplyPromises.set(locale, applyPromise)
  try {
    await applyPromise
  } finally {
    localeApplyPromises.delete(locale)
  }
}

async function applyTheme() {
  if (userStore.appearance === 'site') {
    dark.set(siteStore.theme.dark)
  } else {
    dark.set(userStore.appearance === 'dark')
  }

  const resolvedAesthetic =
    userStore.aesthetic === 'site' ? siteStore.theme.aesthetic : userStore.aesthetic
  aesthetic.set(resolvedAesthetic)

  const brand = resolveAestheticColors(resolvedAesthetic, siteStore.theme, dark.isActive)
  setCssVar('primary', userStore.getAccessibleColor('primary', brand.colorPrimary))
  setCssVar('secondary', userStore.getAccessibleColor('secondary', siteStore.theme.colorSecondary))
  setCssVar('accent', userStore.getAccessibleColor('accent', brand.colorAccent))
  setCssVar('header', userStore.getAccessibleColor('header', brand.colorHeader))
  setCssVar('sidebar', userStore.getAccessibleColor('sidebar', brand.colorSidebar))
  setCssVar('positive', userStore.getAccessibleColor('positive', brand.colorPositive))
  setCssVar('negative', userStore.getAccessibleColor('negative', brand.colorNegative))
  setCssVar('info', userStore.getAccessibleColor('info', brand.colorInfo))
  setCssVar('warning', userStore.getAccessibleColor('warning', brand.colorWarning))

  applyFonts(siteStore.theme.baseFont, siteStore.theme.contentFont)

  await applyCodeBlocksTheme()
}

/**
 * `?inline` yields each stylesheet as a string rather than injecting it: it has to be scoped to the
 * page content before it is applied. `**` covers the `base16/` family. Only the theme in use is
 * ever fetched.
 */
const HLJS_THEMES = import.meta.glob('../node_modules/highlight.js/styles/**/*.min.css', {
  query: '?inline',
  import: 'default'
})

/**
 * The theme is wrapped in `.page-contents { ... }` and applied through CSS nesting: its bare
 * `.hljs*` rules would otherwise reach every code sample in the interface, and nesting lifts them to
 * the same weight as the fallback palette in `_page-contents.css`, so this one wins by being applied
 * later. With no theme chosen nothing is injected and that fallback shows.
 */
async function applyCodeBlocksTheme() {
  replaceHeadStyle('hljs-theme', null)

  // -> A colour-vision-deficient palette cannot be honoured per theme, so it takes a neutral one
  const desiredHljsTheme = userStore.cvd !== 'none' ? 'github' : siteStore.theme.codeBlocksTheme
  if (!desiredHljsTheme) {
    return
  }

  const load = HLJS_THEMES[`../node_modules/highlight.js/styles/${desiredHljsTheme}.min.css`]
  if (!load) {
    log.warn('site', `highlight.js does not ship the ${desiredHljsTheme} code blocks theme`)
    return
  }

  replaceHeadStyle('hljs-theme', `.page-contents {\n${await load()}\n}`)
}

if (typeof siteConfig !== 'undefined') {
  siteStore.$patch({
    id: siteConfig.id,
    title: siteConfig.title
  })
  applyTheme()
}

/**
 * The site, the system flags and the session in one request: everything the app needs before it can
 * draw. A failure leaves the stores at their safe *loaded* defaults (guest, flags off, no site), so
 * nothing downstream handles a half-patched state while the `/_error/*` screen shows.
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
    log.warn('site', 'could not load the site configuration', err)
    flagsStore.apply({})
    userStore.applyProfile()
    return err
  }
}

let hasPrefetchedMarkdownSettings = false

let isUnsavedChangesPromptOpen = false

router.beforeEach(async (to, from) => {
  commonStore.routerLoading = true

  /*
    -> Unsaved editor changes
    Every router navigation goes through here, rather than patching each call site. `to.path !==
    from.path` excludes a query- or hash-only change on the page being edited.

    `hasPendingChanges` alone, not `isActive && ...`: Page Properties can dirty the page (an edited
    tag list) with no editor open. Not `isActive || ...` either: that prompts on an editor that was
    opened and never typed into.

    A page unload (address bar, external link, tab close) never reaches `beforeEach`; the
    `beforeunload` handler below covers it.
  */
  if (editorStore.hasPendingChanges && to.path !== from.path) {
    /*
      A second navigation (a double click, or one fired while the prompt is up) reaches this guard
      before the first one's `await` resolves: vue-router cancels a superseded navigation only once
      every `beforeEach` settles. Blocked outright rather than stacking a second prompt.
      `routerLoading` is left alone: the first navigation's still-open prompt owns it.
    */
    if (isUnsavedChangesPromptOpen) {
      return false
    }
    isUnsavedChangesPromptOpen = true
    let confirmed
    try {
      confirmed = await new Promise((resolve) => {
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
    } finally {
      isUnsavedChangesPromptOpen = false
    }
    if (!confirmed) {
      // -> `afterEach` fires for this aborted navigation too and would clear it a tick later
      commonStore.routerLoading = false
      return false
    }
    // -> Both timestamps equalized, not just `isActive`: the gate above is `hasPendingChanges`, so
    //    unequal ones would re-prompt on the next navigation for a discard already made
    const discardedAt = Temporal.Now.instant()
    editorStore.$patch({
      isActive: false,
      editor: '',
      mode: 'edit',
      lastSaveTimestamp: discardedAt,
      lastChangeTimestamp: discardedAt
    })
    editorStore.clearPendingAssets()
  }

  // -> Asked once: a guest is an answer like any other, so this does not run again on the next page
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
    A head start for `EditorMarkdown.vue`'s mount, which fetches them itself when this has not landed
    -- so a guest, a lost race or a failed request all still work. Gated on `profileLoaded` rather
    than placed in the bootstrap branch above, so it fires even on a navigation that skipped that.
    Not awaited: it would only delay this navigation. The `.catch` just keeps a failure from becoming
    an unhandled rejection.
  */
  if (!hasPrefetchedMarkdownSettings && userStore.profileLoaded) {
    hasPrefetchedMarkdownSettings = true
    if (userStore.authenticated) {
      editorStore.fetchUserSettings('markdown').catch((err) => {
        log.warn('editor', 'could not prefetch the Markdown editor settings', err)
      })
    }
  }

  /*
    -> Page extensions
    `/foo/bar.md` addresses `/foo/bar`. The server redirects a request that reaches it, but a link
    inside a page is followed by the router alone. Below the bootstrap, which is where the site's
    extensions come from. A `/_` route is the app itself rather than a page.
  */
  const withoutExtension = to.path.startsWith('/_')
    ? null
    : stripPageExtension(to.path, siteStore.pageExtensions)
  if (withoutExtension) {
    return { path: withoutExtension, query: to.query, hash: to.hash, replace: true }
  }

  /*
    -> Locale prefix
    The url's leading segment (`/fr/some/page`) names the translation to ask the server for -- a
    content decision, distinct from `commonStore.locale`, the interface language. Resolved here so
    `pageStore.locale` is set before the page itself arrives.
  */
  if (siteStore.useLocales) {
    pageStore.locale = resolveRouteLocale(
      to.path,
      to.query,
      siteStore.locales.active.map((l) => l.code),
      siteStore.locales.primary,
      siteStore.locales.aliases
    )
  }

  /*
    -> Document locale
    The raw `parseLocalePrefix` result rather than `pageStore.locale`: that one cannot tell a path
    with no locale segment (`/some/page`, resolved to the primary) from one naming the primary
    explicitly (`/en/some/page`), and only the second is the url addressing a locale. With no
    segment the document follows the interface locale, as every `/_` route does.
  */
  routeLocale = siteStore.useLocales
    ? (parseLocalePrefix(
        to.path,
        siteStore.locales.active.map((l) => l.code),
        siteStore.locales.aliases
      )?.locale ?? null)
    : null

  if (!commonStore.locale || !siteStore.locales.active.some((l) => l.code === commonStore.locale)) {
    commonStore.setLocale(siteStore.locales.primary)
  }
  applyDocumentLocale()
  applyLocale(commonStore.locale)

  // -> Page permissions arrive with the page itself; a route that is not a page only drops the
  //    last page's
  if (to.path.startsWith('/_')) {
    userStore.$patch({ pagePermissions: [] })
  }
})

/*
  -> Unsaved editor changes, browser-level
  A page unload never reaches `beforeEach`, and `beforeunload` cannot show the app's own dialog: the
  listener cannot be async, so the browser's native prompt is the only one available. Browsers ignore
  the custom string, but `returnValue` must still be truthy -- that is what makes them prompt at all.
  Same `hasPendingChanges` gate as the router guard.
*/
window.addEventListener('beforeunload', (e) => {
  if (editorStore.hasPendingChanges) {
    e.preventDefault()
    e.returnValue = i18n.t('editor.unsavedWarning')
    return e.returnValue
  }
})

EVENT_BUS.on('logout', ({ redirect } = {}) => {
  // -> `redirect` is a group's `redirectOnLogout`: validated server-side, checked again here as
  //    defence in depth, since `window.location.assign()` would execute a `javascript:` target
  const target = redirect && isFollowableRedirectTarget(redirect) ? redirect : '/'
  // -> A validated target is either a rooted path, which is the router's, or a full http(s)
  //    address the router cannot navigate to -- and leaving the wiki, there is nobody to notify
  if (!target.startsWith('/')) {
    window.location.assign(target)
    return
  }
  router.push(target)
  notify({
    type: 'positive',
    icon: 'tabler:logout',
    message: i18n.t('auth.logoutSuccess')
  })
})
EVENT_BUS.on('applyTheme', () => {
  applyTheme()
})

router.afterEach((to, from, failure) => {
  if (!state.isInitialized) {
    state.isInitialized = true
    applyTheme()
    document.querySelector('.init-loading').remove()
  }
  if (!failure && readAuthLinkResult(to.query)) {
    applyLocale(commonStore.locale).then(() => {
      handleAuthLinkResult(router.currentRoute.value, {
        router,
        siteStore,
        userStore,
        t: i18n.t
      })
    })
  }
  /*
    `afterEach` fires for an aborted navigation too. A second navigation blocked by the open discard
    prompt lands here while the first one's load is still pending, and must not report it finished;
    the first navigation's own settling clears `routerLoading`.
  */
  if (isUnsavedChangesPromptOpen) {
    return
  }
  commonStore.routerLoading = false
})

/*
  Vue Router does not run `afterEach` when a navigation errors (as opposed to being aborted). A
  lazily-imported route chunk failing to load after a redeploy, or a guard throwing, lands here
  instead -- and without this the header spinner spins forever.
*/
router.onError((err) => {
  commonStore.routerLoading = false
  notify({
    type: 'negative',
    message: i18n.t('common.error.navigationFailed'),
    caption: apiErrorMessage(err)
  })
})
</script>
