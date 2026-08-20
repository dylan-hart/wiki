<template>
  <!-- -> The dent marking the current page is cut out of the edge FACING the content, which is the
          right one only while the sidebar is on the left; see the stylesheet -->
  <w-scroll-area
    class="sidebar-nav"
    :class="siteStore.theme.sidebarPosition === `right` ? `sidebar-nav--flipped` : ``"
    :thumb-style="thumbStyle"
    :bar-style="barStyle">
    <w-list class="sidebar-nav-list" clickable dense dark>
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
  </w-scroll-area>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import NavSidebarItem from './NavSidebarItem.vue'

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const thumbStyle = {
  right: '2px',
  borderRadius: '5px',
  backgroundColor: '#FFF',
  width: '5px',
  opacity: 0.5
}
const barStyle = {
  backgroundColor: '#000',
  width: '9px',
  opacity: 0.1
}

// WATCHERS

watch(
  () => pageStore.navigationId,
  (newValue) => {
    if (newValue && newValue !== siteStore.nav.currentId) {
      siteStore.fetchNavigation(newValue)
    }
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
      the side of the run, with an elbow at each end turning it out of the row above and closing it under
      the last child. The same three pieces and the same 10px, so the two views of one navigation tree
      look like the same tree.

      The rules this replaces addressed `.q-expansion-item__container` and `.q-expansion-item--expanded`,
      which is markup `WExpansionItem` has never emitted -- it renders `__header` and `__content` and
      keeps its state in `aria-expanded`. So none of them matched, and an open group had no line at all.

      No expanded/collapsed state needed here: the content is `v-show`n, so when the group is closed this
      box is `display: none` and takes its border and both elbows with it.
    */
    .w-expansion-item__content {
      position: relative;
      /*
        Logical, to match the two elbow pseudo-elements below (`inset-inline-start: -10px`): a
        physical `border-left` here would leave the straight run of the rail on the visual left in
        RTL while its own elbows had already swapped to the inline-start (visual right) edge --
        the rule and its turns pointing at two different sides of the same row.
      */
      border-inline-start: 10px solid rgba(255, 255, 255, 0.25);
      /*
        And a step DOWN from the sidebar rather than up, which is the one place this parts company with
        `NavEditOverlay`: there the nested rows lift off a near-black panel, here they sit in a coloured
        one, and a lighter wash on a mid-tone blue reads as a highlight -- as if the whole group were
        selected.

        A translucent black, not a colour: the sidebar's own is the site's to choose (`--q-sidebar`,
        rewritten at runtime for per-site theming), so anything fixed would be right for the default blue
        and wrong for every other site.

        `padding-box` keeps that wash off the border area. The rule there is 25% white, and with the
        default `border-box` clip the darkened wash behind it would leave the rule a different colour
        along the children than at the two elbows, which have nothing behind them.
      */
      background-color: rgb(0 0 0 / 0.12);
      background-clip: padding-box;

      /*
        Each elbow is one 10px box showing two of its borders: the mitre between them is the angle. Set
        10px outside the content on the appropriate side, so the vertical stroke lines up with the rule
        and continues it. `inset-inline-start: -10px` is the rule's own inline-start edge -- an
        absolute offset here is measured from the padding box, which starts where the border ends.

        This indent runs off the TREE's own nesting, not off `sidebarPosition`: a deeper item indents
        further into the reading direction whichever side the sidebar physically sits on, so -- unlike
        the notch above -- logical properties are all this needs; there is no second `--flipped`
        variant to compose with.
      */
      &::before,
      &::after {
        content: '';
        display: block;
        position: absolute;
        inset-inline-start: -10px;
        width: 10px;
        height: 10px;
        border-style: solid;
      }

      /* -> Out of the parent row: the rule's top end, turning toward inline-end into the row above it */
      &::before {
        top: -10px;
        border-block-start-width: 0;
        border-inline-end-width: 10px;
        border-block-end-width: 10px;
        border-inline-start-width: 0;
        border-block-start-color: transparent;
        border-inline-end-color: transparent;
        border-block-end-color: rgba(255, 255, 255, 0.25);
        border-inline-start-color: rgba(255, 255, 255, 0.25);
      }

      /*
        And closed under the last child, turning toward inline-end again -- the mirror of `::before`
        above, so it carries only ONE block-direction border the way `::before` does (there,
        block-end; here, block-start), not both. This one used to declare BOTH block borders at
        10px, which under this app's global `box-sizing: border-box` (Tailwind's preflight) can
        never render shorter than border-block-start-width + border-block-end-width -- 20px against
        the `height: 10px` above, so the browser silently doubled the box. The extra 10px was
        transparent, so alone it painted nothing; it's still a real oversizing bug worth zeroing out
        (matching `::before`'s single-border shape), even though the actual visible artifact below
        turned out to have a different cause.
      */
      &::after {
        top: 100%;
        border-block-start-width: 10px;
        border-inline-end-width: 10px;
        border-block-end-width: 0;
        border-inline-start-width: 0;
        border-block-start-color: rgba(255, 255, 255, 0.25);
        border-inline-end-color: transparent;
        border-inline-start-color: rgba(255, 255, 255, 0.25);
      }

      /*
        OpenProject #853's screenshot -- a "docs > important > page" chain with a jarring stray tail
        poking out of the highlighted row into the row above it -- turned out not to be `TreeNav`/
        `TreeNode` (the file manager's folder picker, which never renders a page inline) but THIS
        elbow, on the reading-mode sidebar, live-verified with the same fixture shape.

        Every `::after` above sits at `top: 100%` of ITS OWN content box, i.e. at its own last
        child's bottom edge. That's fine for a group whose last child is a plain page: exactly one
        `::after`, at that page's own row, turns the rail closed. But when a group's last child is
        ANOTHER group -- "important" is "docs"'s only child, "docs" closes at exactly the row
        "important" closes at -- both ancestors' `::after` boxes land on the identical row, one at
        this level's rail position and one 10px further in. Two mitred corners meeting at the same
        row, a step apart, don't read as a clean two-step staircase the way the OPENING elbows do
        (those never coincide -- each is pinned to its own header row, which is always a distinct
        row from its parent's). They read as a single broken, double-pointed tail, because there is
        no vertical separation between the two turns for the eye to parse as "two levels" rather
        than "one shape gone wrong" -- confirmed by screenshot: a lone closing elbow (one ancestor)
        is a clean cut, and it only becomes the reported tail once a second ancestor's closing
        elbow lands on the same row.

        The fix is to draw only the INNERMOST closing turn of any such run: an ancestor whose own
        last child is itself an OPEN group defers to that child's `::after` for the visual close
        and skips drawing its own, which collapses any length of last-child chain (docs > important
        > docs > page reproduces the same coincidence one level deeper) down to exactly one visible
        turn, at the true bottom row, same as a single-level group already draws correctly.

        `[aria-expanded="true"]` (on the child's own header, per `WExpansionItem`) rather than just
        "last child is a group": a COLLAPSED last-child group renders no `::after` of its own (its
        whole `.content` is `v-show`n out), so deferring to it unconditionally would leave a group
        whose last row happens to be a closed folder with no closing mark drawn at all.
      */
      &:has(
          > .w-list > .w-expansion-item:last-child > .w-expansion-item__header[aria-expanded='true']
        )::after {
        content: none;
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
