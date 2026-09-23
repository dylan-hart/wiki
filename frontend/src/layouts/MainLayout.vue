<template>
  <w-layout
    :class="{ 'main-layout--entrance-flourish': playEntranceFlourish }"
    :style="{
      '--sidebar-current-width': sidebarCurrentWidth,
      '--sidebar-inset-inline-start': sidebarInsetInlineStart,
      '--sidebar-inset-inline-end': sidebarInsetInlineEnd
    }">
    <!--
      Must stay the first focusable element in the layout, ahead of `header-nav` -- WCAG 2.4.1
      (Bypass Blocks). Hidden by `transform`, never `display: none` / `visibility: hidden`, which
      would pull it out of the accessibility tree along with the visual hiding.
    -->
    <a href="#w-page-main" class="skip-link">{{ t('common.actions.skipToContent') }}</a>
    <w-header class="site-header-wrap">
      <header-nav :show-sidebar-toggle="showSidebarBtn" @open-sidebar="openSidebar" />
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
          <locale-selector-menu :anchor="miniSideMenu.anchor" :self="miniSideMenu.self" />
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
          <nav-browse-menu :anchor="miniSideMenu.anchor" :self="miniSideMenu.self" />
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
          <w-menu
            ref="navEditMenuMini"
            :anchor="miniEditNavMenu.anchor"
            :self="miniEditNavMenu.self">
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
          <template v-if="siteStore.locales.showMenu">
            <w-btn
              class="icon-lg sidebar-actions-locale px-2"
              flat
              dense
              icon="tabler:language"
              :label="commonStore.locale.toUpperCase()"
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
            -> The trailing "Top" cell keeps its 40x40 wrapper even while empty
               (`.sidebar-actions-top` below), so Locale/Browse never shift width as the button
               fades in. The button is a `v-if` inside the transition rather than a toggled
               opacity, so it leaves the tab order and the accessibility tree while hidden with no
               `tabindex`/`aria-hidden` bookkeeping.
          -->
          <w-separator
            vertical
            class="sidebar-actions-top-sep"
            :class="{ 'opacity-0': !showSidebarTop }" />
          <div class="sidebar-actions-top flex items-center justify-center">
            <transition name="sidebar-actions-top-fade">
              <w-btn
                v-if="showSidebarTop"
                class="icon-lg"
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
        <!-- -> Not a `w-bar`: its `dense` variant's translucent fill and forced 8px button label
                are scoped inside `WBar.vue` and cannot be overridden from here without
                `:deep`/`!important`, so `.sidebar-footerbtns` below owns this bar's look
                outright. -->
        <div v-if="showEditNav" class="sidebar-footerbtns flex flex-nowrap items-stretch">
          <!-- -> Invisible: gives this bar the same natural height as `.site-footer`'s own text
                  line (`FooterNav.vue`). -->
          <span class="sidebar-footerbtns-spacer" aria-hidden="true">&nbsp;</span>
          <w-btn class="flex-1" icon="tabler:list-tree" :label="t(`common.sidebar.editNav`)" flat>
            <w-menu
              ref="navEditMenu"
              :anchor="editNavMenu.anchor"
              :self="editNavMenu.self"
              :offset="[0, 10]">
              <nav-edit-menu
                :menu-hide-handler="navEditMenu.hide"
                :update-position-handler="navEditMenu.updatePosition" />
            </w-menu>
          </w-btn>
        </div>
      </template>
    </w-drawer>
    <!--
      No `<w-footer>` here, unlike every other layout: the article column scrolls inside a shell
      that holds still, so a footer at this level would be pinned to the window whichever row it
      took. `pages/Index.vue` puts it at the end of that scrolling column instead.
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
import { useDirection } from '@/composables/direction'
import { directionalAnchor } from '@/helpers/directionalAnchor'
import { useI18n } from 'vue-i18n'

import { useCommonStore } from '@/stores/common'
import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { maySeeSiteSurface } from '@/composables/siteAdminAccess'

import HeaderNav from '@/components/HeaderNav.vue'
import LocaleSelectorMenu from '@/components/LocaleSelectorMenu.vue'
import NavBrowseMenu from '@/components/NavBrowseMenu.vue'
import NavSidebar from '@/components/NavSidebar.vue'
import NavEditMenu from '@/components/NavEditMenu.vue'
import MainOverlayDialog from '@/components/MainOverlayDialog.vue'

const commonStore = useCommonStore()
const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const router = useRouter()
const route = useRoute()

const { t } = useI18n()

/*
  A getter that reads `siteStore.title` inside the tracked scope: the site config arrives after
  mount, so a template closing over the value once would keep whatever the store held then.
*/
useMeta(() => {
  const siteTitle = siteStore.title
  return {
    titleTemplate: (title) => (title ? `${title} - ${siteTitle}` : siteTitle)
  }
})

const navEditMenu = ref(null)
const navEditMenuMini = ref(null)

const isNarrowSidebarOpen = ref(false)

const direction = useDirection()

/**
 * `WMenu`/`WTooltip` place themselves in raw viewport pixels with no idea which way the reader's
 * text flows, so these anchors are mirrored by hand even though `WDrawer`'s own `side` prop is
 * already logical. Reactive rather than read once at setup: this layout stays mounted across
 * navigations, so a reader picking an RTL locale mid-session must see them flip on the next render.
 * (`sidebarPosition` is an orthogonal axis -- which CONTENT column the sidebar sits in -- and is
 * untouched here.)
 */
const miniSideMenu = computed(() =>
  directionalAnchor(direction.isRTL ? 'rtl' : 'ltr', 'top right', 'top left')
)

const miniEditNavMenu = computed(() =>
  directionalAnchor(direction.isRTL ? 'rtl' : 'ltr', 'top right', 'bottom left')
)

const editNavMenu = computed(() =>
  directionalAnchor(direction.isRTL ? 'rtl' : 'ltr', 'top left', 'bottom left')
)

/**
 * 1200 rather than `WDrawer`'s default of 1024: this sidebar is 255px and the page beside it gives
 * up its contents column before that point, so by ~1150px the article is the narrowest of the three
 * things sharing the window. Passed INTO the drawer rather than changed there, so the admin area's
 * drawer keeps the 1024 it was written against.
 */
const SIDEBAR_OVERLAY_BELOW = 1200

const isWideViewport = useMinWidth(SIDEBAR_OVERLAY_BELOW)

/** The `sm` breakpoint from `css/tailwind.css` -- a room-for-an-overlay proxy; see `showEditNav`. */
const isAtLeastSm = useMinWidth(600)

const isSidebarAvailable = computed(() => {
  return (
    !route.meta.hideSideNav &&
    siteStore.showSideNav &&
    !siteStore.sideNavIsDisabled &&
    !(editorStore.isActive && editorStore.hideSideNav)
  )
})

const isSidebarOpen = computed({
  get: () => isSidebarAvailable.value && (isWideViewport.value || isNarrowSidebarOpen.value),
  // -> Only ever reached from the scrim, which exists only while overlaying
  set: (val) => {
    isNarrowSidebarOpen.value = val
  }
})

/*
  Deliberately not also gated on the sidebar being closed: unmounting the toggle would slide the
  logo left under the drawer's opening, so it keeps its place and the drawer/scrim cover it.
*/
const showSidebarBtn = computed(() => {
  return isSidebarAvailable.value && !isWideViewport.value
})

/**
 * `null` on every route that is not a content page: those never call `pageStore.pageLoad()`, so
 * `pageStore.navigationId` there is either unset or a stale value left by the last content page
 * viewed. `NavSidebar.vue`'s own `effectiveNavigationId` is what resolves a menu for them; this one
 * exists only for the mini-rail check below, which deliberately has no opinion about those routes.
 */
const effectiveNavigationId = computed(() =>
  route.meta.contentPage ? pageStore.navigationId : null
)

/**
 * What the page itself asks for, kept apart from `isSidebarMini` below so `sidebarExpandOverride`
 * has something to negate: the mini rail renders real shortcuts, so a reader can want it back at
 * full width for a while without the page's own request for mini being forgotten.
 */
const isSidebarMiniForced = computed(() => {
  return (
    ['hide', 'hideExact'].includes(pageStore.navigationMode) ||
    (Boolean(route.meta.contentPage) && !effectiveNavigationId.value)
  )
})

/**
 * `sessionStorage` deliberately: a reader's override of `isSidebarMiniForced` should outlive a link
 * to another page that also forces mini, but not the tab -- the page author's own choice is the
 * default again next session. A sandboxed or privacy-hardened browser can throw on storage access
 * outright, hence the try/catch around every read and write.
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
      // -> Only persistence is lost; the ref above still drives the UI for this page view.
    }
  }
})

const isSidebarMini = computed(() => isSidebarMiniForced.value && !sidebarExpandOverride.value)

/*
  Gated on `isSidebarMiniForced` as well: without it, using the toggle once anywhere on the site
  would put a stray "Collapse Sidebar" button on every page that was full-width to begin with.
*/
const showSidebarCollapseOverride = computed(() => {
  return isSidebarMiniForced.value && sidebarExpandOverride.value
})

const SIDEBAR_WIDTH_MIN = 255
const SIDEBAR_WIDTH_MAX = 510
const SIDEBAR_WIDTH_MINI = 56

const sidebarContentWidth = ref(SIDEBAR_WIDTH_MIN)

const navSidebarEl = ref(null)

/**
 * `sidebarContentWidth.value - label.clientWidth` is this row's own depth-dependent chrome (icon,
 * padding, nesting indent): the label is a stretched flex item, so it fills whatever room the row's
 * fixed chrome leaves it, which makes that difference invariant to the drawer's current width.
 *
 * `scrollWidth` is not -- the DOM spec floors it at `clientWidth`, so a label stretched to a drawer
 * that has already grown for some other label reports that inflated width back and the sidebar
 * could never shrink again. Opting the label out of the stretch (`align-self: flex-start`) for
 * exactly one synchronous read gets its true content width; nothing paints between the write and
 * the revert, so there is no flicker.
 *
 * `offsetParent === null` skips a collapsed folder's rows: `v-show` sets `display: none`, zeroing
 * both widths, and they would otherwise misread as needing the full current width -- permanently
 * blocking the sidebar from shrinking.
 *
 * That align-self write is itself a `style` mutation inside `root`, which is what
 * `sidebarMutationObserver` watches, so left connected every pass would re-trigger itself. The loop
 * is fully synchronous, so disconnecting for its duration is safe.
 */
function measureSidebarWidth() {
  const root = navSidebarEl.value?.$el
  if (!root || typeof root.querySelectorAll !== 'function') {
    return
  }
  sidebarMutationObserver?.disconnect()
  let widest = SIDEBAR_WIDTH_MIN
  for (const label of root.querySelectorAll('.truncate')) {
    if (label.offsetParent === null) {
      continue
    }
    const chrome = sidebarContentWidth.value - label.clientWidth
    const previousAlignSelf = label.style.alignSelf
    label.style.alignSelf = 'flex-start'
    const naturalWidth = label.scrollWidth
    label.style.alignSelf = previousAlignSelf
    const needed = chrome + naturalWidth
    if (needed > widest) {
      widest = needed
    }
  }
  sidebarContentWidth.value = Math.min(SIDEBAR_WIDTH_MAX, widest)
  observeSidebarMutations(root)
}

let sidebarMutationObserver = null

// -> Watches `style` attributes because a folder expanding/collapsing toggles its content's inline
//    `display` (Vue's `v-show`), with no new prop or emit needed from `NavSidebarItem.vue`.
function observeSidebarMutations(root) {
  sidebarMutationObserver = new MutationObserver(measureSidebarWidth)
  sidebarMutationObserver.observe(root, {
    attributes: true,
    attributeFilter: ['style'],
    subtree: true
  })
}

// -> Toggling mini mode unmounts and remounts `<nav-sidebar>` entirely, so a fresh instance means a
//    fresh DOM node to observe: the old observer is torn down and a new one attached.
watch(navSidebarEl, (component) => {
  sidebarMutationObserver?.disconnect()
  sidebarMutationObserver = null
  const root = component?.$el
  if (!root || typeof root.querySelectorAll !== 'function') {
    return
  }
  nextTick(measureSidebarWidth)
  observeSidebarMutations(root)
})

onBeforeUnmount(() => sidebarMutationObserver?.disconnect())

// -> Deep: an in-place edit to the tree, not only a wholesale replacement of `nav.items`, has to
//    trigger a re-measure.
watch(
  () => siteStore.nav.items,
  () => nextTick(measureSidebarWidth),
  { deep: true }
)

const sidebarWidth = computed(() =>
  isSidebarMini.value ? SIDEBAR_WIDTH_MINI : sidebarContentWidth.value
)

/**
 * Mirrored onto `--sidebar-current-width` (the `:style` on the root element above) so `Index.vue`'s
 * Cobalt `.w-footer` rule can inset from the sidebar's own edge -- plain CSS inheritance carries it
 * down from this shared ancestor of both the drawer and the routed page. `0px` whenever the
 * drawer's grid column isn't actually occupied, or the footer would make room for a sidebar that is
 * not rendered.
 */
const sidebarCurrentWidth = computed(() =>
  isSidebarOpen.value ? `${sidebarWidth.value}px` : '0px'
)

/**
 * Mirrors `<w-drawer>`'s own reading of `sidebarPosition` above -- anything but `'right'`,
 * including the `'off'` no-sidebar setting, is the reading-START side -- rather than inventing a
 * second one. CSS cannot pick between `inset-inline-start`/`-end` from a custom property's string
 * value, so the two directional widths below are computed here instead: one is always
 * `sidebarCurrentWidth` and the other `0px`, and a consumer sets both unconditionally.
 */
const sidebarOnEndSide = computed(() => siteStore.theme.sidebarPosition === 'right')

const sidebarInsetInlineStart = computed(() =>
  sidebarOnEndSide.value ? '0px' : sidebarCurrentWidth.value
)

const sidebarInsetInlineEnd = computed(() =>
  sidebarOnEndSide.value ? sidebarCurrentWidth.value : '0px'
)

const canBrowse = computed(() => siteStore.features.browse)

const showSidebarActions = computed(() => siteStore.locales.showMenu || canBrowse.value)

const SIDEBAR_TOP_SCROLL_OFFSET = 150

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
  Saving from the Edit Nav menu needs `manage:navigation` OR a `site:navigation` delegation on the
  CURRENT site, so offering it to anyone holding neither only produces a permission error on Save.
  `maySeeSiteSurface` ORs the two, since `userStore.can()` answers globally and has no notion of
  which site a delegation is for. `userStore.sitePermissions` is only valid for the site it was last
  fetched for (see the `siteStore.id` watch below), so this reads denied rather than a wrong site's
  grant while a fetch is in flight.

  And not on a phone, whatever the permission: rearranging the tree is drag-and-drop work in a
  full-screen overlay, stacked on a sidebar the reader has just opened over the page. `isAtLeastSm`
  is a layout-room gate, deliberately, not a pointer-capability check -- `any-pointer: fine` stays
  true on a touch-primary 2-in-1 and goes false on a touch-only tablet wide enough to fit the
  overlay, whose drag library handles touch fine on its own.
*/
const showEditNav = computed(() => {
  return (
    userStore.authenticated &&
    maySeeSiteSurface(userStore, 'site:navigation', siteStore.id) &&
    isAtLeastSm.value
  )
})

/*
  Keeps `userStore.sitePermissions` valid for whichever site `showEditNav` is asking about. This
  layout mounts for every reader-facing page, unlike AdminLayout's equivalent watch, so it skips the
  round trip for anyone it cannot help: a guest can hold no delegation, and `manage:navigation`
  alone already answers `maySeeSiteSurface`. Comparing `sitePermissionsSiteId` rather than firing
  once is what re-fetches across a site switch.
*/
watch(
  () => siteStore.id,
  (newValue) => {
    if (!userStore.authenticated || userStore.can('manage:navigation')) {
      return
    }
    if (userStore.sitePermissionsSiteId !== newValue) {
      userStore.fetchSitePermissions(newValue)
    }
  },
  { immediate: true }
)

/*
  Following a link out of the overlaying sidebar puts it away, since what the reader asked for is
  behind it. The freshly-routed column starts at the top, so the "Top" cell recomputes here rather
  than waiting for a scroll event a reader who leaves the new page alone never sends.
*/
watch(
  () => route.path,
  () => {
    isNarrowSidebarOpen.value = false
    updateSidebarTopVisibility()
  }
)

function openSidebar() {
  isNarrowSidebarOpen.value = true
}

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

/**
 * Plays only on a landing straight off a successful login: `AuthLoginPanel.vue` sets this key
 * immediately before its hard `window.location.replace()`, and the read below clears it, so a plain
 * refresh in the same session finds nothing. Set once and never toggled back -- an in-SPA
 * navigation swaps `router-view` underneath this layout rather than remounting it, so there is no
 * second arrival to gate.
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
    // -> A browser that throws on storage access renders with no animation, like a plain refresh.
  }
  if (justLoggedIn && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    playEntranceFlourish.value = true
  }
})
</script>

<style>
/*
  `position: fixed` at all times, not only once focused: `.w-layout` is a grid whose ordinary
  children are all placed by a named `grid-area`, and an item with none of its own falls to
  auto-placement instead. Fixed takes this out of grid placement entirely, in both states.

  Off-screen via `transform` rather than `sr-only`-style clipping: a visually-hidden utility plus a
  `:focus` variant is two rules fighting over `position`, and the utility's `:focus` form wins on
  specificity -- undoing the fixed placement exactly when this is focused.
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
  One hairline for the seam, drawn here and nowhere else: `NavSidebar`'s own `.sidebar-nav` sits
  directly below this band and draws no top edge of its own. When the band isn't rendered at all
  (`showSidebarActions` false), the line is still there -- drawn by `HeaderNav`'s own bottom edge.

  The rule under the row and the two labels on it take the SIDEBAR's own tones
  (`--color-sidebar-actions-text` / `--color-sidebar-hairline`) rather than the app's generic
  chrome: the row sits on the sidebar's ground, and Cobalt's is a deep indigo where the generic
  `--color-slate` is unreadable.
*/
.sidebar-actions {
  /* -> A true 40px interior: `border-box` sizing (Tailwind's preflight default) plus the 1px */
  /*    `border-bottom` below. */
  height: 41px;
  border-bottom: 1px solid var(--color-sidebar-hairline);

  /* -> The buttons above carry no `color` prop on purpose: `WBtn` emits an inline `color`, which */
  /*    would outrank this rule. */
  .w-btn {
    color: var(--color-sidebar-actions-text);
  }

  /* -> WBtn scales its icon off `size="sm"`'s 10px font-size, landing undersized next to the label */
  /*    here. `!important` because this plain rule and WBtn's own scoped one tie on specificity, and */
  /*    which stylesheet loads later is not something to rely on. */
  .icon-lg .w-icon {
    font-size: 20px !important;
  }
}

/*
  A FIXED-width cell, unlike Browse's `flex-1`. `overflow: hidden` is a safety net for a locale code
  long enough to overrun 72px (`pt-BR`); a fixed cell is wanted here, not an ellipsis.
*/
.sidebar-actions-locale {
  flex: 0 0 72px;
  width: 72px;
  overflow: hidden;
}

/* -> Always 40x40, mounted button or not, so Locale/Browse never shift width. */
.sidebar-actions-top {
  flex: 0 0 40px;
  width: 40px;
}

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
  Both cell separators are `<w-separator>`s, which paint through `--w-hairline-color` rather than a
  plain `border`, so recolouring that hook is how this strip's separators are themed.
*/
.sidebar-actions .w-separator {
  --w-hairline-color: var(--color-hairline);
}

.sidebar-actions-top .w-btn {
  background-color: var(--color-white);
  color: var(--color-accent);

  /* -> `!important` on padding beats WBtn's own inline dense padding (`0 0.8em`), which no plain */
  /*    stylesheet rule can outrank, so the button fills the 40x40 cell exactly. */
  width: 40px;
  height: 40px;
  padding: 0 !important;

  &:hover {
    background-color: var(--color-accent-wash);
  }

  /* -> Same specificity tie as `.icon-lg .w-icon` above: WBtn's em-scaled icon rule needs beating. */
  .w-icon {
    font-size: 15px !important;
  }

  /* -> Label under the arrow rather than beside it -- the only way both fit the 40px cell. */
  > span {
    flex-direction: column;
    gap: 1px;
  }

  /* -> Uppercased here rather than in the translation string, so `common.sidebar.top` stays */
  /*    natural-case. Its own `font-size` rather than the button's, which WBtn's inline */
  /*    `em`-relative `min-height`/`padding` would shrink along with it. */
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

  /* -> Specificity-tied with the `.sidebar-actions .w-btn` dark override above, so it wins on */
  /*    source order alone and has to stay after it. */
  .sidebar-actions-top .w-btn {
    background-color: var(--color-dark-2);
    color: var(--color-accent-dark);

    &:hover {
      background-color: rgb(240 130 135 / 0.14);
    }
  }
}

/*
  Cobalt carries no hairlines at all: both separators go outright rather than fading to a
  near-invisible tint, and the strip's own bottom rule with them. Done locally rather than on
  `--color-sidebar-hairline`, which `NavItemEditor.vue` and `InboxOverlay.vue` share.
*/
body.body--cobalt {
  .sidebar-actions {
    border-bottom: none;
  }

  .sidebar-actions .w-separator {
    display: none;
  }

  /* -> Icon and label take different tones here -- the sidebar's icon token vs. its actions-text */
  /*    token -- unlike Ledger, where both inherit the same `.w-btn` colour above. */
  .sidebar-actions .icon-lg {
    margin: 4px 0 4px 4px;

    &:hover {
      background-color: rgb(255 255 255 / 0.08);
    }

    .w-icon {
      color: var(--color-sidebar-icon);
    }
  }

  /* -> The Top button shares Locale/Browse's `.icon-lg` treatment above, so two values are reset */
  /*    here: the unscoped `.sidebar-actions-top .w-btn` rule's Ledger white plate, which is not */
  /*    scoped away from Cobalt and would bleed through, and `.icon-lg`'s inset margin, sized for */
  /*    the flex-1 cells. Mirrored to `4px 4px 4px 0` on a 36x32 button, it fills the 40x40 cell */
  /*    exactly, so the button's leading edge and hover wash abut Browse's (no separator here). */
  /*    Equal specificity, later in source order, so this wins. */
  .sidebar-actions-top .w-btn {
    background-color: transparent;
    margin: 4px 4px 4px 0;
    width: 36px;
    height: 32px;
  }
}

/*
  `WDrawer.vue` draws its inline-end edge with the GENERIC `border-hairline` utilities, which
  resolve through `--color-hairline` -- a pale, light-paper tone. `.bg-sidebar` sits on the
  dark-toned sidebar surface even in Cobalt LIGHT mode, where that reads as a near-white mismatch.
  Overridden here rather than in `WDrawer.vue`, which other, genuinely light-paper drawers still use
  unchanged, and `!important` to beat the utility class. Cobalt dark mode is left alone.
*/
body.body--cobalt:not(.body--dark) .bg-sidebar {
  border-inline-end-color: var(--color-sidebar-hairline) !important;
}

/*
  The sidebar must always reach the true bottom of the screen: it is Cobalt's `position: fixed`
  footer bar (`Index.vue`'s `.page-container-scrl .w-footer` rule) that makes room for the sidebar,
  never the sidebar clearing the bar. Below the breakpoint the two occupy the same
  full-window-height space, so an open overlay drawer has to sit visually ABOVE the bar: `46`, one
  past the bar's own `45`. A `bottom` clearance instead would pull the drawer's own bottom edge up
  off the screen's bottom. `.bg-sidebar.w-drawer--overlay` already outranks `WDrawer.vue`'s
  single-class `.z-40` utility, so no `!important` is needed.
*/
body.body--cobalt .bg-sidebar.w-drawer--overlay {
  z-index: 46;
}

.sidebar-mini {
  height: 100%;
}

/*
  No fill of its own and nothing sticky: the nav list above scrolls inside itself, so this bar sits
  at the bottom of the window by being last in the column.

  Its height matches `.site-footer` (`FooterNav.vue`) so the two bookend bars read as the same band,
  and not by a copied pixel value: `.sidebar-footerbtns-spacer` is an invisible line built from the
  SAME font stack, size and vertical padding that footer renders its own text with, so it takes on
  the same natural height in whichever browser and font fallback actually renders it, and
  `items-stretch` sizes the real button to match. An edit to `.site-footer`'s font or padding
  therefore keeps this in step for free.
*/
.sidebar-footerbtns {
  flex-shrink: 0;
  border-top: 1px solid var(--color-sidebar-hairline);
  color: var(--color-text-secondary);

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
    /* -> WBtn's own inline `min-height` is em-relative to its font-size and would outgrow the band */
    /*    this bar's height is built to match, so it is reset and the flex stretch sizes the button */
    /*    instead. The size is stated explicitly because the library default is smaller than a nav */
    /*    row's label. */
    min-height: auto !important;
    font-size: 14px;
  }
}

.body--dark .sidebar-footerbtns {
  border-top-color: var(--color-hairline-dark);
  color: var(--color-text-secondary-dark);
}

/*
  `--color-paper` rather than white: the header band, the content column and a card are all white,
  and the paper behind them is what makes each read as a plate rather than more of the same sheet.
*/
body {
  background-color: var(--color-paper);
}

body.body--dark {
  background-color: var(--color-dark-6);
}

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
  `@keyframes` animations rather than transitions: a transition only runs on a property CHANGE,
  which would need a "render hidden, then flip to visible next tick" dance. An animation runs the
  moment the class carrying it is in the DOM, so adding the class once in `onMounted` is enough --
  an in-SPA navigation never remounts this layout, so there is no second arrival to replay it for.
*/
.main-layout--entrance-flourish {
  .site-header-wrap {
    animation: main-layout-entrance-header 280ms ease-out both;
  }

  /*
    -> The drawer's contents, not its open/close slide, which `WDrawer`'s own transition owns and
       does not fire on initial mount anyway.
  */
  .bg-sidebar {
    animation: main-layout-entrance-fade 280ms ease-out 80ms both;
  }

  /*
    -> The nested `.site-footer` rule adds a slide-up on top of this fade; the fade itself already
       reaches the footer, since an ancestor's opacity composites its whole subtree.
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
  /* -> Defence in depth: `playEntranceFlourish` is already false whenever this query matches, so */
  /*    the class is never added in the first place. */
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
