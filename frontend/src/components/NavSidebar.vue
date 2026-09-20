<template>
  <w-scroll-area class="sidebar-nav">
    <!-- -> Labelled so the landmarks rotor tells this apart from `PageToc`'s own `<nav>` -->
    <nav :aria-label="t(`common.sidebar.browse`)">
      <w-list class="sidebar-nav-list" dense>
        <template v-for="item of siteStore.nav.items" :key="item.id">
          <w-item-label
            class="sidebar-nav-header text-wordbreak-all"
            v-if="item.type === `header`"
            header
            >{{ item.label }}</w-item-label
          >
          <nav-sidebar-item v-else-if="item.type === `link`" :item="item" />
          <w-separator v-else-if="item.type === `separator`" />
        </template>
      </w-list>
      <!-- -> Right-click empty space to create. Only meaningful with a real tree behind the menu
              (auto/mixed): a static menu's links need not correspond to any page. The root is the
              menu's own generator root -- a page-level navigation override generates from its own
              section, not the locale root. -->
      <page-new-menu
        v-if="canCreateAtRoot"
        context-menu
        show-new-folder
        :base-path="siteStore.nav.rootPath"
        :hide-asset-btn="!canUploadAsset"
        @new-folder="openFolderDialog(siteStore.nav.rootId)" />
    </nav>
  </w-scroll-area>
</template>

<script setup>
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'

import { useNavCreateMenu } from '@/composables/navCreateMenu'
import { useProvideNavExpansionState } from '@/composables/navExpansionState'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import PageNewMenu from '@/components/PageNewMenu.vue'
import NavSidebarItem from './NavSidebarItem.vue'

// -> Must be provided here, at the tree's root: every recursive `NavSidebarItem` injects this one
//    shared open/closed state rather than holding its own.
useProvideNavExpansionState()

const route = useRoute()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

const { canUploadAsset, openFolderDialog } = useNavCreateMenu()

const canCreateAtRoot = computed(
  () =>
    (siteStore.nav.mode === 'auto' || siteStore.nav.mode === 'mixed') &&
    userStore.can('write:pages')
)

/**
 * Only `pageStore.pageLoad()` ever sets `pageStore.navigationId`, so a non-content `MainLayout`
 * route (graph, tags browse) would sit at `null` forever without the site default. A content route
 * gets no such fallback on purpose: `null` mid-load is a state `MainLayout.vue` relies on.
 */
const effectiveNavigationId = computed(() =>
  route.meta.contentPage ? pageStore.navigationId : siteStore.navigationId
)

watch(
  effectiveNavigationId,
  (newValue) => {
    // -> No "already showing this menu" gate here: `fetchNavigation()` owns it, so an invalidation
    //    elsewhere can bypass it with `forceRefresh` without this watcher knowing why.
    siteStore.fetchNavigation(newValue)
  },
  { immediate: true }
)
</script>

<style>
/*
  Nav glyphs take their colour from here rather than from `WIcon`'s own `color` prop: that prop's
  class is built at runtime (`text-${color}`), and Tailwind only emits a utility spelled out
  literally in source, so the prop resolves to nothing and the glyph falls through to the row's
  inherited ink -- unreadably dark on Cobalt's indigo column. Unlayered, so it beats any utility
  that IS emitted.
*/
.sidebar-nav .w-item .w-icon,
.sidebar-nav .w-expansion-item__arrow {
  color: var(--color-sidebar-icon);
}

.sidebar-nav-header {
  padding: 0 18px 10px;
  color: var(--color-text-caption);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  line-height: 1.4;
  text-transform: uppercase;
}

.body--dark .sidebar-nav-header {
  color: var(--color-text-caption-dark);
}
/* Don't re-nest the rules below as `&-header`/`&-list`: selector concatenation is a Sass idiom,
   and native CSS nesting silently drops such a rule rather than matching it. */
@charset "UTF-8";
.sidebar-nav {
  /*
    Stated rather than inherited: a nav row would otherwise inherit the document's ink, which is
    wrong over whatever sidebar colour the site picked. Via `--color-sidebar-text` so Cobalt's own
    light nav text can take over; Ledger's value for the token is the plain slate this had before.
  */
  color: var(--color-sidebar-text);
  /* -> Fills whatever the drawer's flex column has left over. A fixed `calc()` cannot: the action
     bar and footer bar are both conditional, so it left dead space when either was absent.
     `min-height: 0` is what lets this shrink below its content so the scroll area actually
     scrolls. */
  flex: 1 1 0;
  min-height: 0;
  /* -> A flex column of its own, so `> nav` below is sized in the SAME layout pass as this
     element's own height. */
  display: flex;
  flex-direction: column;
  /* -> `<nav>` must fill this scroll area: with few or zero items it would otherwise collapse to
     its content, leaving space inside `.sidebar-nav` but outside `<nav>` -- and that is exactly
     where `WMenu`'s root context-menu trigger binds, so right-clicking an empty sidebar to create
     the first page would do nothing.

     `flex: 1 0 auto` rather than a percentage height: a percentage resolves against this element's
     flex-computed, possibly fractional-pixel height in a SEPARATE pass, and the two passes can
     round differently, leaving `nav` a hair too tall and tripping `w-scroll-area`'s
     `overflow-auto` with nothing actually cut off. */
}
.sidebar-nav > nav {
  flex: 1 0 auto;
}
.sidebar-nav-list > .w-separator {
  margin-top: 10px;
  margin-bottom: 10px;
}
.sidebar-nav {
  /*
    Only the two link shapes, not every first child: a dense row's 2px padding leaves its label
    hard against the rule under the site header, while a header's own `p-4` already clears it.
  */
}
.sidebar-nav-list > .w-item:first-child,
.sidebar-nav-list > .w-expansion-item:first-child {
  margin-top: 10px;
}
.sidebar-nav .w-list .w-separator + .w-item-label {
  padding-top: 10px;
}
.sidebar-nav .w-list {
  /* -> The chevron says the row opens, so it is not the secondary content a trailing section is
     dimmed for. Set on the icon, not its section, to beat that inherited dimming. */
}
.sidebar-nav .w-list .w-expansion-item__arrow {
  color: var(--color-slate-soft);
}
.sidebar-nav .w-list .w-item-section--avatar {
  min-width: auto;
}
.sidebar-nav .w-list {
  /*
    `router-link-exact-active` is `RouterLink`'s own, so the mark follows the reader with nothing
    tracked here -- and a row rendered as a plain `<a>` (an address leaving the wiki, or a new tab)
    never carries it, which is right: the reader is never already there.

    `.is-graph-selected` (`navSidebarDestination.js#isSelected`) deliberately shares every rule
    below selector-for-selector rather than approximating them: product direction is that the row
    selected from the graph reads as EXACTLY the "reading this page" row, not merely like it.
  */
}
.sidebar-nav .w-list .w-item.router-link-exact-active,
.sidebar-nav .w-list .w-item.is-graph-selected {
  background-color: var(--color-surface);
  color: var(--color-ink);
  font-weight: 600;
  /*
    A real border, not an inset shadow, so it eats 2px of the row's inline-start padding -- the
    padding below gives those back, or an active row's label would step 2px further in than its
    neighbours'. Logical, so the bar sits on the edge the reader starts from.
  */
  border-inline-start: 2px solid var(--color-accent-fill);
  /*
    Must track the depth-scaled base padding below, not a flat 14px: a flat value would yank an
    active row nested N levels deep back toward the edge, out of step with its siblings.
  */
  padding-inline-start: calc(1rem + var(--nav-depth, 0) * 10px - 2px);
}
.sidebar-nav .w-list .w-item.router-link-exact-active .w-icon,
.sidebar-nav .w-list .w-item.is-graph-selected .w-icon {
  color: var(--color-accent-fill);
}
.body--dark .sidebar-nav .w-list .w-item.router-link-exact-active,
.body--dark .sidebar-nav .w-list .w-item.is-graph-selected {
  background-color: var(--color-dark-3);
  color: var(--color-text-dark);
}
.body--dark .sidebar-nav .w-list .w-item.router-link-exact-active .w-icon,
.body--dark .sidebar-nav .w-list .w-item.is-graph-selected .w-icon {
  color: var(--color-accent-dark);
}
.sidebar-nav .w-list .w-item.router-link-exact-active {
  /*
    Cobalt's mark is `--nav-active-inset`, an INSET box-shadow: it draws inside the row's own box,
    so unlike the border above it needs no compensating `padding-inline-start`. One rule for both
    Cobalt modes -- the dark block restates neither token.
  */
}
body.body--cobalt .sidebar-nav .w-list .w-item.router-link-exact-active,
body.body--cobalt .sidebar-nav .w-list .w-item.is-graph-selected {
  background-color: var(--color-sidebar-active-bg);
  color: var(--color-sidebar-active-text);
  border-inline-start: 0;
  box-shadow: var(--nav-active-inset);
}
body.body--cobalt .sidebar-nav .w-list .w-item.router-link-exact-active .w-icon,
body.body--cobalt .sidebar-nav .w-list .w-item.is-graph-selected .w-icon {
  color: var(--color-sidebar-active-text);
}
/*
  Marks the row the knowledge graph is anchored on. The hex duplicates `graphDraw.js`'s
  `HIGHLIGHT_RING_COLOR` deliberately -- keep the two in sync, or the row and its yellow-ringed
  node stop reading as the same page. A ring rather than the accent fill above, so "reading this
  page" and "the graph is anchored here" stay distinct signals.

  The folder case needs the `>` child combinator: `is-graph-anchor` falls through onto
  `WExpansionItem`'s root wrapper, and a bare descendant selector would also catch nested rows'
  headers. The leaf branch carries the class on its own element.
*/
.sidebar-nav .w-list .w-item.is-graph-anchor,
.sidebar-nav .w-list .w-expansion-item.is-graph-anchor > .w-expansion-item__header {
  box-shadow: inset 0 0 0 1.5px #ffd600;
}
.sidebar-nav .w-list {
  /*
    The sidebar's hover/press tint lives at the bottom of this block, not here -- see
    "Hand-converted @at-root escapes".

    The inset and radius apply to EVERY row, not only the active one, or the two would sit at
    different widths and an inactive row's hover would still run edge to edge. Ledger's values for
    both tokens are `0`, so it draws as a full-bleed band there.

    `font-size`/`font-weight` are stated because an unset label inherits the page's 14px body size
    instead of the sidebar's own role; the icon is unaffected, `WItemSection` sets its size.
  */
}
.sidebar-nav .w-list .w-item {
  position: relative;
  border-radius: var(--radius-control);
  margin-inline: var(--nav-item-inset);
  font-size: 13.5px;
  font-weight: 400;
  /*
    Indentation and the chevron are the only nesting cues -- a deeper row shows its depth by
    position, never by colour.

    Per-level indent is real padding on the row's OWN box rather than a chain of ancestor wrappers
    each narrowing themselves by a transparent border, which is what makes every row span the
    navbar's full width AT EVERY DEPTH: nothing upstream narrows its box per level, so a deeply
    nested row's far edge lines up with a root row's.

    `--nav-depth` is `NavSidebarItem.vue`'s `depth` prop, set on each row's own root element. It
    is added on top of the base 1rem padding, and the `0` fallback keeps a prop-less match at zero
    extra indent rather than guessing at a lane's worth.
  */
  padding-inline-start: calc(1rem + var(--nav-depth, 0) * 10px);
  /*
    Hovering a row lights ONE dot per ancestor indent lane it sits inside -- a depth cue that
    appears only while navigating rather than cluttering the tree at rest.

    It hangs off the ROW, which is what gives it one row's height to centre on and lets the
    trigger be a plain `:hover`: a folder's header row sits BESIDE its own content wrapper, never
    inside it, so no row is ever a DOM ancestor of another and no `:has()` is needed. On a shared
    ancestor instead, hovering any descendant at any depth lit every enclosing lane at once.

    Keep `--nav-item-inset` OUT of the offset below. `inset-inline-start` resolves against this
    row's PADDING box, which never includes the row's own `margin-inline`, so compensating for
    that margin here double-counts: it once resolved to Ledger's full 16px, landing the trail
    flush on the icon. A flat `6px` gives both aesthetics the same gap.

    `width` scales with depth so the FAR end (toward the icon) is what moves, 4px narrower per
    lane than the indent reserves, `max()`-clamped so depth 0 is never negative. The image is a
    `repeat-x` tile exactly one lane wide, so it draws once per lane crossed rather than once for
    the whole box. `@media (hover: hover)` keeps a touch tap from leaving a lane lit.
  */
}
.sidebar-nav .w-list .w-item::before {
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline-start: 6px;
  width: max(0px, var(--nav-depth, 0) * 10px - 4px);
  background-image: radial-gradient(circle, var(--color-slate-faint) 1px, transparent 1.4px);
  background-repeat: repeat-x;
  background-size: 10px 100%;
  background-position: left center;
  opacity: 0;
}
@media (hover: hover) {
  .sidebar-nav .w-list .w-item:hover::before {
    opacity: 0.5;
  }
}
.sidebar-nav {
  /*
    `:not(.body--cobalt)` on the dark rules below: they are aesthetic-blind, so their specificity
    would otherwise beat the token-based base colours and clobber Cobalt dark's own (correct,
    inherited from Cobalt light) `--color-sidebar-*` values with Ledger's dark literals.

    The heading's `!important` is there because `WItemLabel`'s `header` variant sets its own colour.
  */
}
.body--dark:not(.body--cobalt) .sidebar-nav {
  color: var(--color-text-secondary-dark);
}
.body--dark:not(.body--cobalt) .sidebar-nav .w-expansion-item__arrow {
  color: var(--color-slate-light);
}
.sidebar-nav-header {
  color: var(--color-sidebar-kicker) !important;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  /* -> `WItemLabel`'s uniform `p-4` leaves the heading floating midway between its own group and
     the one above; a tighter bottom side ties it to the links it labels. */
  padding-bottom: 4px;
}
.body--dark:not(.body--cobalt) .sidebar-nav-header {
  color: var(--color-text-caption-dark) !important;
}

/*
  Hand-converted @at-root escapes. These must stay flat, top-level rules: native CSS nesting has no
  `@at-root`, so nesting them back under a `.sidebar-nav` rule above would compile to a selector
  with `body` as a descendant of `.sidebar-nav`, which can never match.

  Cobalt's sidebar surface is dark navy in BOTH modes, so a Cobalt light row needs a lightening
  wash; `WItem.vue` darkens whenever the app's `.body--dark` class is absent, which is wrong for a
  dark surface under a light app. `!important` beats `WItem.vue`'s own Tailwind state utilities,
  and the `.sidebar-nav` scope keeps ordinary light-surface menus on the generic treatment.
*/
body.body--cobalt .sidebar-nav .w-item--clickable {
  &:hover {
    background-color: rgba(31, 79, 214, 0.12) !important;
  }

  &:active {
    background-color: rgba(31, 79, 214, 0.2) !important;
  }
}

body.body--cobalt.body--dark .sidebar-nav .w-item--clickable {
  &:hover {
    background-color: rgba(143, 176, 255, 0.16) !important;
  }

  &:active {
    background-color: rgba(143, 176, 255, 0.26) !important;
  }
}
</style>
