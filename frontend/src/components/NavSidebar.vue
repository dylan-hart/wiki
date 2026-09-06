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

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import PageNewMenu from '@/components/PageNewMenu.vue'
import NavSidebarItem from './NavSidebarItem.vue'

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
  A section heading between groups of nav items -- the language's own chrome overline, the same voice
  the metadata rail's headings and the admin sidebar's section labels use
  (`ui-redesign/Cardinal Wiki - Ledger 3x.dc.html` sets "DOCUMENTATION" above the tree exactly this
  way). It used to take `text-caption`, which is the app's small BODY size, so a heading read as one
  more nav row set slightly smaller than the rest.
*/
.sidebar-nav-header {
  padding: 0 18px 10px;
  color: $text-caption;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  line-height: 1.4;
  text-transform: uppercase;
}

.body--dark .sidebar-nav-header {
  color: $text-caption-dark;
}

.sidebar-nav {
  /*
    The column's own foreground, stated rather than inherited: the drawer takes the site's chosen
    sidebar colour (or, in dark mode, the ramp -- see `css/_base.scss`), and what a nav row inherits
    from the layout above it is the document's own ink either way.
  */
  color: $slate;
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
      color: $slate-soft;
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
      background-color: $surface;
      color: $ink;
      font-weight: 500;
      /*
        Logical, and paired with the padding below rather than layered over it: the bar is a real
        border, so it takes 2px off the row's own inline-start padding and the label has to give
        them back, or an active row's text would step 2px further in than its neighbours'.

        Which physical side "inline-start" resolves to is the reader's direction, and that is the
        right question here -- unlike the notch this replaces, which had to follow the CONTENT
        column (a site setting) rather than the reading direction, and needed a `--flipped` variant
        to do it. A bar on the edge you start reading from needs no such thing.
      */
      border-inline-start: 2px solid $accent-fill;
      padding-inline-start: 14px;

      .w-icon {
        color: $accent-fill;
      }

      @at-root .body--dark & {
        background-color: $dark-3;
        color: $text-dark;

        .w-icon {
          color: $accent-dark;
        }
      }
    }

    /*
      An open group's children, marked the way `NavEditOverlay` marks a nested nav item: a 10px rule down
      the side of the run, with an elbow at the top turning it out of the row above. The same two pieces
      and the same 10px, so the two views of one navigation tree look like the same tree.

      The rules this replaces addressed `.q-expansion-item__container` and `.q-expansion-item--expanded`,
      which is markup `WExpansionItem` has never emitted -- it renders `__header` and `__content` and
      keeps its state in `aria-expanded`. So none of them matched, and an open group had no line at all.

      No expanded/collapsed state needed here: the content is `v-show`n, so when the group is closed this
      box is `display: none` and takes its border and elbow with it.

      No closing elbow at the bottom (OpenProject #853): there used to be a second, mirrored pseudo-
      element marking where the rail ends, under a group's last child. It was the source of a stray-tail
      artifact -- when a group's own last child is itself an open group, more than one ancestor's closing
      mark lands on the same row, and no amount of narrowing which ancestor gets to draw it (two rounds
      tried) fully avoided some remaining coincidence. Removed instead of chased further: a mark at the
      BOTTOM of a group implies a relationship with whatever row comes next, and there isn't one -- the
      row below a closed-off group is exactly as unrelated to it as any two top-level items are to each
      other. The rail and the opening elbow already say everything true about the structure (this row,
      and everything under it down to wherever the rail stops, belongs to the header above); nothing
      real is lost by dropping a mark that was asserting a connection that never existed.
    */
    .w-expansion-item__content {
      position: relative;
      /*
        Logical, to match the elbow pseudo-element below (`inset-inline-start: -10px`): a physical
        `border-left` here would leave the straight run of the rail on the visual left in RTL while its
        own elbow had already swapped to the inline-start (visual right) edge -- the rule and its turn
        pointing at two different sides of the same row.

        The SAME colour as `background-color` below, on purpose (not `padding-box` clipped, unlike the
        background -- see that comment -- so the rail sits ON TOP of the wash rather than beside it,
        compounding with its own parent's wash the same way the wash itself does). A rail is drawn once
        per level, at that level's OWN edge, so a rail one level up (spanning everything under its
        header, e.g. az-docs's own rail alongside "az-important" AND "Az Hello") reads as exactly that
        level's shade -- the same colour "az-important"'s row itself carries, since az-important sits
        directly inside az-docs's one wash. A rail one level deeper (az-important's own, spanning just
        "Az Hello") compounds with the wash already behind it, reading as "Az Hello"'s own, twice-washed
        shade. Dimming rather than highlighting: a rail used to be a flat translucent white regardless
        of depth, which read as a highlight laid over the tree rather than a property OF it -- tying it
        to the same wash the nesting itself already darkens by makes a rail's shade tell you which
        level's group it belongs to, the same way the row colours already do.
      */
      border-inline-start: 10px solid rgb(0 0 0 / 0.05);
      /*
        And a step DOWN from the sidebar rather than up, which is the one place this parts company with
        `NavEditOverlay`: there the nested rows lift off a near-black panel, here they sit in a coloured
        one, and this dims it -- one step darker per level nested, the same way file explorers and
        editors shade a folder's contents relative to its siblings.

        A translucent black, not a colour: the sidebar's own is the site's to choose (`--q-sidebar`,
        rewritten at runtime for per-site theming), so anything fixed would be right for the default
        tint and wrong for every other site. Held at 5% rather than the 12% it was: the same step that
        read as one shade of a saturated blue reads as a bruise on a near-white tint.

        `padding-box` keeps this wash off the border area -- the rail (above) draws its OWN, unclipped
        copy of this same colour there instead, which is what lets the two compound into progressively
        darker shades with depth rather than the wash silently doubling up under the rail on top of it.
      */
      background-color: rgb(0 0 0 / 0.05);
      background-clip: padding-box;

      /*
        The elbow is one 10px box showing two of its borders: the mitre between them is the angle. Set
        10px outside the content on the appropriate side, so the vertical stroke lines up with the rule
        and continues it. `inset-inline-start: -10px` is the rule's own inline-start edge -- an
        absolute offset here is measured from the padding box, which starts where the border ends.

        This indent runs off the TREE's own nesting, not off `sidebarPosition`: a deeper item indents
        further into the reading direction whichever side the sidebar physically sits on, so -- unlike
        the notch above -- logical properties are all this needs; there is no second `--flipped`
        variant to compose with.

        -> Out of the parent row: the rule's top end, turning toward inline-end into the row above it.
      */
      &::before {
        content: '';
        display: block;
        position: absolute;
        inset-inline-start: -10px;
        width: 10px;
        height: 10px;
        border-style: solid;
        top: -10px;
        border-block-start-width: 0;
        border-inline-end-width: 10px;
        border-block-end-width: 10px;
        border-inline-start-width: 0;
        border-block-start-color: transparent;
        border-inline-end-color: transparent;
        /* -> Same colour as the rail above, for the same reason: this elbow is this level's own
                turn into it, so it carries this level's own shade, not a fixed one. */
        border-block-end-color: rgb(0 0 0 / 0.05);
        border-inline-start-color: rgb(0 0 0 / 0.05);
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
  */
  @at-root .body--dark & {
    color: $text-secondary-dark;

    .w-expansion-item__arrow {
      color: $slate-light;
    }
  }

  &-header {
    color: $text-caption !important;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    /* -> WItemLabel's uniform `p-4` leaves the heading floating between its own group and the one
       above it; tightening the bottom side ties it to the links it labels */
    padding-bottom: 4px;

    @at-root .body--dark & {
      color: $text-caption-dark !important;
    }
  }
}
</style>
