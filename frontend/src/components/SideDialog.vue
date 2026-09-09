<template>
  <w-dialog
    class="floating-sidepanel"
    v-model="siteStore.sideDialogShown"
    position="right"
    full-height
    :aria-label="sideDialogAriaLabel">
    <component :is="sideDialogs[siteStore.sideDialogComponent]" />
  </w-dialog>
</template>

<script setup>
import { computed, defineAsyncComponent, onMounted, reactive, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { useEditorStore } from '@/stores/editor'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import LoadingGeneric from '@/components/LoadingGeneric.vue'

const sideDialogs = {
  PageBacklinksDialog: defineAsyncComponent({
    loader: () => import('@/components/PageBacklinksDialog.vue'),
    loadingComponent: LoadingGeneric
  }),
  PagePropertiesDialog: defineAsyncComponent({
    loader: () => import('@/components/PagePropertiesDialog.vue'),
    loadingComponent: LoadingGeneric
  })
}

// STORES

const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  showSideDialog: false,
  sideDialogComponent: null,
  showGlobalDialog: false,
  globalDialogComponent: null,
  showTagsEditBtn: false,
  tagEditMode: false,
  tocExpanded: ['h1-0', 'h1-1'],
  tocSelected: []
})

// COMPUTED

/**
 * `sideDialogs`' loaded child owns the only visible heading for this panel (its own `<w-header
 * class="card-header">`), so the panel's accessible name is looked up here rather than duplicated as
 * a prop threaded down -- each entry mirrors the exact translation key that child's own header
 * already renders (OpenProject #2356).
 */
const SIDE_DIALOG_TITLES = {
  PageBacklinksDialog: () => t('editor.backlinks.title'),
  PagePropertiesDialog: () => t('editor.props.pageProperties')
}

const sideDialogAriaLabel = computed(() => SIDE_DIALOG_TITLES[siteStore.sideDialogComponent]?.())
</script>

<style lang="scss">
@use 'sass:color';

/*
  The rules that used to sit here hung off `.q-dialog__inner` and `.w-card__section`, neither of which
  this app renders any more -- so the inset, the radius and the panel's minimum width had all silently
  stopped applying. The inset and radius now come from WDialog's own `right` variant, where they
  belong; only the panel's floor width is a side-panel concern, and it is stated on the panel itself.
*/
.floating-sidepanel {
  /*
    A definite width, not the `min-width: 450px` this replaces. The panel's content arrives
    asynchronously behind a loading placeholder, and while the width was content-driven it changed
    when the real dialog swapped in -- which, on a right-justified panel, jumped the left edge 112px
    mid-transition and made a 32px slide look like a lurch. 560px is the width the content settles at
    anyway; measured, nothing inside asks for more, date picker included.
  */
  .w-dialog-panel {
    width: 560px;

    /*
      Cobalt dialog corner fringe (OpenProject #2865, `ui-iteration/README.md` Part 1.2): a dark
      header clipped by a filled, `overflow:auto` panel's rounded corner leaves a light antialias
      fringe at the top corners under Chromium -- worse here since the panel is *also* clipping a
      scroll container to its padding box. Fixed the same way as `MainOverlayDialog` (OpenProject
      #2864): the panel itself goes transparent and stops clipping, and the header/body bands round
      and fill themselves instead -- side-specific radii (left corners only, matching this panel's
      own left-edge float) rather than MainOverlayDialog's all-four-corner treatment.
    */
    @at-root .body--cobalt & {
      background: transparent;
      overflow: visible;
    }
  }

  /*
    The header band. Whichever child is mounted (`PageBacklinksDialog`, `PagePropertiesDialog`;
    see `sideDialogs` above), its heading is always a `<w-toolbar>` -- there is exactly one per
    dialog, so this stays a plain descendant selector rather than reaching into either child's own
    markup or class names.
  */
  .w-toolbar {
    @at-root .body--cobalt & {
      border-radius: 12px 0 0 0;
    }
  }

  /*
    The body band -- the scroll area beneath the header, same one-per-dialog guarantee. Carries the
    surface fill the now-transparent panel no longer provides, matching `.w-card`'s own background
    (`tailwind.css`'s `.w-card` / `body.body--dark .w-card`) since that fill is what this replaces;
    `overflow: auto` is `WScrollArea`'s own base style already, unconditionally.
  */
  .w-scroll-area {
    @at-root .body--cobalt & {
      border-radius: 0 0 0 12px;
      background-color: var(--color-white);
    }
    @at-root .body--cobalt.body--dark & {
      background-color: var(--color-dark-3);
    }
  }

  .alt-card {
    @at-root .body--light & {
      background-color: $grey-2;
      border-top: 1px solid $grey-4;
      box-shadow:
        inset 0 1px 0 0 #fff,
        inset 0 -1px 0 0 #fff;
      border-bottom: 1px solid $grey-4;
    }
    @at-root .body--dark & {
      background-color: var(--color-dark-4);
      border-top: 1px solid color-mix(in srgb, var(--color-dark-3) 88%, #fff);
      box-shadow:
        inset 0 1px 0 0 var(--color-dark-6),
        inset 0 -1px 0 0 var(--color-dark-6);
      border-bottom: 1px solid color-mix(in srgb, var(--color-dark-3) 88%, #fff);
    }
  }

  /*
    The rail below hangs outside the panel, so the panel holding it must not clip.

    `WDialog` puts `overflow: auto` on `.w-dialog-panel` -- that is what rounds a centred dialog whose
    inner bands would otherwise paint over its corners, and it keeps oversized content reachable. The
    rail's containing block is the card INSIDE that panel, so the clip catches it and it disappeared
    outright the moment that overflow arrived.

    Lifted only for the panel that actually carries a rail, rather than for every side panel: a side
    dialog with no rail can still lean on the panel both to round it and to scroll a card wider than
    the panel is. Nothing is given up here -- `PagePropertiesDialog` rounds its own toolbar and scroll
    area, and that scroll area is what its body scrolls in.
  */
  .w-dialog-panel:has(> .page-properties-dialog) {
    overflow: visible;
  }

  /*
    The quick-jump rail, which sits outside the panel's leading edge.

    Two things kept it off screen. It was `position: fixed` at a hard-coded `right: 486px`, a number
    derived from a panel 450px wide with a 24px margin -- once the panel sized itself to its content
    (562px) that offset landed the rail INSIDE the panel. And `z-index: -1` then painted it behind the
    card's own background, so even overlapping it was invisible.

    Anchored to the card instead (`WCard` is a positioned element), so it tracks whatever width the
    panel ends up with. The two `.q-transition--jump-*` rules that hid it mid-animation are gone with
    the Quasar transitions they named; the 300ms timer in the dialog already keeps it out of the slide.

    -> `inset-inline-end`, not `right` (OpenProject #1601): the rail is a leading-edge companion to
       the panel, not a screen-corner anchor, so it follows the panel to the other side under RTL.
  */
  &-quickaccess {
    position: absolute;
    inset-inline-end: calc(100% + 12px);
    top: 24px;
    width: 40px;
    display: flex;
    flex-direction: column;
    background-color: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(5px);
    color: #fff;
    box-shadow: 0 0 5px 0 rgba(0, 0, 0, 0.5);
  }
}
</style>
