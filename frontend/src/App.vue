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

import { apiErrorMessage } from '@/helpers/apiError'
import { bootstrapFailureRedirectFor } from '@/helpers/bootstrap'
import { setCssVar } from '@/helpers/cssVars'
import { applyFonts } from '@/helpers/fonts'
import { applyInjectCss, replaceHeadStyle } from '@/helpers/injectCss'
import { applyInjectBody, applyInjectHead } from '@/helpers/injectHtml'
import { resolveRouteLocale, stripPageExtension } from '@/helpers/pagePaths'
import { isFollowableRedirectTarget } from '@/helpers/pageRedirect'
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

/**
 * Locale codes with an `applyLocale()` call currently in flight, each mapped to the promise that
 * call returned.
 *
 * `App.vue` drives locale changes through two independent triggers -- the `watch(() =>
 * commonStore.locale, applyLocale)` below, and the direct call in the router guard after its
 * correction block -- and both can fire for the same locale within a microtask of each other (the
 * guard's `commonStore.setLocale()` call is exactly what the watcher above reacts to). Without this,
 * `applyLocale` has no way to know a fetch for the same locale is already underway, and issues a
 * second `GET locales/:code/strings` before the first has set `i18n.locale.value` (the only thing an
 * `i18n.availableLocales.includes()` check up front could have caught). Keyed by locale, not a single
 * in-flight flag, so a change to a *different* locale mid-fetch is never held up by this.
 */
const localeApplyPromises = new Map()

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

  // -> Already the active locale, with its strings loaded: nothing left for either trigger to do.
  if (i18n.locale.value === locale && i18n.availableLocales.includes(locale)) {
    return
  }

  // -> A call for this same locale is already fetching strings -- ride that one instead of a second.
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
      -> Eager-load the `en` fallback dictionary
      `messages: {}` at i18n init (boot/i18n.js) plus the block above -- which only ever loads
      messages for the locale being switched TO -- means `en`'s own message bag stays empty forever
      on a site whose active locale isn't `en`. vue-i18n's `fallbackLocale: 'en'` then has nothing to
      fall back TO, so any key missing from the active locale (true of ~32% of keys even for a
      "complete" shipped translation, and the whole dictionary for an unrecognised code -- see
      `fetchLocaleStrings()`'s array guard) renders as its raw dotted path instead of English.

      Fired fire-and-forget, same reasoning as the dir/lang attributes above: nothing downstream of
      this function needs to wait on it, and it's a no-op once `en` is already loaded (either from a
      previous call here, or because `en` was itself the active locale).
    */
    if (locale !== 'en' && !i18n.availableLocales.includes('en')) {
      commonStore
        .fetchLocaleStrings('en')
        .then((strings) => {
          i18n.setLocaleMessage('en', strings)
        })
        .catch((err) => {
          console.warn('Failed to load en fallback locale strings.', err)
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
  /*
    The two status colours are fixed rather than site-configurable, but they still go through
    `setCssVar` so the colour-vision-deficiency remapping reaches them. Cardinal's positive and
    negative TEXT tones -- the darker half of each pair -- because both are drawn under a white
    label here (a toast, a solid button); the brighter fills they pair with are
    `--color-positive-fill` / `--color-negative-fill`, which nothing resolves through this path.
    Kept equal to `css/tailwind.css`'s `:root`, and pinned in `helpers/accessibility.test.js`.
  */
  setCssVar('positive', userStore.getAccessibleColor('positive', '#3f7a66'))
  setCssVar('negative', userStore.getAccessibleColor('negative', '#c14a52'))

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
  // -> Cleared up front rather than only on the way in: the stylesheet loads asynchronously, and
  //    leaving the previous theme painted until the new one arrives is what this always did
  replaceHeadStyle('hljs-theme', null)

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

  replaceHeadStyle('hljs-theme', `.page-contents {\n${await load()}\n}`)
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

/** True while the discard-unsaved-changes prompt below is open -- see its own doc comment. */
let isUnsavedChangesPromptOpen = false

router.beforeEach(async (to, from) => {
  commonStore.routerLoading = true

  /*
    -> Unsaved editor changes
    Every ROUTER navigation vector -- breadcrumbs, side nav, search results, browser back/forward --
    goes through here uniformly, rather than patching each call site. `to.path !== from.path` excludes
    a query-string-only change (e.g. a hash or filter) on the page already being edited, which is not
    "leaving" it. On confirm, the editor is put back to its inactive shape -- the same one
    `PageHeader.vue`'s own `discardChanges` patches to -- so whatever the destination route is does not
    inherit a stale "an editor is open" flag; unlike that handler, there is no page state to revert
    here, since the destination is about to load its own.

    `hasPendingChanges` alone, not `isActive && hasPendingChanges` (OpenProject #1129): Page
    Properties can make the page dirty -- e.g. an edited tag list -- with no editor ever opened, via
    its own `pageStore.$subscribe` bumping `lastChangeTimestamp` regardless of `isActive`
    (`PagePropertiesDialog.vue`/`PageTags.vue`). The old `isActive &&` requirement missed that case
    entirely, letting a reader edit tags, navigate away, and lose the edit with no warning at all.
    `isActive` on its own adds nothing `hasPendingChanges` doesn't already cover -- `pageLoad()` (and
    every other place that opens a fresh editing session) equalizes both timestamps as its baseline,
    so an active-but-untouched editor already reads `hasPendingChanges: false`; `isActive ||
    hasPendingChanges` was tried first and rejected, since it warns on simply having opened an editor
    with nothing typed into it yet, a real regression a still-passing sibling test in `App.test.js`
    catches.

    NOT covered: typing a new address into the bar, following an external link, or closing the tab --
    each of those is a page unload, not a router navigation, and `beforeEach` never fires for it. The
    `beforeunload` handler below covers that gap, gated on the same condition.

    `pageStore.pageCreate()`'s own un-awaited `router.push()` into `/_create/...` (the header's New
    Page menu, mid-edit) is not a special case here: it synchronously re-patches `editorStore` --
    including equalizing these same two timestamps for the fresh session it is opening -- before this
    guard ever gets a turn to run, so `hasPendingChanges` already reads false for that navigation by
    the time this condition is checked. See the comment at that patch for why the ordering holds.
  */
  if (editorStore.hasPendingChanges && to.path !== from.path) {
    /*
      A second navigation -- a double click, or one fired while the dialog above is still up --
      reaches this guard before the first one's `await` resolves: vue-router only cancels a
      superseded navigation once every `beforeEach` in the queue (this one included) settles, so
      there is no built-in protection against two of these racing each other and resolving
      independently against the same `editorStore`. Blocked outright rather than stacking a second
      prompt, which is a decision this guard already knows the answer to once the first is showing.

      `commonStore.routerLoading` is deliberately left untouched here. This navigation does not own
      it -- the FIRST navigation's prompt is still open and is what actually set it true -- so
      clearing it here would tell the UI loading finished while the reader still has an unanswered
      dialog in front of them. `router.afterEach` below fires for this aborted navigation too (not
      only for a completed one), so its own `isUnsavedChangesPromptOpen` check is what actually
      guards against it clearing this on this navigation's behalf; whichever way the first prompt
      resolves is what clears it for real.
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
      /*
        Cleared explicitly rather than left to `router.afterEach`: that hook still fires for this
        aborted navigation (with a `failure` argument), and by now `isUnsavedChangesPromptOpen` is
        already back to `false` (the `finally` above ran first), so it would clear this too -- just
        one tick later than doing it here. Set here anyway so the UI doesn't wait even that long.
      */
      commonStore.routerLoading = false
      return false
    }
    /*
      The two timestamps are equalized here too, not just `isActive` (OpenProject #1129 follow-on):
      this guard's own gate is `hasPendingChanges` alone now, so leaving them unequal after a
      confirmed discard would have the very next navigation immediately re-prompt for a discard that
      already happened, since nothing else resets them until the destination page's own `pageLoad()`
      runs. Same baseline-reset shape `pageStore.pageLoad()`/`pageSave()`/`pageCreate()` already use.
    */
    const discardedAt = Temporal.Now.instant()
    editorStore.$patch({
      isActive: false,
      editor: '',
      mode: 'edit',
      lastSaveTimestamp: discardedAt,
      lastChangeTimestamp: discardedAt
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
    (`/fr/some/page`), which is a content decision, not a UI one -- distinct from `commonStore.locale`
    below, which is the interface language and persists across pages regardless of which translation is
    being read. Resolved into `pageStore.locale` so it is there before the page itself arrives: a `/_` route
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
  if (!commonStore.locale || !siteStore.locales.active.some((l) => l.code === commonStore.locale)) {
    commonStore.setLocale(siteStore.locales.primary)
  }
  applyLocale(commonStore.locale)

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

/*
  -> Unsaved editor changes, browser-level (OpenProject #818, condition fixed for #1129)
  The router guard above only fires for an in-SPA navigation -- typing a new address into the bar,
  following an external link, closing the tab, or refreshing is a page unload instead, which
  `beforeEach` never sees (see the comment on that guard). `beforeunload` is the only hook that does,
  and unlike the router guard it cannot show the app's own confirm dialog: the listener cannot be
  `async` and returning a promise does not pause the unload, so the native browser-owned prompt is the
  only one available for this path. Every evergreen browser also ignores the custom string and shows
  its own fixed wording -- a long-standing anti-phishing measure against a page dressing up its dialog
  as something else -- but `returnValue` still has to be set to a truthy value, since that (not the
  string itself) is what tells the browser to prompt at all. `editor.unsavedWarning` in `en.json` was
  minted for exactly this and sat unused until now.

  `hasPendingChanges` alone, matching the router guard above -- see its comment for why `isActive`
  was dropped rather than OR'd in.
*/
window.addEventListener('beforeunload', (e) => {
  if (editorStore.hasPendingChanges) {
    e.preventDefault()
    e.returnValue = i18n.t('editor.unsavedWarning')
    return e.returnValue
  }
})

// GLOBAL EVENTS HANDLERS

EVENT_BUS.on('logout', ({ redirect } = {}) => {
  /*
    OpenProject #1360/#2208 (2026-08-24 security audit §2): `redirect` is a group's `redirectOnLogout`
    (validated server-side on the way in, but checked again here as defence in depth against a row
    written before that validation existed). This used to accept ANY `scheme://` prefix
    (`/^[a-z][a-z0-9+.-]*:\/\//i`), which `javascript://%0aalert(1)` also satisfies — the `//` reads
    as a JS line comment once the browser decodes the newline, so `window.location.assign()` on it
    executed the payload. `isFollowableRedirectTarget` looks at what scheme actually resolved, not
    just "does this look like `scheme://…`".
  */
  const target = redirect && isFollowableRedirectTarget(redirect) ? redirect : '/'
  /*
    A group or the site can send logged out users to another site entirely, which the router cannot
    navigate to — and leaving the wiki means there is no point notifying anyone either. Told apart by
    shape now that `target` is already validated: a rooted path (the only other shape
    `isFollowableRedirectTarget` accepts) is same-origin and the router's; anything else is a
    complete http(s) address to a real elsewhere.
  */
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

// LOADER

router.afterEach(() => {
  if (!state.isInitialized) {
    state.isInitialized = true
    applyTheme()
    document.querySelector('.init-loading').remove()
  }
  /*
    `afterEach` fires for an ABORTED navigation too, not only a completed one -- with `failure` set,
    but it still fires synchronously as soon as `beforeEach` returns `false`. That includes the
    reentrancy guard above returning `false` for a second navigation blocked by an already-open
    discard prompt: that resolves (and reaches here) well before the FIRST navigation's own prompt
    does, while `isUnsavedChangesPromptOpen` is still true. Clearing `routerLoading` here would be
    this SECOND, already-discarded navigation reporting the FIRST one's still-pending load as
    finished. Skip it in that case and let the first navigation's own settling -- confirmed (falls
    through to a normal completion, its own `afterEach`) or cancelled (the explicit clear above) --
    be what actually clears it.
  */
  if (isUnsavedChangesPromptOpen) {
    return
  }
  commonStore.routerLoading = false
})

/*
  `beforeEach` sets `routerLoading = true` and `afterEach` above is what clears it -- but Vue Router
  does not run `afterEach` when a navigation ERRORS (as opposed to being aborted/cancelled, which
  `afterEach` DOES still fire for -- see its own comment above). A lazily-imported route chunk
  failing to load (a redeploy that changed the built asset's hash out from under a tab that already
  had the app open) or an exception thrown inside a guard lands in `router.onError` instead, and
  with no handler registered anywhere, the header spinner spins forever with nothing telling the
  reader why (OpenProject #951).
*/
router.onError((err) => {
  commonStore.routerLoading = false
  notify({
    type: 'negative',
    message: i18n.t('common.error.navigationFailed'),
    caption: err.message
  })
})
</script>
