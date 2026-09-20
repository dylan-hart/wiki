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

const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

const router = useRouter()
const route = useRoute()

const { t } = useI18n()

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

/**
 * The loaded child owns the only visible heading for this panel, so the panel's accessible name is
 * looked up here rather than threaded down as a prop -- each entry mirrors the translation key that
 * child's own header already renders.
 */
const SIDE_DIALOG_TITLES = {
  PageBacklinksDialog: () => t('editor.backlinks.title'),
  PagePropertiesDialog: () => t('editor.props.pageProperties')
}

const sideDialogAriaLabel = computed(() => SIDE_DIALOG_TITLES[siteStore.sideDialogComponent]?.())
</script>

<style>
.floating-sidepanel {
  /*
    A definite width rather than a content-driven one: the panel's content arrives asynchronously
    behind a loading placeholder, and a width that changed when the real dialog swapped in jumped
    the right-justified panel's leading edge mid-transition.
  */
}
.floating-sidepanel .w-dialog-panel {
  width: 560px;
  /*
    A dark header clipped by a filled, `overflow: auto` panel's rounded corner leaves a light
    antialias fringe at the top corners under Chromium. So the panel goes transparent and stops
    clipping, and the header/body bands round and fill themselves instead -- left corners only,
    matching this panel's own left-edge float.
  */
}
.body--cobalt .floating-sidepanel .w-dialog-panel {
  background: transparent;
  overflow: visible;
}
.floating-sidepanel {
  /*
    The header band: every child mounted here has exactly one `<w-toolbar>`, so this stays a plain
    descendant selector rather than reaching into either child's own markup or class names.
  */
}
.body--cobalt .floating-sidepanel .w-toolbar {
  border-radius: 12px 0 0 0;
}
.floating-sidepanel {
  /*
    The body band, same one-per-dialog guarantee: it carries the surface fill the transparent panel
    no longer provides, matching `.w-card`'s own background in `tailwind.css`.
  */
}
.body--cobalt .floating-sidepanel .w-scroll-area {
  border-radius: 0 0 0 12px;
  background-color: var(--color-white);
}
.body--cobalt.body--dark .floating-sidepanel .w-scroll-area {
  background-color: var(--color-dark-3);
}
.floating-sidepanel {
  /*
    The card each mounted dialog wraps its content in. `--radius-card` (8px) is smaller than this
    panel's `--radius-dialog` (12px) that the toolbar and scroll area round themselves to, so a
    filled card paints a mismatched-colour notch just inside the header's wider curve. It therefore
    stops filling and drawing its own edge in Cobalt -- the toolbar and scroll area already cover
    the whole visible surface between them. Ledger's radii are both 0, so nothing can mismatch.
  */
}
.body--cobalt .floating-sidepanel .w-card {
  background: transparent;
  box-shadow: none;
}
.body--light .floating-sidepanel .alt-card {
  background-color: var(--color-grey-2);
  border-top: 1px solid var(--color-grey-4);
  box-shadow:
    inset 0 1px 0 0 #fff,
    inset 0 -1px 0 0 #fff;
  border-bottom: 1px solid var(--color-grey-4);
}
.body--dark .floating-sidepanel .alt-card {
  background-color: var(--color-dark-4);
  border-top: 1px solid color-mix(in srgb, var(--color-dark-3) 88%, #fff);
  box-shadow:
    inset 0 1px 0 0 var(--color-dark-6),
    inset 0 -1px 0 0 var(--color-dark-6);
  border-bottom: 1px solid color-mix(in srgb, var(--color-dark-3) 88%, #fff);
}
.floating-sidepanel {
  /*
    The rail below hangs outside the panel, but its containing block is the card INSIDE the panel,
    so `WDialog`'s `overflow: auto` on `.w-dialog-panel` clips it away entirely. Lifted only for the
    panel that actually carries a rail: a side dialog without one still leans on that overflow both
    to round the panel and to scroll a card wider than it.
  */
}
.floating-sidepanel .w-dialog-panel:has(> .page-properties-dialog) {
  overflow: visible;
}
.floating-sidepanel {
  /*
    The quick-jump rail sits outside the panel's leading edge, anchored to the card (`WCard` is a
    positioned element) so it tracks whatever width the panel ends up with rather than a hard-coded
    offset.

    -> `inset-inline-end`, not `right`: the rail is a leading-edge companion to the panel, not a
       screen-corner anchor, so it follows the panel to the other side under RTL.
  */
}
.floating-sidepanel-quickaccess {
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
</style>
