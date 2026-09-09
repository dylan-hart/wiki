<template>
  <w-layout :class="{ 'main-layout--entrance-flourish': playEntranceFlourish }">
    <!--
      The way past every sidebar link and header control on a keyboard, per WCAG 2.4.1 (Bypass
      Blocks) -- the first focusable element in the whole layout, ahead of even `header-nav`. Still
      reachable by a screen reader regardless of the CSS below (nothing here uses `display: none` /
      `visibility: hidden`, which would pull it out of the accessibility tree along with the visual
      hiding); the transform only keeps it off a sighted keyboard user's screen until THEY tab to it
      too. `#w-page-main` is the `<main>` `WPage` renders, given a `tabindex="-1"` there for exactly
      this -- see its own comment for why a fragment link alone would only move the SCROLL position,
      not focus.
    -->
    <a href="#w-page-main" class="skip-link">{{ t('common.actions.skipToContent') }}</a>
    <w-header class="site-header-wrap">
      <header-nav />
    </w-header>
    <w-drawer
      class="bg-sidebar"
      bordered
      v-model="isSidebarOpen"
      :width="sidebarWidth"
      :overlay-below="SIDEBAR_OVERLAY_BELOW"
      :side="siteStore.theme.sidebarPosition === `right` ? `right` : `left`">
      <div v-if="isSidebarMini" class="sidebar-mini flex flex-col items-stretch">
        <w-btn
          class="py-4"
          flat
          icon="tabler:chevrons-right"
          color="slate"
          :aria-label="t('common.sidebar.expand')"
          @click="sidebarExpandOverride = true">
          <w-tooltip anchor="center right" self="center left">{{
            t('common.sidebar.expand')
          }}</w-tooltip>
        </w-btn>
        <w-btn
          v-if="siteStore.locales.showMenu"
          class="py-4"
          flat
          icon="tabler:language"
          color="slate"
          :aria-label="t('common.sidebar.switchLocale')">
          <locale-selector-menu anchor="top right" self="top left" />
          <w-tooltip anchor="center right" self="center left">{{
            t('common.sidebar.switchLocale')
          }}</w-tooltip>
        </w-btn>
        <w-btn
          v-if="canBrowse"
          class="py-4"
          flat
          icon="tabler:sitemap"
          color="slate"
          :aria-label="t(`common.sidebar.browse`)">
          <nav-browse-menu anchor="top right" self="top left" />
          <w-tooltip anchor="center right" self="center left">
            {{ t('common.sidebar.browse') }}
          </w-tooltip>
        </w-btn>
        <w-space />
        <w-btn
          v-if="showEditNav"
          class="py-1"
          flat
          icon="tabler:list-tree"
          color="slate"
          :aria-label="t(`common.sidebar.editNav`)"
          size="sm">
          <w-menu ref="navEditMenuMini" anchor="top right" self="bottom left">
            <nav-edit-menu
              :menu-hide-handler="navEditMenuMini.hide"
              :update-position-handler="navEditMenuMini.updatePosition" />
          </w-menu>
          <w-tooltip anchor="center right" self="center left">{{
            t(`common.sidebar.editNav`)
          }}</w-tooltip>
        </w-btn>
      </div>
      <template v-else>
        <div
          v-if="showSidebarCollapseOverride"
          class="sidebar-actions flex flex-nowrap items-stretch">
          <w-btn
            class="flex-1 px-2"
            flat
            dense
            icon="tabler:chevrons-left"
            :label="t('common.sidebar.collapse')"
            :aria-label="t('common.sidebar.collapse')"
            size="sm"
            @click="sidebarExpandOverride = false" />
        </div>
        <div v-if="showSidebarActions" class="sidebar-actions flex flex-nowrap items-stretch">
          <!-- -> Either button takes the whole row when the other one is off, and the separator only
               exists to divide the two, so it goes with them -->
          <template v-if="siteStore.locales.showMenu">
            <w-btn
              class="icon-lg sidebar-actions-locale px-2"
              flat
              dense
              icon="tabler:language"
              :label="commonStore.locale"
              :aria-label="commonStore.locale"
              size="sm">
              <locale-selector-menu :offset="[-5, 5]" />
            </w-btn>
            <w-separator v-if="canBrowse" vertical />
          </template>
          <w-btn
            v-if="canBrowse"
            class="icon-lg flex-1 px-2"
            flat
            dense
            icon="tabler:sitemap"
            :label="t(`common.sidebar.browse`)"
            :aria-label="t(`common.sidebar.browse`)"
            size="sm">
            <nav-browse-menu :offset="[-5, 5]" />
          </w-btn>
          <!--
            -> Trailing "Top" cell -- ALWAYS reserved at 40x40 (`.sidebar-actions-top` below), so
               Locale/Browse above never shift width the moment this fades in. The separator fades
               in step with the button, both keyed off `showSidebarTop`; at page top the wrapper is
               still here holding the width, just empty, per the WP's own "cell is empty" wording.
               The button itself mounts/unmounts on a v-if inside a <transition> rather than merely
               toggling opacity, so it drops out of the tab order and the accessibility tree while
               hidden with no extra `tabindex`/`aria-hidden` bookkeeping needed here.
          -->
          <w-separator
            vertical
            class="sidebar-actions-top-sep"
            :class="{ 'opacity-0': !showSidebarTop }" />
          <div class="sidebar-actions-top flex items-center justify-center">
            <transition name="sidebar-actions-top-fade">
              <w-btn
                v-if="showSidebarTop"
                flat
                dense
                icon="tabler:arrow-up"
                :label="t(`common.sidebar.top`)"
                :aria-label="t(`common.actions.returnToTop`)"
                size="sm"
                @click="scrollSidebarToTop" />
            </transition>
          </div>
        </div>
        <nav-sidebar ref="navSidebarEl" />
        <!-- -> Edit Nav is the whole bar now, so it is also what decides whether there is one.
                Not a `w-bar` (Feature 2604 conformance pass): its `dense` variant's own translucent
                fill and forced 8px button label are scoped inside `WBar.vue` and cannot be
                overridden from here without `:deep`/`!important` -- see `.sidebar-footerbtns`
                below, which owns this bar's look outright instead. -->
        <div v-if="showEditNav" class="sidebar-footerbtns flex flex-nowrap items-stretch">
          <!-- -> Invisible: exists only to give this bar the SAME natural height as `.site-footer`'s
                  own text line (`FooterNav.vue`) -- see the CSS comment below. -->
          <span class="sidebar-footerbtns-spacer" aria-hidden="true">&nbsp;</span>
          <w-btn class="flex-1" icon="tabler:list-tree" :label="t(`common.sidebar.editNav`)" flat>
            <w-menu ref="navEditMenu" anchor="top left" self="bottom left" :offset="[0, 10]">
              <nav-edit-menu
                :menu-hide-handler="navEditMenu.hide"
                :update-position-handler="navEditMenu.updatePosition" />
            </w-menu>
          </w-btn>
        </div>
      </template>
    </w-drawer>
    <!--
      The way back to the sidebar on a narrow viewport, where it overlays the page instead of taking a
      column of its own: closed to start with, so it is not sitting over the article on arrival, and
      nothing else on that screen opens it -- the header is full of page actions and has no room for a
      menu button.

      Bottom LEFT whichever side the sidebar is on, because the opposite corner is reserved for a page
      view's own contents-panel opener below 750px (`showTocPanelBtn` in `pages/Index.vue`) -- a
      hamburger that followed the sidebar to the right would land on top of it there. OpenProject #2894
      retired the scroll-to-top corner disc this button used to pair with at 750-1199px (the sidebar's
      own "Top" cell, `.sidebar-actions-top` below, covers that now) -- so in that band this is the only
      fixed corner button left, still anchored physically rather than logically for consistency with the
      narrower band where it does pair with one.

      The position goes on a wrapper rather than on the button: `WBtn` is `relative` from its own class
      list, and Tailwind emits `relative` after `fixed`, so a `fixed` alongside it loses.

      Hard into the corner, with the corner facing the page rounded and the other three square -- see
      `.corner-btn`. No margin, so the button is not a disc hovering near the edge of a small screen but
      a piece of the screen's own corner, and every pixel of it is inside the viewport.

      `left-0` (not `start-0`) is deliberate -- OpenProject #1590's physical-positioning triage: a fixed
      screen corner, not a reading-direction gutter, so it must not move when the locale does. See
      `frontend/src/physicalPositioning.test.js`.
    -->
    <transition name="corner-btn">
      <div v-if="showSidebarBtn" class="fixed bottom-0 left-0 z-30">
        <w-btn
          class="corner-btn corner-btn--left"
          icon="tabler:menu-2"
          color="primary"
          round
          size="md"
          :aria-label="t(`common.sidebar.mainMenu`)"
          @click="openSidebar" />
      </div>
    </transition>
    <!--
      No `<w-footer>` here, unlike every other layout: this one only ever holds the page view, and
      there the article column scrolls inside a shell that holds still, so a footer at this level
      would be pinned to the window no matter which row it took. The page view puts it at the end of
      that scrolling column instead -- see `pages/Index.vue`.
    -->
    <w-page-container>
      <router-view />
    </w-page-container>
    <main-overlay-dialog />
  </w-layout>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'

import { useMeta } from '@/composables/meta'
import { useMinWidth } from '@/composables/screen'
import { useI18n } from 'vue-i18n'

import { useCommonStore } from '@/stores/common'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

// COMPONENTS

import HeaderNav from '@/components/HeaderNav.vue'
import LocaleSelectorMenu from '@/components/LocaleSelectorMenu.vue'
import NavBrowseMenu from '@/components/NavBrowseMenu.vue'
import NavSidebar from '@/components/NavSidebar.vue'
import NavEditMenu from '@/components/NavEditMenu.vue'
import MainOverlayDialog from '@/components/MainOverlayDialog.vue'

// STORES

const commonStore = useCommonStore()
const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// META

/*
  A getter that READS the site title, so `watchEffect` has something to track: the site config is
  fetched, so a template closing over `siteStore.title` and registered once would keep whatever the
  store held at mount. The page title alone no longer forces a recompute either, now that a page with
  no title of its own -- the welcome screen, a path with no page -- has to fall back to the site name
  rather than leaving the tab reading " - Site".
*/
useMeta(() => {
  const siteTitle = siteStore.title
  return {
    titleTemplate: (title) => (title ? `${title} - ${siteTitle}` : siteTitle)
  }
})

// REFS

const navEditMenu = ref(null)
const navEditMenuMini = ref(null)

// DATA

/**
 * Whether the reader has opened the overlaying sidebar. Only consulted on a narrow viewport, where
 * the drawer is the only thing over the page and closing it is a state of its own; on a wide one the
 * sidebar is a column that is simply there.
 */
const isNarrowSidebarOpen = ref(false)

// COMPUTED

/**
 * Where this sidebar stops overlaying the page and takes its own column of its own.
 *
 * 1200 rather than `WDrawer`'s default of 1024: this sidebar is 255px, and the page beside it gives up a
 * contents column of its own before this point — so by ~1150px the article is the narrowest of the three
 * things sharing the window. Passed INTO the drawer rather than changed there, so the admin area's drawer
 * keeps the 1024 it was written against.
 *
 * `NavSidebar` has to agree with it too: the dent marking the current page is only meaningful while the
 * sidebar is beside the content. See `$sidebar-overlay-max` there.
 */
const SIDEBAR_OVERLAY_BELOW = 1200

/**
 * The same boundary as a reactive flag, for everything in this layout that has to know which mode the
 * drawer is in — the scroll-to-top button's anchor and shape, and whether the sidebar needs an opener.
 */
const isWideViewport = useMinWidth(SIDEBAR_OVERLAY_BELOW)

/**
 * The phone boundary — the `sm` breakpoint from `css/tailwind.css`, and a different question from the one
 * above: that one is about the LAYOUT (has the drawer got a column of its own), this one is about whether
 * there is ROOM for an authoring control at all -- a width-based proxy, deliberately, not a literal
 * pointer-capability query. See `showEditNav` for why.
 */
const isAtLeastSm = useMinWidth(600)

/** Whether this site, page and mode have a sidebar at all — before asking whether it is open. */
const isSidebarAvailable = computed(() => {
  return (
    siteStore.showSideNav &&
    !siteStore.sideNavIsDisabled &&
    !(editorStore.isActive && editorStore.hideSideNav)
  )
})

/**
 * Whether the sidebar is on screen: always on a wide viewport, where it has a column of its own, and
 * only once asked for on a narrow one, where it overlays the page.
 *
 * It used to be `isSidebarAvailable` on its own, bound one-way — so on a phone the sidebar came up
 * over the article on every page load and there was no way to put it away: the drawer asks to be
 * closed when its scrim is tapped, and with no listener for that the request went nowhere.
 */
const isSidebarOpen = computed({
  get: () => isSidebarAvailable.value && (isWideViewport.value || isNarrowSidebarOpen.value),
  // -> Only ever reached from the scrim, which exists only while overlaying
  set: (val) => {
    isNarrowSidebarOpen.value = val
  }
})

/*
  Shown only where the sidebar is something to open: a narrow viewport, on a site and a page that have
  one. Not while it is already open -- the scrim is what closes it, and the button would be behind the
  panel in any case.
*/
const showSidebarBtn = computed(() => {
  return isSidebarAvailable.value && !isWideViewport.value && !isNarrowSidebarOpen.value
})

/**
 * The menu id a CONTENT route (`route.meta.contentPage`) resolves to: `pageStore.navigationId`, set
 * exclusively by `pageStore.pageLoad()`. `null` on every other route this layout renders -- the
 * knowledge graph, tags browse -- which never call `pageLoad()` at all, so `pageStore.navigationId`
 * there is either `null` on a fresh store or a stale value left by whichever content page was viewed
 * last; neither says anything about the current, non-content route. Those routes resolve their own
 * menu id a different way, straight off `siteStore.navigationId` (the bootstrap-supplied site
 * default, OpenProject #2527) -- see `NavSidebar.vue`'s own `effectiveNavigationId`, which is what
 * actually loads that menu's items. This computed exists only for the mini-rail check immediately
 * below, which -- deliberately, per #2512 -- has no opinion about a non-content route at all.
 */
const effectiveNavigationId = computed(() =>
  route.meta.contentPage ? pageStore.navigationId : null
)

/**
 * Whether this page/view WANTS the sidebar collapsed to its mini rail -- either a deliberate
 * `navigationMode: 'hide'/'hideExact'` on the page, or a CONTENT page that hasn't resolved a menu id
 * yet. Kept apart from `isSidebarMini` below so `sidebarExpandOverride` has something to negate: the
 * mini rail isn't empty chrome (it renders real shortcuts), so a reader who wants it back at full
 * width for a while needs a way to override this without the wiki forgetting the page itself still
 * asks for mini.
 *
 * OpenProject #2512: the "no id yet" half is meant to catch a CONTENT page that hasn't finished
 * telling `pageStore` which menu it belongs to yet -- not to double as a generic default for every
 * other route this layout renders. `effectiveNavigationId` above is what scopes that: it is `null`
 * for every non-content route regardless of the (irrelevant) site-default id, so this term stays
 * `false` there exactly as before -- graph/tags never force the mini rail, which is what lets
 * OpenProject #2527's fix populate their nav data into a normally-expanded sidebar rather than
 * collapsing it.
 */
const isSidebarMiniForced = computed(() => {
  return (
    ['hide', 'hideExact'].includes(pageStore.navigationMode) ||
    (Boolean(route.meta.contentPage) && !effectiveNavigationId.value)
  )
})

/**
 * A reader's own override of `isSidebarMiniForced`, remembered for the rest of their browser tab
 * session (OpenProject #2513) -- not per-page-visit (it should still hold after following a link to
 * another page that also forces mini) and not a permanent cross-session preference (the page/view
 * author's own choice is still the default the NEXT time this reader opens the wiki). `sessionStorage`
 * is exactly that middle ground: scoped to this tab, gone once it closes.
 *
 * Reading/writing it is wrapped in try/catch -- a sandboxed or privacy-hardened browser can throw on
 * storage access entirely, and a reader hitting that should still get a working toggle for the rest of
 * this page view, just not one that survives a reload.
 */
const SIDEBAR_EXPAND_OVERRIDE_KEY = 'sidebarExpandOverride'

function readSidebarExpandOverride() {
  try {
    return sessionStorage.getItem(SIDEBAR_EXPAND_OVERRIDE_KEY) === 'true'
  } catch {
    return false
  }
}

const sidebarExpandOverrideState = ref(readSidebarExpandOverride())

const sidebarExpandOverride = computed({
  get: () => sidebarExpandOverrideState.value,
  set: (val) => {
    sidebarExpandOverrideState.value = val
    try {
      sessionStorage.setItem(SIDEBAR_EXPAND_OVERRIDE_KEY, val ? 'true' : 'false')
    } catch {
      // -> No persistence across a reload in this case, but the in-memory ref above still drives
      //    the UI for the rest of this page view.
    }
  }
})

const isSidebarMini = computed(() => isSidebarMiniForced.value && !sidebarExpandOverride.value)

/*
  The way back to mini, offered only where the override is what's actually holding the sidebar open --
  never on a page that was full-width to begin with, which would make an unrelated "Collapse Sidebar"
  button appear the moment a reader used the toggle once anywhere on the site.
*/
const showSidebarCollapseOverride = computed(() => {
  return isSidebarMiniForced.value && sidebarExpandOverride.value
})

/** Sidebar widths, in px: the icon rail the full nav collapses to (unaffected by the auto-growing
 *  logic below) and the floor/cap the full nav itself is clamped between. */
const SIDEBAR_WIDTH_MIN = 255
const SIDEBAR_WIDTH_MAX = 510
const SIDEBAR_WIDTH_MINI = 56

/**
 * Auto-growing sidebar width (OpenProject #2850): the full-width drawer used to be the fixed
 * `SIDEBAR_WIDTH_MIN` above at all times. It now grows to fit the widest currently-visible nav
 * item label's own single-line content width -- so a label that would otherwise ellipsize
 * (#2849) gets the room it needs instead -- capped at `SIDEBAR_WIDTH_MAX` (2x the old fixed
 * width) so one long label cannot blow the sidebar out arbitrarily, and floored at the old fixed
 * width so a short or empty tree never renders narrower than the original design.
 */
const sidebarContentWidth = ref(SIDEBAR_WIDTH_MIN)

/** The mounted `NavSidebar` instance -- `.$el` is its single root DOM node (`NavSidebar.vue`'s
 *  own `<w-scroll-area class="sidebar-nav">`), queried directly below rather than having
 *  `NavSidebar`/`NavSidebarItem` expose a ref or emit of their own: per the epic's own
 *  coordination note, a DOM query scoped to this element keeps #2850 isolated to this file with
 *  no new cross-component surface for a sibling task touching the same components this round to
 *  collide with. Only populated while the full nav renders at all -- the mini rail's template
 *  branch never mounts `<nav-sidebar>`. */
const navSidebarEl = ref(null)

/**
 * Measures every rendered `.truncate` label under the mounted `NavSidebar` (the span
 * `NavSidebarItem.vue` gives each row, styled `white-space: nowrap; overflow: hidden` so
 * `scrollWidth` reports its full, un-clipped natural width regardless of how narrow the box
 * actually rendered) and sizes `sidebarContentWidth` to the widest one, clamped to
 * `[SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX]`.
 *
 * The width the WHOLE drawer would need to be for one label alone to stop clipping is
 * `sidebarContentWidth.value - label.clientWidth + label.scrollWidth`: `clientWidth` is
 * however much of that label's natural width the CURRENT drawer width actually gives it, so
 * `sidebarContentWidth.value - label.clientWidth` is everything else in that row -- icon,
 * padding, and this row's own nesting-depth indentation (`NavSidebar.vue`'s
 * `.w-expansion-item__content` gives every level a 10px indent via its own transparent
 * `border-inline-start`, which is exactly why a single fixed chrome constant across every row
 * would be wrong here). Every row spans the same drawer width regardless of its depth, so that
 * "everything else" figure is invariant to the drawer's width and can be read off however wide
 * the drawer happens to be measured right now.
 *
 * A collapsed folder's descendant rows sit inside a `v-show`-hidden `.w-expansion-item__content`
 * (Vue sets `display: none` on it) -- which zeroes BOTH `clientWidth` and `scrollWidth`, so
 * without an explicit visibility guard the formula above would misread such a label as needing
 * the full CURRENT width rather than nothing, permanently blocking the sidebar from ever
 * shrinking back down once grown. `offsetParent === null` is the standard "is this actually
 * rendered right now" check and is what excludes them instead.
 */
function measureSidebarWidth() {
  const root = navSidebarEl.value?.$el
  if (!root || typeof root.querySelectorAll !== 'function') {
    return
  }
  let widest = SIDEBAR_WIDTH_MIN
  for (const label of root.querySelectorAll('.truncate')) {
    if (label.offsetParent === null) {
      continue
    }
    const needed = sidebarContentWidth.value - label.clientWidth + label.scrollWidth
    if (needed > widest) {
      widest = needed
    }
  }
  sidebarContentWidth.value = Math.min(SIDEBAR_WIDTH_MAX, widest)
}

let sidebarMutationObserver = null

// Re-measures whenever the mounted `NavSidebar` itself changes -- its very first mount, and any
// later one (mini mode toggling off and back on unmounts/remounts `<nav-sidebar>` entirely, per
// the template above). A fresh instance means a fresh DOM node to observe, so the old observer
// (if any) is torn down and a new one attached -- the same "the ref's target node changed under
// me" convention `NavSidebarItem.vue` already uses for its own per-label `ResizeObserver`.
watch(navSidebarEl, (component) => {
  sidebarMutationObserver?.disconnect()
  sidebarMutationObserver = null
  const root = component?.$el
  if (!root || typeof root.querySelectorAll !== 'function') {
    return
  }
  nextTick(measureSidebarWidth)
  // -> A folder expanding/collapsing toggles its `.w-expansion-item__content`'s inline `display`
  //    (Vue's `v-show`) -- watching for a `style` attribute change anywhere in the tree is what
  //    re-measures on that, with no new prop/emit needed from `NavSidebarItem.vue` itself (see
  //    `measureSidebarWidth`'s own doc comment above).
  sidebarMutationObserver = new MutationObserver(measureSidebarWidth)
  sidebarMutationObserver.observe(root, {
    attributes: true,
    attributeFilter: ['style'],
    subtree: true
  })
})

onBeforeUnmount(() => sidebarMutationObserver?.disconnect())

// Recomputes as the nav tree itself changes -- a different menu resolving, an edit through
// `NavEditOverlay`, a locale switch. Deep, since an in-place edit to the tree (rather than a
// wholesale replacement of `siteStore.nav.items` itself) still has to trigger a re-measure.
watch(
  () => siteStore.nav.items,
  () => nextTick(measureSidebarWidth),
  { deep: true }
)

const sidebarWidth = computed(() =>
  isSidebarMini.value ? SIDEBAR_WIDTH_MINI : sidebarContentWidth.value
)

// -> The "Allow Browsing" site feature (admin/general): with it off the tree browser is not something
//    a reader can reach, so the button that opens it does not render
const canBrowse = computed(() => siteStore.features.browse)

// -> The action bar holds only the locale menu and Browse; with both off it would be an empty strip
const showSidebarActions = computed(() => siteStore.locales.showMenu || canBrowse.value)

/*
  The scroll threshold past which `.sidebar-actions`'s own trailing "Top" cell fades in, for the SAME
  scrolling column (`.page-container-scrl`) it answers the question for ("has the reader scrolled far
  enough down this page to want a way back up"). OpenProject #2894: this used to match a second,
  independently-declared 150px constant on the corner `WPageScroller` button that retired alongside it
  -- there is now exactly one back-to-top affordance for a page view, so exactly one such constant.
*/
const SIDEBAR_TOP_SCROLL_OFFSET = 150

/** Whether the sidebar strip's trailing "Top" cell (inside `showSidebarActions`) is showing right now. */
const showSidebarTop = ref(false)

function updateSidebarTopVisibility() {
  const el = document.querySelector('.page-container-scrl')
  showSidebarTop.value = (el ? el.scrollTop : 0) > SIDEBAR_TOP_SCROLL_OFFSET
}

function scrollSidebarToTop() {
  const el = document.querySelector('.page-container-scrl')
  // -> `smooth` is ignored under `prefers-reduced-motion`, which is the behaviour we want
  ;(el ?? window).scrollTo({ top: 0, behavior: 'smooth' })
}

/*
  Whether to offer Edit Nav, in either of the two places the sidebar has for it -- the footer bar of the
  full panel, and the small cog at the bottom of the icon rail. Two questions:

  Saving from that menu needs `manage:navigation`, so offering it to anyone else only produces a
  permission error once they press Save.

  And not on a phone, whatever the permission: rearranging a navigation tree is drag-and-drop work in a
  full-screen overlay, and the sidebar it hangs off is itself a panel the reader has just opened over the
  page -- there is no room left for a second overlay stacked on top of it, and dragging small nested
  targets accurately is poor UX on a touchscreen regardless of room.

  `isAtLeastSm` (viewport width, not a device-capability query) is a deliberate proxy for that, not an
  oversight: it is the same `sm` breakpoint `HeaderNav` and `PageHeader` already use to tell a phone
  layout from a desktop one, so this reuses a boundary the rest of the app is already built and tested
  against rather than introducing a second, untested way to ask the same question. A real
  `matchMedia('(any-pointer: fine)')` check was considered and rejected: it would be wrong in both
  directions that matter here -- it stays true on a touch-primary 2-in-1 laptop merely because a
  trackpad is also present (so it would not actually catch the touchscreen case this guards against),
  and it goes false on a touch-only tablet that is plenty wide enough to fit the overlay, whose drag
  library (`sortablejs-vue3`) handles touch input fine on its own. Width is what actually decides
  whether the overlay fits, which is the more load-bearing of the two reasons above -- read this as a
  layout-room gate with a touch-UX rationale attached, not a literal pointer-capability check.

  (Also NOT "the same call as the page header's authoring actions", despite an earlier version of this
  comment claiming that: `PageHeader`'s own Edit button is gated on `write:pages` alone, at no
  breakpoint at all -- editing a page's content works fine at phone width, so nothing there needed this
  gate to begin with.)
*/
const showEditNav = computed(() => {
  return userStore.authenticated && userStore.can('manage:navigation') && isAtLeastSm.value
})

// WATCHERS

/*
  Following a link out of the overlaying sidebar puts it away, since what the reader asked for is
  behind it. On a wide viewport there is nothing to close and the flag is not consulted anyway.

  The freshly-routed page's own `.page-container-scrl` starts scrolled to the top, so the "Top" cell
  recomputes here too rather than waiting for the next scroll event -- otherwise a reader who leaves
  the PREVIOUS page scrolled down would land on the new one still showing "Top" until they scroll it
  themselves.
*/
watch(
  () => route.path,
  () => {
    isNarrowSidebarOpen.value = false
    updateSidebarTopVisibility()
  }
)

// METHODS

function openSidebar() {
  isNarrowSidebarOpen.value = true
}

// SIDEBAR ACTIONS: TOP

/*
  `capture`, because a scroll event on an element (`.page-container-scrl`) does not bubble to the
  window.
*/
onMounted(() => {
  window.addEventListener('scroll', updateSidebarTopVisibility, { capture: true, passive: true })
  updateSidebarTopVisibility()
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', updateSidebarTopVisibility, { capture: true })
})

// ENTRANCE FLOURISH

/**
 * OpenProject #2747/#2751: whether to play the authenticated shell's staggered entrance flourish --
 * true only when this mount is a landing straight off a successful login (Task A, #2750:
 * `AuthLoginPanel.vue` sets `ENTRANCE_FLOURISH_KEY` in `sessionStorage` immediately before its hard
 * `window.location.replace()`) and `prefers-reduced-motion` is not set. `false` for a plain page
 * refresh within the same session -- the flag is read-and-cleared below, so it isn't there to find a
 * second time -- and `false` under reduced motion regardless, matching the skip on the login side.
 *
 * Set once in `onMounted` and never toggled back: this layout is not remounted by an in-SPA
 * navigation (`router-view` swaps underneath it), so there is no subsequent "arrival" to gate.
 */
const ENTRANCE_FLOURISH_KEY = 'cardinal:justLoggedIn'
const playEntranceFlourish = ref(false)

onMounted(() => {
  let justLoggedIn = false
  try {
    justLoggedIn = sessionStorage.getItem(ENTRANCE_FLOURISH_KEY) !== null
    if (justLoggedIn) {
      sessionStorage.removeItem(ENTRANCE_FLOURISH_KEY)
    }
  } catch {
    // -> A sandboxed/privacy-hardened browser that throws on storage access renders with no
    //    animation, same as the plain-refresh case -- there is nothing more this can safely check.
  }
  if (justLoggedIn && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    playEntranceFlourish.value = true
  }
})
</script>

<style lang="scss">
/*
  `position: fixed` at all times, not only once focused: `.w-layout` (the parent) is a CSS grid
  with every one of its ordinary children placed by a named `grid-area` (header/drawer/main/footer)
  -- an item with none of its own falls to the grid's auto-placement algorithm instead, which is
  not where a skip link belongs. `position: fixed` takes it out of grid placement entirely in both
  states, so there is nothing here for the grid to fit it into to get wrong.

  Off-screen via `transform` rather than `sr-only`-style clipping, so this owns its own visibility
  outright: a class-based visually-hidden utility paired with a `:focus` variant is two rules
  fighting over `position` on the same element (the utility's `:focus` form necessarily wins that
  fight on specificity alone), which would undo the fixed positioning above the moment this is
  focused -- right when it needs to hold its position on screen the most.
*/
.skip-link {
  position: fixed;
  top: 8px;
  inset-inline-start: 8px;
  z-index: 100;
  padding: 8px 16px;
  background-color: var(--color-primary);
  color: #fff;
  font-weight: 500;
  text-decoration: none;
  transform: translateY(-150%);
  transition: transform 0.15s var(--ease-standard, ease);

  &:focus {
    transform: translateY(0);
  }
}

/*
  The strip across the top of the sidebar holding the locale switcher and the tree browser. A flat
  38px band ruled off underneath -- the gradient it used to carry (a white sheen fading to a black
  wash) was relief, and read as a bevel on a tint that is four percent off white.

  One hairline, drawn here and nowhere else: `NavSidebar`'s own `.sidebar-nav` sits directly below
  this band and draws no top edge of its own, so the seam between them stays a single 1px rule, the
  same as the one between `.page-breadcrumbs` and `<page-header>`. When this band isn't rendered at
  all (`showSidebarActions` false), `NavSidebar` sits flush under `HeaderNav`'s own `.site-header`
  bottom edge instead, so the line is still there -- just drawn by the header rather than by this.
*/
/*
  The locale-switcher / Browse row at the head of the reader sidebar. Both the rule under it and the
  two labels on it are the SIDEBAR's own tones rather than the app's generic chrome
  (`--color-sidebar-actions-text` / `--color-sidebar-hairline`, `tailwind.css`): the row sits on the
  sidebar's ground, so it has to follow it, and Cobalt's ground is a deep indigo where the generic
  `--color-slate` is unreadable. Ledger's own defaults for both tokens are the constants this rule
  used to name, so nothing moves there -- `Page View 3x - Cobalt` draws the row's labels at
  `#c5cff5`, which is what the token resolves to under Cobalt.
*/
.sidebar-actions {
  // -> A true 40px interior: with the 1px `border-bottom` below and this box in `border-box` sizing
  //    (Tailwind's preflight default), the content area is exactly 40px -- replacing the old
  //    38px/37px band now that a third cell (Top) has to share the row on equal footing.
  height: 41px;
  border-bottom: 1px solid var(--color-sidebar-hairline);

  // -> Where the buttons above get their colour, so none of them carries a `color` prop: `WBtn`
  //    emits an inline `color`, which would outrank this rule
  .w-btn {
    color: var(--color-sidebar-actions-text);
  }

  // -> OpenProject #2788: WBtn's own `.w-icon` rule (`.w-btn :deep(.w-icon) { font-size: 1.715em }`)
  //    scales off `size="sm"`'s 10px button font-size, landing at ~17px -- undersized next to the
  //    label here. `.icon-lg` (Locale and Browse only, not the sibling Collapse button below) pins
  //    those two icons to 20px explicitly. `!important` because this plain rule and WBtn's own
  //    scoped one tie on specificity, and which stylesheet loads later is not something to rely on.
  .icon-lg .w-icon {
    font-size: 20px !important;
  }
}

/*
  Locale is a FIXED-width cell (unlike Browse's `flex-1`, which absorbs whatever Locale doesn't
  claim) -- OpenProject #2861. `overflow: hidden` is a plain safety net for a locale code long
  enough to overrun 72px (e.g. `pt-BR`); the mockup calls for a fixed cell, not an ellipsis, so
  nothing fancier is added here.
*/
.sidebar-actions-locale {
  flex: 0 0 72px;
  width: 72px;
  overflow: hidden;
}

/*
  The trailing "Top" cell -- ALWAYS 40x40, whether or not the button inside it is currently mounted
  (see the template comment above it), which is what keeps Locale/Browse from shifting width the
  moment scrolling brings it in.
*/
.sidebar-actions-top {
  flex: 0 0 40px;
  width: 40px;
}

// -> Fades in step with the button it leads, on the same 150ms/opacity terms
.sidebar-actions-top-sep {
  transition: opacity 0.15s var(--ease-standard);
}

.sidebar-actions-top-fade-enter-active,
.sidebar-actions-top-fade-leave-active {
  transition: opacity 0.15s var(--ease-standard);
}
.sidebar-actions-top-fade-enter-from,
.sidebar-actions-top-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-actions-top-sep,
  .sidebar-actions-top-fade-enter-active,
  .sidebar-actions-top-fade-leave-active {
    transition-duration: 0.01ms;
  }
}

.body--dark:not(.body--cobalt) .sidebar-actions {
  border-bottom-color: var(--color-hairline-dark);

  .w-btn {
    color: var(--color-text-secondary-dark);
  }
}

/*
  OpenProject #2862 ("Sidebar strip: Ledger + Cobalt visual treatment"): the theme-specific finish
  on top of #2861's structural locale|browse|top strip -- `ui-iteration/README.md` Part 1.4.

  Both cell separators (the plain Locale|Browse one and `.sidebar-actions-top-sep`) are already
  `<w-separator>`s, which paint through `--w-hairline-color` (see `.w-hairline` in `tailwind.css`)
  rather than a plain `border` -- Part 1.3's "border-right on the cells, not freestanding spans" is
  what #2861 built them as, so recolouring that hook is what stands in for the mockup's literal
  `border-right: 1px solid #dbe1ec`/`#2a3040` here, rather than adding a second rule mechanism.
*/
.sidebar-actions .w-separator {
  --w-hairline-color: var(--color-hairline);
}

.sidebar-actions-top .w-btn {
  // -> Ledger's "white plate": filled and coloured at rest, not only on hover, unlike Locale/Browse
  background-color: var(--color-white);
  color: var(--color-accent);

  &:hover {
    background-color: var(--color-accent-wash);
  }

  // -> Pins the arrow-up to the mockup's 15px regardless of WBtn's own em-scaled icon rule -- the
  //    same tie this file's `.icon-lg .w-icon` rule above already documents (OpenProject #2788).
  .w-icon {
    font-size: 15px !important;
  }

  // -> WBtn's content wrapper flips from its default row to a column, so "TOP" sits under the
  //    arrow rather than beside it -- the only way both fit inside a 40px (Ledger) or 32px
  //    (Cobalt) cell. Scoped to the Top cell alone; every other labelled button keeps WBtn's row.
  > span {
    flex-direction: column;
    gap: 1px;
  }

  // -> The "TOP" label itself: Roboto Mono, uppercased here rather than in the translation string
  //    so `common.sidebar.top` stays natural-case ("Top"), matching `NavSidebar.vue`'s section
  //    kicker convention. Sized off its own rule rather than the button's `font-size`, which the
  //    inline `min-height`/`padding` styles are `em`-relative to and would shrink along with it.
  > span > span {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 7.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
}

.body--dark:not(.body--cobalt) {
  .sidebar-actions .w-separator {
    --w-hairline-color: var(--color-hairline-dark);
  }

  // -> Specificity-tied with the generic `.sidebar-actions .w-btn { color: ... }` dark override
  //    above; wins on source order, declared after it, same as that rule's own sibling overrides.
  .sidebar-actions-top .w-btn {
    background-color: var(--color-dark-2);
    color: var(--color-accent-dark);

    &:hover {
      background-color: rgb(240 130 135 / 0.14);
    }
  }
}

/*
  Cobalt: no rules at all (`ui-iteration/README.md` 1.1's global "remove every hairline rule"
  applies to this strip too) -- both separators disappear outright rather than fading to a
  near-invisible tint, and the strip's own bottom rule goes with them. `--color-sidebar-hairline`
  itself stays untouched: it is shared with `NavItemEditor.vue`/`InboxOverlay.vue`, outside this
  WP's scope, so the fix is local to this component instead of the shared token.
*/
body.body--cobalt {
  .sidebar-actions {
    border-bottom: none;
  }

  .sidebar-actions .w-separator {
    display: none;
  }

  // -> Locale and Browse become flat, inset tiles. `rounded-control` (WBtn's own default corner
  //    class, applied to every non-round/non-rounded button) already resolves to Cobalt's 6px, so
  //    only the inset margin and hover wash are new here. Icon and label take different tones --
  //    the sidebar's icon token vs. its actions-text token -- unlike Ledger, where both inherit the
  //    same `.w-btn` colour from the rule at the top of this file.
  .sidebar-actions .icon-lg {
    margin: 4px 0 4px 4px;

    &:hover {
      background-color: rgb(255 255 255 / 0.08);
    }

    .w-icon {
      color: var(--color-sidebar-icon);
    }
  }

  // -> 32x32, not the 40px cell it sits inside -- `!important` on padding beats WBtn's own inline
  //    `style` binding (dense's `padding: 0 0.8em`), which no external stylesheet rule can
  //    outrank otherwise.
  .sidebar-actions-top .w-btn {
    background-color: transparent;
    color: #ff8f97;
    width: 32px;
    height: 32px;
    padding: 0 !important;

    &:hover {
      background-color: rgb(255 77 90 / 0.18);
    }
  }
}

.sidebar-mini {
  height: 100%;
}

/*
  No background of its own, and nothing sticky: the drawer is the height of the shell and the nav list
  above scrolls inside itself, so this bar sits at the bottom of the window by being last in the
  column. Ruled off from the list above, matching the strip at the top of the same column.

  This used to be a `w-bar` (dense), which is where the old "dark muddy" look came from --
  `WBar.vue`'s own translucent black wash, present regardless of theme, plus its dense variant
  forcing every `.w-btn` inside down to an 8px label. Neither is wanted here: the bar should read
  like the rest of the sidebar's chrome (no fill of its own, the flat button's ordinary hover), so
  it is a plain element this rule owns outright instead.

  Height: matches `.site-footer` (`FooterNav.vue`) -- the "Powered by Cardinal.js" line at the foot
  of the article column -- so the two bookend bars read as the same band. Not a hardcoded pixel
  guess: `.sidebar-footerbtns-spacer` is an invisible line built from the SAME font stack, size and
  vertical padding `.site-footer` renders its own text with, so it takes on the SAME natural height
  that text line does in whichever browser/OS/font-fallback actually renders it, and `items-stretch`
  (the template's own Tailwind class, a flex row's default cross-axis behaviour) sizes the real
  button to match. A future edit to `.site-footer`'s own font or padding keeps this in step for
  free -- `MainLayout.test.js` asserts the two stay equal -- rather than a bare pixel value copied
  from one measurement, which would not.
*/
.sidebar-footerbtns {
  flex-shrink: 0;
  border-top: 1px solid var(--color-sidebar-hairline);
  color: var(--color-text-secondary);

  /*
    Cobalt's own "Edit navigation" row is `--color-sidebar-text-secondary` (`#a7b3ea`, identical in
    both mockups) rather than the general `var(--color-text-secondary)` this reused -- additive, since Ledger's
    own default for the token is a different generic tone, not this one (OpenProject #2774).
  */
  body.body--cobalt & {
    color: var(--color-sidebar-text-secondary);
  }

  .sidebar-footerbtns-spacer {
    flex: 0 0 0;
    width: 0;
    overflow: hidden;
    padding: 8px 0;
    font-family: var(--font-mono);
    font-size: 11px;
    visibility: hidden;
  }

  .w-btn {
    // -> WBar's dense override used to force this down to 8px; the library's own un-dense default
    //    (12.5px) is still smaller than a nav row's label, so it is stated explicitly here instead.
    //    `min-height` is WBtn's own inline style (em-relative to ITS font-size), which would
    //    otherwise outgrow the band this bar's height is built to match -- reset so the flex
    //    stretch above is what actually sizes it.
    min-height: auto !important;
    font-size: 14px;
  }
}

.body--dark .sidebar-footerbtns {
  border-top-color: var(--color-hairline-dark);
  color: var(--color-text-secondary-dark);
}

/*
  The app's own ground, behind every column. `--color-paper` rather than white: Cardinal's surfaces
  (the header band, the content column, a card) are white, and the paper behind them is what makes
  each of them read as a plate rather than as more of the same sheet.
*/
body {
  background-color: var(--color-paper);
}

body.body--dark {
  background-color: var(--color-dark-6);
}

// -> Ported from the Quasar dialog internals onto WDialog's own structure:
//    .q-dialog__backdrop -> .w-dialog-backdrop, .q-dialog__inner -> .w-dialog-viewport,
//    .q-layout-container -> .w-dialog-panel
.main-overlay {
  > .w-dialog-backdrop {
    background-color: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(5px) saturate(180%);
  }
  > .w-dialog-viewport {
    /*
      Equal margins all round, until there is width to spare for more.

      64px down each side is pitched for a wide desktop; on a 1280 or 1440 window it is an eighth of
      the screen taken off a panel that is a file listing or a table, and the overlay ends up narrower
      than the page it was opened from. Below 1600 the sides come in to match the 24px above and below,
      which is the clearance that says "over the page" -- more than that is decoration.

      1600 is this rule's own number, not one of the app's `--breakpoint-*`: it is where an overlay is
      wide enough that 128px of it can go to margins without the content noticing.
    */
    padding: 24px;

    @media (min-width: 1600px) {
      padding: 24px 64px;
    }

    // -> Last of the three, so it still wins on a phone: all three have the same specificity
    @media (max-width: $breakpoint-sm-max) {
      padding: 0;
    }

    /*
      A flat panel under a solid ink edge, with enough shadow to say it is over the page rather than
      in it. The edge is the design's own (`ui-redesign/Cardinal Wiki - Inbox 3x.dc.html`): 10px of
      ink across the top, above the overlay's own dark title bar, which is what makes an overlay read
      as a thing laid over the wiki rather than a region of it. What it replaces was a GRADIENT
      standing in for a title bar -- a dark strip fading to grey -- and the two are not the same
      drawing.
    */
    > .w-dialog-panel {
      box-shadow: 0 0 30px rgba(0, 0, 0, 0.4);
      border-top: 10px solid var(--color-dark-5);

      @at-root .body--light & {
        background-color: var(--color-surface);
      }
      @at-root .body--dark & {
        background-color: var(--color-dark-5);
        border-top-color: var(--color-dark-6);
      }

      /*
        Cobalt (DESIGN-DECISIONS.md "Themes": "Dialogs and overlays ... take a 12px radius with
        `overflow:hidden` ... No dark eyebrow bar on dialog tops -- the rounded corner is the
        edge") -- OpenProject #2776 found every full-bleed overlay (File Manager, Page History
        alongside the rest `MainOverlayDialog.vue` mounts) still drawing Ledger's flat panel with
        its 10px ink strip regardless of aesthetic, since nothing here branched on it. The strip
        is removed rather than recoloured: Cobalt's own mockups (`Cardinal Wiki - File Manager 3x
        - Cobalt.dc.html`, `Cardinal Wiki - History 3x - Cobalt.dc.html`) draw a plain rounded
        panel with no title-band edge at all.

        OpenProject #2864: that fix gave THIS box the fill, the radius AND the `overflow: hidden`
        clip together, which is exactly the combination `ui-iteration/README.md` Part 1.2 traces
        the corner fringe to -- a dark, flat-cornered `.card-header` clipped by a filled ancestor's
        rounded `overflow: hidden` leaves a light antialiasing sliver at the two top corners
        (confirmed in the deployed app). The panel now draws no fill of its own and does not clip;
        `border-radius` stays so its `box-shadow` above still follows the rounded outline. The
        header and body below round and fill THEMSELVES instead, so there is no shared clip
        boundary between two differently-coloured boxes for a browser to antialias.
      */
      @at-root .body--cobalt & {
        border-top: 0;
        border-radius: var(--radius-dialog);
        background: transparent;
        overflow: visible;
      }

      /*
        `.card-header` is the shared title-band class 60+ dialogs use (`css/_base.scss`), not
        something owned by any one overlay -- every entry `MainOverlayDialog.vue` mounts (Inbox,
        Profile, File Manager, History, Table Editor, Edit Menu Items, Block Picker, ...) renders
        one as its own first element, so rounding it here (scoped under `.main-overlay`) reaches
        all of them without editing a single overlay component.

        The body "wrapper" is whatever sibling(s) follow the header inside that overlay's own
        layout -- a single `.w-page-container` for most of them, a left and/or right `w-drawer`
        flanking it for File Manager and Inbox. `+ *` matches only the FIRST such sibling (rounds
        its own outer bottom-left corner) and `~ *:last-child` only the LAST one (rounds its own
        outer bottom-right corner); a lone body element matches both rules and gets both corners,
        while a middle element sitting between two others (a table's own `main` cell when both
        drawers are open) matches neither and stays square -- correctly, since it never reaches the
        panel's outer edge and rounding it would carve a false notch into its own interior seam.
        `--float-bg` is the existing per-aesthetic "raised surface" token (`#fff` in Cobalt light,
        the dark ramp's own "card, dialog body" rung in Cobalt dark) -- reused rather than a new
        custom property, since it already resolves correctly for both.
      */
      @at-root .body--cobalt & .card-header {
        border-radius: var(--radius-dialog) var(--radius-dialog) 0 0;
      }
      @at-root .body--cobalt & .card-header + * {
        background: var(--float-bg);
        overflow: auto;
        border-bottom-left-radius: var(--radius-dialog);
      }
      @at-root .body--cobalt & .card-header ~ *:last-child {
        background: var(--float-bg);
        overflow: auto;
        border-bottom-right-radius: var(--radius-dialog);
      }
    }
  }

  /*
    The half-viewport entries (Profile, Inbox) take a floor but no ceiling -- see
    `MainOverlayDialog.vue`'s `HALF_SIZE`. `min-width` is `min(560px, 100%)` rather than a flat
    560px so the panel still fits a phone, where 100% is the smaller of the two.
  */
  &.is-half-sized > .w-dialog-viewport > .w-dialog-panel {
    min-width: min(560px, 100%);
    min-height: 420px;
  }
}

// -> The `.q-footer .q-bar` rule that used to sit here never matched: FooterNav renders
//    `.site-footer`, never a q-bar. Its colours live in FooterNav's own scoped style.

.syncing-enter-active {
  animation: syncing-anim 0.1s;
}
.syncing-leave-active {
  animation: syncing-anim 1s reverse;
}
@keyframes syncing-anim {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

/*
  OpenProject #2747/#2751: the authenticated shell's entrance flourish, played once on arrival
  straight from a successful login -- see `script setup`'s `playEntranceFlourish` for when the class
  below is actually added (never under `prefers-reduced-motion`, never on a plain same-session
  refresh).

  Plain `@keyframes` `animation`s rather than `transition`s: a transition only runs on a property
  CHANGE, which would need a two-step "render hidden, then flip to visible next tick" dance. An
  animation runs the moment the class carrying it is present in the DOM, so it's enough that the
  class is added once in `onMounted` and never removed again -- this layout is not remounted by an
  in-SPA navigation, so there is no second "arrival" to replay it for.
*/
.main-layout--entrance-flourish {
  .site-header-wrap {
    animation: main-layout-entrance-header 280ms ease-out both;
  }

  /*
    -> The drawer's own contents (full panel or mini rail) -- not its open/close slide, which
       `WDrawer`'s own `<transition name="w-drawer">` already owns and does not fire on initial
       mount regardless.
  */
  .bg-sidebar {
    animation: main-layout-entrance-fade 280ms ease-out 80ms both;
  }

  /*
    -> The routed page's content. Its own opacity fade already carries a nested `FooterNav` along
       for free (an ancestor's opacity composites its whole subtree); the extra rule below adds that
       footer's OWN slide-up on top of the same fade, where the landed route renders one at all.
  */
  .w-page-container {
    animation: main-layout-entrance-fade 280ms ease-out 160ms both;

    .site-footer {
      animation: main-layout-entrance-footer 280ms ease-out 160ms both;
    }
  }
}

@keyframes main-layout-entrance-header {
  from {
    transform: translateY(-100%);
  }
  to {
    transform: translateY(0);
  }
}

@keyframes main-layout-entrance-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes main-layout-entrance-footer {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  // -> Defence in depth: `playEntranceFlourish` is already false whenever this media query matches,
  //    so `.main-layout--entrance-flourish` is never added in the first place -- this holds even if
  //    it were ever toggled some other way, matching the same convention `Login.vue`'s `&--exiting`
  //    block follows on the login side of this feature.
  .main-layout--entrance-flourish {
    .site-header-wrap,
    .bg-sidebar,
    .w-page-container,
    .w-page-container .site-footer {
      animation: none;
    }
  }
}
</style>
