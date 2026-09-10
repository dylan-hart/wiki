<template>
  <w-scroll-area class="sidebar-nav">
    <!-- -> The primary navigation landmark: distinct from `PageToc`'s own `<nav>` so the two are
            reachable and tellable apart from the landmarks rotor -->
    <nav :aria-label="t(`common.sidebar.browse`)">
      <w-list class="sidebar-nav-list" dense>
        <template v-for="item of siteStore.nav.items" :key="item.id">
          <w-item-label
            class="sidebar-nav-header text-wordbreak-all"
            v-if="item.type === `header`"
            header
            >{{ item.label }}</w-item-label
          >
          <!-- -> One nav item, plus its expansion behavior if it has children -- recursive, so a
                  folder nested any number of levels deep still draws its own contents rather than
                  only the first level under the sidebar root -->
          <nav-sidebar-item v-else-if="item.type === `link`" :item="item" />
          <w-separator v-else-if="item.type === `separator`" />
        </template>
      </w-list>
      <!-- -> Right-click empty space to create at this menu's own generator root -- only meaningful
              when there is a real tree backing this menu (auto/mixed); a static menu's links may not
              correspond to any page at all. The root is `siteStore.nav.rootPath`/`rootId`, not
              always the locale root: a page/folder-level navigation override's own generator root is
              its own section (OpenProject #2442), and only a site-wide menu's root is the locale
              root. -->
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

// -> The shared, tree-wide open/closed state for every folder row below (OpenProject #2846):
//    provided once here, at the tree's root, and injected by each recursive `NavSidebarItem`
//    instance -- see `composables/navExpansionState.js` for why.
useProvideNavExpansionState()

// STORES

const route = useRoute()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

const { canUploadAsset, openFolderDialog } = useNavCreateMenu()

// COMPUTED

const canCreateAtRoot = computed(
  () =>
    (siteStore.nav.mode === 'auto' || siteStore.nav.mode === 'mixed') &&
    userStore.can('write:pages')
)

/**
 * The menu id this route actually wants: a content page's own inherited id
 * (`pageStore.navigationId`, set exclusively by `pageStore.pageLoad()`) for the routes that render
 * one, or the site's default id (`siteStore.navigationId`, from the bootstrap payload) for every
 * other `MainLayout` route -- the knowledge graph, tags browse -- which never call `pageLoad()` and
 * so would otherwise leave `pageStore.navigationId` at `null` forever (OpenProject #2527). A
 * content route deliberately keeps using `pageStore.navigationId` alone, with no fallback, while it
 * is still `null` mid-load -- see `MainLayout.vue`'s `isSidebarMiniForced` for why that gap matters
 * there.
 */
const effectiveNavigationId = computed(() =>
  route.meta.contentPage ? pageStore.navigationId : siteStore.navigationId
)

// WATCHERS

watch(
  effectiveNavigationId,
  (newValue) => {
    // -> The "already showing this menu" gate now lives in `fetchNavigation()` itself (OpenProject
    //    #1012), so a same-tab invalidation elsewhere in the app can bypass it with `forceRefresh`
    //    without this watcher needing to know why.
    siteStore.fetchNavigation(newValue)
  },
  { immediate: true }
)
</script>

<style lang="scss">
/*
  Just under the width `MainLayout` gives this sidebar's drawer as `overlayBelow` (1200), which is where it
  stops being a column beside the content and starts overlaying it. Not one of the app's shared breakpoints
  -- it belongs to this sidebar -- so it is stated here and cross-referenced there.
*/
$sidebar-overlay-max: 1199.98px;

/*
  Diffed against `Page View 3x - Cobalt`/`Page View Dark 3x - Cobalt` (OpenProject #2774). The
  column's own text, its section kicker and the active-row treatment go through
  `--color-sidebar-*`/`--nav-active-inset` below, matching the mockups' dark-navy chrome.

  The item and expansion-arrow GLYPHS take `--color-sidebar-icon` from this file rather than from
  their own `color` prop. `WIcon` builds that prop's class at runtime (`text-${color}`) and Tailwind
  only emits a utility it can see spelled out literally somewhere in source, so the prop resolves to
  nothing at all and the glyph falls through to the row's inherited ink -- which is Ledger's chrome
  slate on a light column, and unreadably dark on Cobalt's indigo one. This rule is the icon-safe
  entry point that note asked for: an unlayered declaration (so it beats any utility that IS emitted)
  naming the token the sidebar already has for exactly this, whose Ledger value is the same
  `--color-slate-faint` the prop asked for.
*/
.sidebar-nav .w-item .w-icon,
.sidebar-nav .w-expansion-item__arrow {
  color: var(--color-sidebar-icon);
}

/*
  A section heading between groups of nav items -- the language's own chrome overline, the same voice
  the metadata rail's headings and the admin sidebar's section labels use
  (`ui-redesign/Cardinal Wiki - Ledger 3x.dc.html` sets "DOCUMENTATION" above the tree exactly this
  way). It used to take `text-caption`, which is the app's small BODY size, so a heading read as one
  more nav row set slightly smaller than the rest.
*/
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

.sidebar-nav {
  /*
    The column's own foreground, stated rather than inherited: the drawer takes the site's chosen
    sidebar colour (or, in dark mode, the ramp -- see `css/_base.scss`), and what a nav row inherits
    from the layout above it is the document's own ink either way.

    Through `--color-sidebar-text` (`tailwind.css`, OpenProject #2767) rather than the bare `var(--color-slate)`
    constant: Ledger's own default for the token is `var(--color-slate)`, the same literal value, so
    this is unchanged for Ledger and is what lets Cobalt's own light nav text (`#d7deff`, legible on
    the dark navy sidebar ground its own `--q-sidebar` default paints) take over.
  */
  color: var(--color-sidebar-text);
  /* -> Fills whatever the drawer's flex column has left over, rather than subtracting the action bar
     and footer bar by hand: both are conditional, so a fixed `calc()` left dead space at the bottom
     for an anonymous reader (no footer bar) and for a site with no action bar at all. `min-height: 0`
     is what lets it shrink below its content so the scroll area actually scrolls. */
  flex: 1 1 0;
  min-height: 0;
  /* -> A flex column of its own, so `> nav` below can be sized by the SAME flex layout pass as this
     element's own (flex-computed, potentially fractional-pixel) height -- see the comment there for
     why that, rather than a percentage height, is what this needs to be. */
  display: flex;
  flex-direction: column;

  /* -> The `<nav>` inside this scroll area has no height rule of its own, so with few or zero items
     it collapses to its content's height and leaves empty space below it that is inside
     `.sidebar-nav` but OUTSIDE `<nav>` -- exactly the space `WMenu`'s root-level context-menu
     trigger binds to. Without this, right-clicking that empty space (the case that matters most:
     an empty or near-empty sidebar, where "right-click to create the first page" is the whole
     point) has no `<nav>` surface under the pointer to bind to, and does nothing.

     `flex: 1 0 auto` rather than a percentage height (OpenProject #2535): a percentage height here
     resolves against `.sidebar-nav`'s own flex-computed height in a SEPARATE layout pass, and that
     height can be a fractional pixel value -- the two passes can round it differently, leaving `nav`
     a hair taller than the actual available space and tripping `w-scroll-area`'s `overflow-auto`
     even though nothing is actually cut off. Flex-growing `nav` inside `.sidebar-nav`'s own flex
     column keeps both figures resolved by the same algorithm/pass, which does not have that
     mismatch, while still guaranteeing `nav` is at least as tall as `.sidebar-nav`. */
  > nav {
    flex: 1 0 auto;
  }

  &-list > .w-separator {
    margin-top: 10px;
    margin-bottom: 10px;
  }

  /*
    A first item that is a link -- on its own or as a group with children -- needs the space a first
    header brings with it. A dense row's padding is 2px, so its label started hard against the rule under
    the site header; a header's own `p-4` already stands it 16px clear, which is why this is only for the
    two link shapes and not for every first child.
  */
  &-list > .w-item:first-child,
  &-list > .w-expansion-item:first-child {
    margin-top: 10px;
  }

  .w-list {
    .w-separator + .w-item-label {
      padding-top: 10px;
    }

    /* -> The chevron is what says the row opens, so it is not the secondary content a trailing
       section is dimmed for: it takes the sidebar's own chrome tone at full strength. Set on the
       icon rather than on its section, which is what makes it beat the inherited dimmed colour. */
    .w-expansion-item__arrow {
      color: var(--color-slate-soft);
    }

    .w-item-section--avatar {
      min-width: auto;
    }

    /*
      The row holding the page being read: lifted onto the content column's own white, with a 2px
      accent bar down the edge it shares with the rest of the sidebar and its label in ink.

      This replaces a notch bitten out of the sidebar's inner edge -- a triangle painted in the
      colour of the page beyond it, so the mark was a piece of the sidebar MISSING rather than
      something drawn on it. That worked because the sidebar was a saturated column against a white
      page; on Cardinal's tint the two grounds are four percent apart and the absence read as a
      smudge. A bar states the same thing, and states it on the edge the reader is already scanning.

      `router-link-exact-active` is `RouterLink`'s own, so the mark follows the reader without this
      component tracking anything: a row rendered as a plain `<a>` -- an address that leaves the wiki
      or opens in a new tab -- never carries it, which is right, because a reader is never already
      there.
    */
    .w-item.router-link-exact-active {
      background-color: var(--color-surface);
      color: var(--color-ink);
      /*
        The "Nav item, active" role table row (same doc/section as the base `.w-item` rule above) is
        `600 13.5px sans` in both aesthetics -- the weight step is what marks the active row, same as
        the Contents rail's own active entry (§4.4); this one just isn't a §4 swap, since neither
        aesthetic changes it.
      */
      font-weight: 600;
      /*
        Logical, and paired with the padding below rather than layered over it: the bar is a real
        border, so it takes 2px off the row's own inline-start padding and the label has to give
        them back, or an active row's text would step 2px further in than its neighbours'.

        Which physical side "inline-start" resolves to is the reader's direction, and that is the
        right question here -- unlike the notch this replaces, which had to follow the CONTENT
        column (a site setting) rather than the reading direction, and needed a `--flipped` variant
        to do it. A bar on the edge you start reading from needs no such thing.
      */
      border-inline-start: 2px solid var(--color-accent-fill);
      /*
        Matches `.w-item`'s own depth-scaled base padding below (OpenProject #2951) minus these 2px
        -- not a flat 14px, which would yank an active row nested N levels deep back toward the edge
        regardless of how deep it actually sits, out of step with every other row at that depth.
      */
      padding-inline-start: calc(1rem + var(--nav-depth, 0) * 10px - 2px);

      .w-icon {
        color: var(--color-accent-fill);
      }

      @at-root .body--dark & {
        background-color: var(--color-dark-3);
        color: var(--color-text-dark);

        .w-icon {
          color: var(--color-accent-dark);
        }
      }

      /*
        Cobalt marks the active row with a solid accent fill and white ink rather than Ledger's
        white-on-tint row (`Page View 3x - Cobalt` mockup), via `--nav-active-inset` -- an INSET
        box-shadow rather than a real border, so it draws inside the row's own box and needs no
        compensating `padding-inline-start` the way the border above does. One rule for both themes:
        `tailwind.css`'s Cobalt-dark block does not restate either token, since both mockups draw the
        identical treatment.
      */
      @at-root body.body--cobalt & {
        background-color: var(--color-sidebar-active-bg);
        color: var(--color-sidebar-active-text);
        border-inline-start: 0;
        box-shadow: var(--nav-active-inset);

        .w-icon {
          color: var(--color-sidebar-active-text);
        }
      }
    }

    /*
      Cobalt's rows are plates rather than full-bleed bands: `Page View 3x - Cobalt` insets the whole
      list 10px from the column's edges and rounds each row's corner, so the active fill reads as a
      chip the reader could have clicked rather than as a stripe across the column. On EVERY row, not
      only the active one, or the two would sit at different widths and the inactive rows' hover
      would still run edge to edge.

      Through `--radius-control`/`--nav-item-inset` so the rule is one statement: Ledger's values are
      `0`, which is exactly what it draws today.

      `font-size`/`font-weight` here are the "Nav item" role from the typography role table
      (`ui-iteration-cobalt-typography/cobalt-typography.md` §3 "Sidebar") -- identical in both
      aesthetics, only the row's own `color` (`--color-sidebar-text` above) differs between them.
      Left unset, a row's label inherited the page's `body { font-size: 14px }` fallback (§2's "leak
      to check for") instead of the sidebar's own 13.5px/400 role; the icon stays unaffected, since
      `WItemSection`'s own `.w-item-section--side > .w-icon` rule sets its `font-size` explicitly.
    */
    .w-item {
      position: relative;
      border-radius: var(--radius-control);
      margin-inline: var(--nav-item-inset);
      font-size: 13.5px;
      font-weight: 400;

      /*
        OpenProject #2827: an open group's children used to be marked with a colored rail, a
        background wash that compounded one step darker per nesting level, and a mitred elbow
        pseudo-element turning the rail out of the row above -- the same treatment `NavEditOverlay`
        draws for a nested nav item. That reading was dropped entirely: indentation and the
        `.w-expansion-item__arrow` chevron are the only nesting cues left, so a deeper item shows
        its depth by position alone, not by color.

        Per-level indent is real padding on the row's OWN box (OpenProject #2951), not a nested
        chain of ancestor `.w-expansion-item__content` boxes each narrowing themselves by a
        transparent `border-inline-start` -- what this used to be, and what #2951's directed fix
        retired. `--nav-depth` is `NavSidebarItem.vue`'s own `depth` prop (0 at the sidebar root,
        +1 per recursive level), threaded explicitly and set as this custom property on each row's
        own root element -- see `NavSidebarItem.vue#depthStyle`'s own comment for why it lands here
        reliably even for a folder row (whose style binds to `.w-expansion-item`, one level up).
        Added on top of the row's base `px-4` (1rem) inline-start padding, so a depth-0 row renders
        exactly as it always has, and `var(--nav-depth, 0)`'s fallback keeps a bare, prop-less match
        at zero extra indent rather than guessing at one lane's worth.

        This is also what makes every row span the navbar's full width AT EVERY DEPTH: nothing
        upstream of this (`.w-list`, `.w-expansion-item__content`) narrows its own box per level any
        more, so a deeply nested row's right edge lines up with a root row's, not with however many
        ancestor borders happened to eat into it.
      */
      padding-inline-start: calc(1rem + var(--nav-depth, 0) * 10px);

      /*
        Hovering a row lights ONE dot per ancestor indent lane it actually sits inside -- a depth
        cue that appears only while navigating, rather than cluttering the tree at rest (OpenProject
        #2906). This used to live on the shared ancestor `.w-expansion-item__content` wrapper as one
        `::before` tiled with a `radial-gradient` every 8px down the wrapper's ENTIRE height -- which
        is every row inside it, several levels of descendants included -- so instead of one dot per
        row it drew a repeating column, and its `:has(:hover)` trigger matched as soon as ANY
        descendant, at any depth, was hovered: a row nested three levels deep lit all three
        ancestors' lanes at once, not just the lanes it actually sits inside.

        The dot moved onto each ROW's own `::before` instead, which is what gives it a real notion
        of "this one row's height" to center on, and a real hover trigger that is just `&:hover`, no
        `:has()` needed at all: a folder's header row sits BESIDE its own `.content` (siblings, per
        `WExpansionItem.vue`), never inside it, so no `.w-item` is ever a DOM ancestor of another --
        hovering one can never put a second one into `:hover` state the way a shared ancestor
        wrapper could.

        That first fix scoped the hover correctly but still drew exactly one dot, reaching back only
        the single CLOSEST lane, regardless of how many `.content` wrappers actually enclosed the
        row (OpenProject #2932). `--nav-depth` fixed that -- but the fix reached BACKWARD from the
        row's own edge (`inset-inline-start: calc((depth * -10px) - inset)`, `width: depth * 10px`),
        which anchors the trail's NEAR end (closest to the icon) at the row's own fixed position and
        grows the FAR end further away from the navbar edge as depth increases: exactly backward
        from the wanted cue (anchored at the edge, reaching toward the icon), and the reported
        Cobalt symptom -- dots flush against or past the column edge with no breathing room -- was
        the same root cause, since the reach-back depended on subtracting `--nav-item-inset` to
        compensate for the row's own gutter margin (OpenProject #2951).

        Now that the indent lives on the row's own padding instead of a nested border chain (above),
        the dot needs no reach-back math at all: `inset-inline-start: 0` sits at the row's own left
        edge, and since every row now spans the navbar's full width and `margin-inline` (Cobalt's
        own row-gutter inset) sits OUTSIDE this box, that edge is the SAME absolute position for
        every row regardless of depth -- already carrying Cobalt's own gutter breathing room, with
        no separate subtraction needed. `width` still scales with `--nav-depth`, so it is the FAR
        end (toward the icon) that moves as depth increases, landing exactly across the depth-indent
        padding this same rule reserves above and never spilling under the icon/label. The dot image
        itself is a `repeat-x` tile exactly one lane (10px) wide, so it draws once per lane crossed
        rather than once for the whole box regardless of its width. `@media (hover: hover)` keeps a
        touch tap from leaving a lane lit (`WItem.vue`'s own `:has(:disabled):hover` rule uses the
        same guard).
      */
      &::before {
        content: '';
        position: absolute;
        inset-block: 0;
        inset-inline-start: 0;
        width: calc(var(--nav-depth, 0) * 10px);
        background-image: radial-gradient(circle, var(--color-slate-faint) 1px, transparent 1.4px);
        background-repeat: repeat-x;
        background-size: 10px 100%;
        background-position: left center;
        opacity: 0;
      }

      @media (hover: hover) {
        &:hover::before {
          opacity: 0.5;
        }
      }
    }
  }

  /*
    The active row's own bar follows the READING direction, not `sidebarPosition`, and so needs
    nothing said about it here -- which is the whole reason it replaced the notch. That notch needed
    two overrides this file no longer carries, plus a `sidebar-nav--flipped` class on the root to
    drive one of them: a `--flipped` rule to bite it out of the other edge when a site puts its
    sidebar on the right, and a breakpoint rule to suppress it entirely once the drawer overlays the
    page, since a mark made of the page showing through has nothing to show through while it floats
    OVER that page. Neither applies to a bar.
  */

  /*
    A group heading: Cardinal's chrome overline, in tracked uppercase Roboto Mono. `!important`
    because `WItemLabel`'s `header` variant sets its own colour.

    `:not(.body--cobalt)` on this and the `&-header` dark override below (OpenProject #2774): both
    are aesthetic-blind `.body--dark` rules whose specificity would otherwise beat the token-based
    base color regardless of aesthetic, clobbering Cobalt dark's own (already-correct, inherited
    unchanged from Cobalt light) `--color-sidebar-*` values with Ledger's dark literals.
  */
  @at-root .body--dark:not(.body--cobalt) & {
    color: var(--color-text-secondary-dark);

    .w-expansion-item__arrow {
      color: var(--color-slate-light);
    }
  }

  &-header {
    color: var(--color-sidebar-kicker) !important;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    /* -> WItemLabel's uniform `p-4` leaves the heading floating between its own group and the one
       above it; tightening the bottom side ties it to the links it labels */
    padding-bottom: 4px;

    @at-root .body--dark:not(.body--cobalt) & {
      color: var(--color-text-caption-dark) !important;
    }
  }
}
</style>
