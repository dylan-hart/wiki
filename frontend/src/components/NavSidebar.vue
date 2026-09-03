<template>
  <!-- -> The dent marking the current page is cut out of the edge FACING the content, which is the
          right one only while the sidebar is on the left; see the stylesheet -->
  <w-scroll-area
    class="sidebar-nav"
    :class="siteStore.theme.sidebarPosition === `right` ? `sidebar-nav--flipped` : ``">
    <!-- -> The primary navigation landmark: distinct from `PageToc`'s own `<nav>` so the two are
            reachable and tellable apart from the landmarks rotor -->
    <nav :aria-label="t(`common.sidebar.browse`)">
      <w-list class="sidebar-nav-list" dense dark>
        <template v-for="item of siteStore.nav.items" :key="item.id">
          <w-item-label
            class="sidebar-nav-header text-caption text-wordbreak-all"
            v-if="item.type === `header`"
            header
            >{{ item.label }}</w-item-label
          >
          <!-- -> One nav item, plus its expansion behavior if it has children -- recursive, so a
                  folder nested any number of levels deep still draws its own contents rather than
                  only the first level under the sidebar root -->
          <nav-sidebar-item v-else-if="item.type === `link`" :item="item" />
          <w-separator v-else-if="item.type === `separator`" dark />
        </template>
      </w-list>
      <!-- -> Right-click empty space to create at the locale root -- only meaningful when there is
              a real tree backing this menu (auto/mixed); a static menu's links may not correspond
              to any page at all -->
      <page-new-menu
        v-if="canCreateAtRoot"
        context-menu
        show-new-folder
        base-path=""
        :hide-asset-btn="!canUploadAsset"
        @new-folder="openFolderDialog(null)" />
    </nav>
  </w-scroll-area>
</template>

<script setup>
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useNavCreateMenu } from '@/composables/navCreateMenu'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import PageNewMenu from '@/components/PageNewMenu.vue'
import NavSidebarItem from './NavSidebarItem.vue'

// STORES

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

// WATCHERS

watch(
  () => pageStore.navigationId,
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

.sidebar-nav {
  border-top: 1px solid rgba(255, 255, 255, 0.15);
  /* -> Fills whatever the drawer's flex column has left over, rather than subtracting the action bar
     and footer bar by hand: both are conditional, so a fixed `calc()` left dead space at the bottom
     for an anonymous reader (no footer bar) and for a site with no action bar at all. `min-height: 0`
     is what lets it shrink below its content so the scroll area actually scrolls. */
  flex: 1 1 0;
  min-height: 0;

  /* -> The `<nav>` inside this scroll area has no height rule of its own, so with few or zero items
     it collapses to its content's height and leaves empty space below it that is inside
     `.sidebar-nav` but OUTSIDE `<nav>` -- exactly the space `WMenu`'s root-level context-menu
     trigger binds to. Without this, right-clicking that empty space (the case that matters most:
     an empty or near-empty sidebar, where "right-click to create the first page" is the whole
     point) has no `<nav>` surface under the pointer to bind to, and does nothing. */
  > nav {
    min-height: 100%;
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

    /* -> Full white, like the icons and labels this sidebar sets by hand: the chevron is what says the
       row opens, so it is not the secondary content a trailing section is dimmed for. Set on the icon
       rather than on its section, which is what makes it beat the inherited dimmed colour. */
    .w-expansion-item__arrow {
      color: #fff;
    }

    .w-item-section--avatar {
      min-width: auto;
    }

    /*
      The row holding the page being read, marked by a notch bitten out of the sidebar's inner edge.

      Painted in the colour of what is on the other side of that edge -- the page itself, which is the
      body's own background, since nothing between here and the article column paints one. So it is not a
      marker drawn ON the sidebar but a piece of the sidebar missing, with the content showing through.

      `router-link-exact-active` is `RouterLink`'s own, so the mark follows the reader without this
      component tracking anything: a row rendered as a plain `<a>` -- an address that leaves the wiki or
      opens in a new tab -- never carries it, which is right, because a reader is never already there.
    */
    .w-item.router-link-exact-active {
      position: relative;

      /*
        A triangle out of one border: the INLINE-END border is the only one with a colour, and the
        inline-start one has no width, so the shape tapers to a point on the inline-start side. Flush
        to the edge and centred on the row.

        Written in logical properties rather than `left`/`right` on purpose: this edge always faces
        the content column, whether that column sits at the sidebar's inline-end (this rule) or its
        inline-start (the `--flipped` override below) is decided by `sidebarPosition`, a SITE setting
        -- and which physical side "inline-end" resolves to is decided independently by the reader's
        text direction. `WLayout`'s grid (`ldrawer main rdrawer`) already places those areas along the
        inline axis, so the sidebar itself swaps physical sides under `dir="rtl"` with no extra CSS;
        what logical properties buy here is keeping the NOTCH glued to the edge that swapped with it,
        for every one of the four `sidebarPosition` × direction combinations, without this rule having
        to ask which one it is currently in.
      */
      &::after {
        content: '';
        position: absolute;
        top: 50%;
        inset-inline-end: 0;
        width: 0;
        height: 0;
        transform: translateY(-50%);
        border-style: solid;
        border-block-width: 7px;
        border-inline-start-width: 0;
        border-inline-end-width: 7px;
        border-block-color: transparent;
        border-inline-start-color: transparent;
        border-inline-end-color: #fff;

        @at-root .body--dark & {
          border-inline-end-color: $dark-6;
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
      border-inline-start: 10px solid rgb(0 0 0 / 0.12);
      /*
        And a step DOWN from the sidebar rather than up, which is the one place this parts company with
        `NavEditOverlay`: there the nested rows lift off a near-black panel, here they sit in a coloured
        one, and this dims it -- one step darker per level nested, the same way file explorers and
        editors shade a folder's contents relative to its siblings.

        A translucent black, not a colour: the sidebar's own is the site's to choose (`--q-sidebar`,
        rewritten at runtime for per-site theming), so anything fixed would be right for the default blue
        and wrong for every other site.

        `padding-box` keeps this wash off the border area -- the rail (above) draws its OWN, unclipped
        copy of this same colour there instead, which is what lets the two compound into progressively
        darker shades with depth rather than the wash silently doubling up under the rail on top of it.
      */
      background-color: rgb(0 0 0 / 0.12);
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
        border-block-end-color: rgb(0 0 0 / 0.12);
        border-inline-start-color: rgb(0 0 0 / 0.12);
      }
    }
  }

  /*
    A site can put this sidebar on the right instead, which puts the page on the other side of it: the
    notch has to be bitten out of the inline-start edge then, and point the other way, or it is a white
    arrow pointing at nothing. `sidebarPosition` is a SITE setting, independent of the reader's text
    direction -- see the comment on the base rule above -- so this override exists whether the locale
    is LTR or RTL, and each of those still resolves "inline-start"/"inline-end" for itself.

    Same specificity as the rule it overrides and stated after it, so the sides swap cleanly.
  */
  &--flipped .w-list .w-item.router-link-exact-active::after {
    inset-inline-end: auto;
    inset-inline-start: 0;
    border-inline-start-width: 7px;
    border-inline-end-width: 0;
    border-inline-start-color: #fff;
    border-inline-end-color: transparent;

    @at-root .body--dark & {
      border-inline-start-color: $dark-6;
    }
  }

  /*
    A child row starts 10px in, past the rule that marks the group -- and on this side that is the edge
    the notch is cut from, so it would be bitten out of the middle of the sidebar with a strip of colour
    still outside it. Pushed back out to where the sidebar itself ends.

    The other way round this does not arise: with the sidebar on the left the notch is on the right edge,
    and only the left of a child row is indented.
  */
  /*
    No notch at all once the drawer overlays the page instead of taking a column beside it.

    The mark is not drawn ON the sidebar -- it is a piece of the sidebar MISSING, painted in the colour
    of whatever is on the other side of that edge, which is the page. Overlaying, there is nothing on
    the other side to show through: the panel floats over the article with a scrim behind it, so the
    notch stops being an absence and becomes what it is made of -- a white arrow on a coloured panel,
    pointing at the middle of a page it is covering. Which is also why hiding it is a matter of the
    layout rather than of the screen being a phone: the same arrow is just as wrong on a tablet.

    `content: none` rather than `display: none`, so the box is never generated. Stated after both
    `--flipped` rules and at their specificity, so it takes the notch away whichever edge it was cut
    from -- and `$sidebar-overlay-max` is the width MainLayout hands the drawer as `overlayBelow`, which
    the two have to agree on.
  */
  @media (max-width: $sidebar-overlay-max) {
    .w-list .w-item.router-link-exact-active::after {
      content: none;
    }
  }

  &-header {
    color: rgba(255, 255, 255, 0.75) !important;
    /* -> WItemLabel's uniform `p-4` leaves the heading floating between its own group and the one
       above it; tightening the bottom side ties it to the links it labels */
    padding-bottom: 4px;
  }
}
</style>
