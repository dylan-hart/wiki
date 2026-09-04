<template>
  <w-dialog
    v-model="siteStore.overlayIsShown"
    class="main-overlay"
    persistent
    full-width
    full-height
    :aria-label="overlayAriaLabel">
    <!--
      `overlay-opts` carries whatever initial state the opener set via `siteStore.openOverlay(name,
      opts)` (or a plain `$patch`) through to the mounted overlay as a real prop -- every entry in
      `overlays` below declares it, even the ones that don't read it yet, since an undeclared prop
      falls through to this element's DOM root instead (OpenProject #2530).
    -->
    <component :is="overlays[siteStore.overlay]" :overlay-opts="siteStore.overlayOpts" />
  </w-dialog>
</template>

<script setup>
import { computed, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSiteStore } from '../stores/site'

import LoadingGeneric from './LoadingGeneric.vue'

const overlays = {
  BlockPicker: defineAsyncComponent({
    loader: () => import('./BlockPickerOverlay.vue'),
    loadingComponent: LoadingGeneric
  }),
  EditorMarkdownConfig: defineAsyncComponent({
    loader: () => import('./EditorMarkdownUserSettingsOverlay.vue'),
    loadingComponent: LoadingGeneric
  }),
  FileManager: defineAsyncComponent({
    loader: () => import('./FileManager.vue'),
    loadingComponent: LoadingGeneric
  }),
  NavEdit: defineAsyncComponent({
    loader: () => import('./NavEditOverlay.vue'),
    loadingComponent: LoadingGeneric
  }),
  PageHistory: defineAsyncComponent({
    loader: () => import('./PageHistoryOverlay.vue'),
    loadingComponent: LoadingGeneric
  }),
  Profile: defineAsyncComponent({
    loader: () => import('./ProfileOverlay.vue'),
    loadingComponent: LoadingGeneric
  }),
  TableEditor: defineAsyncComponent({
    loader: () => import('./TableEditorOverlay.vue'),
    loadingComponent: LoadingGeneric
  }),
  Welcome: defineAsyncComponent({
    loader: () => import('./WelcomeOverlay.vue'),
    loadingComponent: LoadingGeneric
  })
}

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// COMPUTED

/**
 * `overlays`' loaded child owns the only visible heading for this full-screen overlay (its own
 * `<w-header class="card-header">`), so the accessible name is looked up here rather than duplicated
 * as a prop threaded down -- each entry mirrors the exact translation key that child's own header
 * already renders (OpenProject #2356).
 */
const OVERLAY_TITLES = {
  BlockPicker: () => t('editor.blockPicker.title'),
  EditorMarkdownConfig: () => t('editor.settings.markdown'),
  FileManager: () => t('fileman.title'),
  NavEdit: () => t('navEdit.editMenuItems'),
  PageHistory: () => t('history.title'),
  Profile: () => t('profile.title'),
  TableEditor: () => t('editor.tableEditor.title'),
  Welcome: () => t('welcome.title')
}

const overlayAriaLabel = computed(() => OVERLAY_TITLES[siteStore.overlay]?.())
</script>
