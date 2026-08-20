<template>
  <!--
    Single root, deliberately. The scrim is teleported to <body> rather than rendered as a sibling
    here, because a multi-root component gets no attribute fallthrough -- and every drawer in this
    app is styled by a class the caller puts on the tag (`.admin-sidebar`, `.bg-sidebar`, ...).

    `v-show` rather than `v-if`: a `display: none` grid item generates no box, so the drawer's
    column collapses to zero width exactly as if it were absent, while the element stays mounted so
    its scroll position and any child state survive being closed. `Transition` drives `v-show` here,
    which keeps that property -- it only defers the `display: none` until the slide has finished.

    The width goes out as a custom property rather than an inline `width`, because the slide has to
    be able to state its own geometry in terms of it and an inline style would outrank the class.
  -->
  <transition name="w-drawer">
    <aside
      v-show="isVisible"
      class="w-drawer flex flex-col"
      :class="[
        side === 'right' ? 'w-drawer--right' : 'w-drawer--left',
        isOverlay ? 'w-drawer--overlay fixed inset-y-0 z-40 shadow-dialog' : '',
        isOverlay && side === 'right' ? 'end-0' : '',
        isOverlay && side !== 'right' ? 'start-0' : '',
        bordered ? borderClass : '',
        dark ? 'text-white' : ''
      ]"
      :style="{ '--w-drawer-width': `${width}px` }">
      <teleport to="body">
        <transition name="w-drawer-scrim">
          <div
            v-if="isVisible && isOverlay"
            class="fixed inset-0 z-30 bg-black/40"
            @click="$emit('update:modelValue', false)" />
        </transition>
      </teleport>
      <slot />
    </aside>
  </transition>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useMinWidth } from '@/composables/screen'

/**
 * Side panel of a `WLayout`.
 *
 * Two modes, chosen by viewport width rather than by a prop:
 *   - wide   -- occupies its own grid column, pushing the page across
 *   - narrow -- overlays the page with a dismissable scrim
 *
 * `showIfAbove` reproduces the old behaviour where a drawer starts open on a wide screen whatever
 * its model value says -- a starting state only, not a permanent override: see `defaultOpen`.
 */
const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false
  },
  /** Width in pixels. */
  width: {
    type: Number,
    default: 300
  },
  /**
   * `'left'` places the drawer in the grid's first (reading-START) column, `'right'` in its last
   * (reading-END) one -- this is a LOGICAL choice, not a literal physical side: `.w-layout`'s CSS
   * Grid mirrors column order under `dir="rtl"` on its own, so `'left'` (the default, what the site
   * sidebar uses) renders on the visual left under LTR and the visual right under RTL. See the
   * `<style>` block's `margin-inline-start`/`-end` comment for the bug this caused when the rest of
   * the component didn't yet track that (OpenProject #834).
   */
  side: {
    type: String,
    default: 'left',
    validator: (v) => ['left', 'right'].includes(v)
  },
  /** Start the drawer open on wide viewports, whatever the model says at mount. */
  showIfAbove: {
    type: Boolean,
    default: false
  },
  /** Divider line between the drawer and the page. */
  bordered: {
    type: Boolean,
    default: false
  },
  /**
   * Width in px below which the drawer overlays the page instead of taking a column of its own.
   *
   * 1024 is the `md` breakpoint and what every drawer used before this was a prop; the site sidebar asks
   * for 1200, because it is 255px wide beside an article that also gives up a contents column — see
   * `MainLayout`. Read once, at setup: a caller states this as a constant, not something that changes
   * under a mounted drawer.
   */
  overlayBelow: {
    type: Number,
    default: 1024
  },
  /**
   * Light foreground, for a panel that is dark in both themes.
   *
   * The drawer this replaces coloured its own content when marked dark, and the admin overlays are
   * written that way. Without the prop the attribute falls through to the <aside> as a stray
   * `dark="true"` and the labels stay black on a near-black panel -- readable only where something
   * else happens to set a colour, which is how it slipped through: the ACTIVE row had its own
   * `text-white`, so only the unselected labels went missing.
   *
   * The background stays the caller's job (a class), as it already was.
   */
  dark: {
    type: Boolean,
    default: false
  }
})

defineEmits(['update:modelValue'])

/** Where this drawer stops overlaying and takes its own column. See `overlayBelow`. */
const isWide = useMinWidth(props.overlayBelow)

const isOverlay = computed(() => !isWide.value)

/**
 * `showIfAbove` only supplies the initial state, and stops applying the moment the model says
 * anything of its own -- ORing it into `isVisible` for good made the model unable to CLOSE a drawer
 * on a wide screen, which is how the editor lost its full width: it drops the site sidebar by
 * flipping the model to false, and nothing happened.
 *
 * Cleared for good rather than per breakpoint, so widening the window mid-edit does not pop the
 * sidebar back open.
 */
const defaultOpen = ref(props.showIfAbove)

watch(
  () => props.modelValue,
  () => {
    defaultOpen.value = false
  }
)

const isVisible = computed(() => props.modelValue || (isWide.value && defaultOpen.value))

const borderClass = computed(() =>
  props.side === 'right'
    ? 'border-s border-black/12 dark:border-white/15'
    : 'border-e border-black/12 dark:border-white/15'
)
</script>

<style scoped>
.w-drawer {
  width: var(--w-drawer-width);
}

.w-drawer--left {
  grid-area: ldrawer;
}
.w-drawer--right {
  grid-area: rdrawer;
}

/* -> An overlaying drawer is out of flow, so it must not also claim its grid column */
.w-drawer--overlay {
  grid-area: unset;
}

/*
  The slide is a negative outer margin, not a transform: the drawer's grid column is `auto`, so it is
  sized by the item's MARGIN box, and pulling the margin to `-width` collapses the column to zero
  while the border box keeps its full width and simply hangs off the edge. One animated property
  therefore does both halves of the effect -- the panel slides out and the page grows into the space
  it leaves, in step. A transform would have moved the panel but left the column at full width, and
  animating `width` would have reflowed the nav on every frame instead of sliding it.

  Nothing clips the panel on its way out, but nothing needs to: overflow past the leading edge of the
  document creates no scrollable area, and an overlaying drawer is `fixed`, which is outside the
  document's overflow altogether.

  `margin-inline-start`/`-end`, not the physical `margin` pair they replaced (OpenProject #834):
  `.w-layout`'s grid places `ldrawer` and `rdrawer` by their LOGICAL column order (1 and 3), which the
  CSS Grid spec itself mirrors under `dir="rtl"` -- column 1 renders at the visual right, not the
  left, once the document goes RTL. `.w-drawer--left` (grid area `ldrawer`) is therefore always the
  reading-START column, whichever physical edge that is, and collapsing it with a hardcoded physical
  property that does NOT mirror pulled it the wrong way under RTL: toward the CENTER of the page (in
  through the sidebar's own physical left edge) rather than off-canvas through the true edge the grid
  had already mirrored it to. The logical property tracks the same edge the grid resolved to, in
  either direction, with no JS involved -- consistent with `border-s`/`border-e` below, which fixes
  the matching bug on the drawer's OWN border (facing whichever edge `main` sits on), and with
  `start-0`/`end-0` above, which fixes it for the overlay/narrow breakpoint's `position: fixed` case
  -- a raw-pixel context the grid's own mirroring never reached, so it stayed pinned to the physical
  left/right of the VIEWPORT there even after task 721/727 mirrored everything else. Crossing that
  overlay breakpoint is exactly what a reader's browser zoom does (it is CSS-pixel width, not device
  width, that the breakpoint reads), which is why this surfaced as a nav layout that looked fine at
  100% and broke at another zoom level rather than a plain, always-broken RTL bug.
*/
.w-drawer-enter-active,
.w-drawer-leave-active {
  transition: margin 0.2s var(--ease-standard);
}
.w-drawer--left.w-drawer-enter-from,
.w-drawer--left.w-drawer-leave-to {
  margin-inline-start: calc(-1 * var(--w-drawer-width));
}
.w-drawer--right.w-drawer-enter-from,
.w-drawer--right.w-drawer-leave-to {
  margin-inline-end: calc(-1 * var(--w-drawer-width));
}

.w-drawer-scrim-enter-active,
.w-drawer-scrim-leave-active {
  transition: opacity 0.2s var(--ease-standard);
}
.w-drawer-scrim-enter-from,
.w-drawer-scrim-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .w-drawer-enter-active,
  .w-drawer-leave-active,
  .w-drawer-scrim-enter-active,
  .w-drawer-scrim-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
