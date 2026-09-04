<template>
  <w-layout>
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
      v-model="isSidebarOpen"
      :width="sidebarWidth"
      :overlay-below="SIDEBAR_OVERLAY_BELOW"
      :side="siteStore.theme.sidebarPosition === `right` ? `right` : `left`">
      <div v-if="isSidebarMini" class="sidebar-mini flex flex-col items-stretch">
        <w-btn
          v-if="siteStore.locales.showMenu"
          class="py-4"
          flat
          icon="la:globe"
          color="white"
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
          icon="la:sitemap"
          color="white"
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
          icon="la:dharmachakra"
          color="white"
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
        <div v-if="showSidebarActions" class="sidebar-actions flex flex-nowrap items-stretch">
          <!-- -> Either button takes the whole row when the other one is off, and the separator only
               exists to divide the two, so it goes with them -->
          <template v-if="siteStore.locales.showMenu">
            <w-btn
              class="flex-1 px-2"
              flat
              dense
              icon="la:globe"
              :label="commonStore.locale"
              :aria-label="commonStore.locale"
              size="sm">
              <locale-selector-menu :offset="[-5, 5]" />
            </w-btn>
            <w-separator v-if="canBrowse" vertical />
          </template>
          <w-btn
            v-if="canBrowse"
            class="flex-1 px-2"
            flat
            dense
            icon="la:sitemap"
            :label="t(`common.sidebar.browse`)"
            :aria-label="t(`common.sidebar.browse`)"
            size="sm">
            <nav-browse-menu :offset="[-5, 5]" />
          </w-btn>
        </div>
        <nav-sidebar />
        <!-- -> Edit Nav is the whole bar now, so it is also what decides whether there is one -->
        <w-bar v-if="showEditNav" class="sidebar-footerbtns text-white" dense>
          <w-btn class="flex-1" icon="la:dharmachakra" :label="t(`common.sidebar.editNav`)" flat>
            <w-menu ref="navEditMenu" anchor="top left" self="bottom left" :offset="[0, 10]">
              <nav-edit-menu
                :menu-hide-handler="navEditMenu.hide"
                :update-position-handler="navEditMenu.updatePosition" />
            </w-menu>
          </w-btn>
        </w-bar>
      </template>
    </w-drawer>
    <!--
      The way back to the sidebar on a narrow viewport, where it overlays the page instead of taking a
      column of its own: closed to start with, so it is not sitting over the article on arrival, and
      nothing else on that screen opens it -- the header is full of page actions and has no room for a
      menu button.

      Bottom LEFT whichever side the sidebar is on, because the opposite corner belongs to
      scroll-to-top: on a narrow viewport that button is in the corner too (`scrollerAnchorX` is null),
      so one that followed the sidebar to the right would land on top of it.

      The position goes on a wrapper rather than on the button, as `WPageScroller` does it: `WBtn` is
      `relative` from its own class list, and Tailwind emits `relative` after `fixed`, so a `fixed`
      alongside it loses.

      Hard into the corner, with the corner facing the page rounded and the other three square -- see
      `.corner-btn`. No margin, so the button is not a disc hovering near the edge of a small screen but
      a piece of the screen's own corner, and every pixel of it is inside the viewport.

      `left-0` (not `start-0`) is deliberate -- OpenProject #1590's physical-positioning triage: this
      corner is chosen relative to `WPageScroller`'s corner, not to the reading direction, so it must
      not move when the locale does. See `frontend/src/physicalPositioning.test.js`.
    -->
    <transition name="corner-btn">
      <div v-if="showSidebarBtn" class="fixed bottom-0 left-0 z-30">
        <w-btn
          class="corner-btn corner-btn--left"
          icon="la:bars"
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
      <!--
        -> `.page-container-scrl` is the page view's article column, which is what scrolls

        The mirror of the sidebar button in the opposite corner while the layout is in its narrow mode:
        flush to the edge, and rounded on the top LEFT, since this is the corner it is tucked into from
        the other side.

        On a wide screen it is the same button in a corner of its own -- the bottom of the sidebar's
        column, ending where that column ends (`scrollerAnchorX`). Flush there too, so it is unelevated:
        a shadow is what a disc floating over the page needs, and this one is not floating over anything.
        And it is filled in the sidebar's own colour a shade lighter (`--color-sidebar-light`), since
        there it is part of that column rather than an accent laid over the page.

        And it stands down below 750px, where the page view's contents panel takes this corner for its own
        opener -- one button per corner, and there the contents are the more useful of the two. See
        `showTocPanelBtn` in `pages/Index.vue`, which is what fills the gap.
      -->
      <w-page-scroller
        v-if="isAtLeastTocPanelWidth"
        :scroll-offset="150"
        :anchor-x="scrollerAnchorX"
        target=".page-container-scrl">
        <w-btn
          class="corner-btn corner-btn--right"
          icon="la:arrow-up"
          :color="scrollerAnchorX ? `sidebar-light` : `primary`"
          round
          size="md"
          :aria-label="t(`common.actions.returnToTop`)"
          :unelevated="Boolean(scrollerAnchorX)" />
      </w-page-scroller>
    </w-page-container>
    <main-overlay-dialog />
  </w-layout>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
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

/**
 * At or above 750px, which is where scroll-to-top keeps the bottom-right corner: below it the page view
 * turns its contents column into a panel and puts the opener there instead. The page view owns that
 * threshold (`$toc-overlay-max` and the 750px `useMinWidth` in `pages/Index.vue`); this is the same number
 * from the side that has to get out of the way.
 */
const isAtLeastTocPanelWidth = useMinWidth(750)

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

/*
  OpenProject #2512: `!pageStore.navigationId` is meant to catch a CONTENT page that hasn't finished
  telling `pageStore` which menu it belongs to yet -- not to double as a generic default for every
  other route this layout renders. `pageStore.navigationId` is only ever set by `pageLoad()` (see
  that action's own doc), so on a route that never calls it -- the knowledge graph, tags browse, any
  non-content `/_` route -- it just sits at whatever the LAST content page left it at: `null` on a
  fresh store (direct load/refresh), or a stale value from whatever page was viewed before navigating
  here via the SPA. Neither means anything about the current route, so the fallback is scoped to
  `route.meta.contentPage` -- the routes that actually render `Index.vue` and run a real page through
  `pageLoad()` (see `router/routes.js`) -- leaving every other route at its normal, expanded width.
*/
const isSidebarMini = computed(() => {
  return (
    ['hide', 'hideExact'].includes(pageStore.navigationMode) ||
    (Boolean(route.meta.contentPage) && !pageStore.navigationId)
  )
})

/** Sidebar widths, in px: the full nav, and the icon rail it collapses to. */
const SIDEBAR_WIDTH = 255
const SIDEBAR_WIDTH_MINI = 56

const sidebarWidth = computed(() => (isSidebarMini.value ? SIDEBAR_WIDTH_MINI : SIDEBAR_WIDTH))

/*
  The scroll-to-top button ENDS where the sidebar's column does, tucked into the bottom of it: the
  sidebar's own width on the left, or the window's right edge when the site puts its sidebar there,
  since that is the side that column ends on.

  Null puts it back in the corner, for every case where there is no sidebar beside it: a narrow
  viewport (the drawer overlays the page), a site with no sidebar, and the editor, which closes the
  sidebar to take the full width. That is the corner button, and it is left exactly as it was.
*/
const scrollerAnchorX = computed(() => {
  // -> No separate test for `sidebarPosition === 'off'`: that IS `sideNavIsDisabled`, which
  //    `isSidebarAvailable` already asks
  if (!isWideViewport.value || !isSidebarAvailable.value) {
    return null
  }
  return siteStore.theme.sidebarPosition === 'right' ? '100%' : `${sidebarWidth.value}px`
})

// -> The "Allow Browsing" site feature (admin/general): with it off the tree browser is not something
//    a reader can reach, so the button that opens it does not render
const canBrowse = computed(() => siteStore.features.browse)

// -> The action bar holds only the locale menu and Browse; with both off it would be an empty strip
const showSidebarActions = computed(() => siteStore.locales.showMenu || canBrowse.value)

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
*/
watch(
  () => route.path,
  () => {
    isNarrowSidebarOpen.value = false
  }
)

// METHODS

function openSidebar() {
  isNarrowSidebarOpen.value = true
}
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
  border-radius: 4px;
  background-color: $primary;
  color: #fff;
  font-weight: 500;
  text-decoration: none;
  transform: translateY(-150%);
  transition: transform 0.15s var(--ease-standard, ease);

  &:focus {
    transform: translateY(0);
  }
}

.sidebar-actions {
  background: linear-gradient(to bottom, rgba(255, 255, 255, 0.1) 0%, rgba(0, 0, 0, 0.05) 100%);
  border-bottom: 1px solid rgba(0, 0, 0, 0.2);
  height: 38px;

  // -> Where the two buttons above get their colour, so neither carries a `color` prop: `WBtn` emits
  //    an inline `color`, which would outrank this rule
  .w-btn {
    color: rgba(255, 255, 255, 0.8);
  }
}

.sidebar-mini {
  height: 100%;
}

/*
  No background of its own, and nothing sticky: the drawer is the height of the shell and the nav list
  above scrolls inside itself, so this bar sits at the bottom of the window by being last in the
  column. WBar's own translucent tint is what colours it -- the `background-color` that used to be
  declared here never applied, its scoped rule outranking a single class.
*/
.sidebar-footerbtns {
  flex-shrink: 0;
}

body.body--dark {
  background-color: $dark-6;
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

    // -> The radius is WDialog's, and the panel clips to it there; this only adds the depth and the
    //    title-bar strip an overlay wants on top of it
    > .w-dialog-panel {
      box-shadow: 0 0 30px 0 rgba(0, 0, 0, 0.3);

      @at-root .body--light & {
        background-image: linear-gradient(to bottom, $dark-5 10px, $grey-3 11px, $grey-4);
      }
      @at-root .body--dark & {
        background-image: linear-gradient(to bottom, $dark-4 10px, $dark-4 11px, $dark-3);
      }
    }
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
</style>
