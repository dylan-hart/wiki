<template>
  <w-dialog
    v-model="siteStore.overlayIsShown"
    class="main-overlay"
    persistent
    full-width
    full-height
    :aria-label="overlayTitle">
    <component :is="overlays[siteStore.overlay]" />
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

/**
 * Each overlay names itself in its own header once mounted -- but the header lives inside the
 * async component this wraps, which isn't in the DOM yet the instant the dialog opens (and
 * `WDialog` names the dialog itself, not whatever slot content eventually renders inside it). This
 * mirrors, by key, the same i18n title each of `overlays` above shows in its own `w-header`.
 */
const overlayTitleKeys = {
  BlockPicker: 'editor.blockPicker.title',
  EditorMarkdownConfig: 'editor.settings.markdown',
  FileManager: 'fileman.title',
  NavEdit: 'navEdit.editMenuItems',
  PageHistory: 'history.title',
  TableEditor: 'editor.tableEditor.title',
  Welcome: 'welcome.title'
}

const overlayTitle = computed(() => {
  const key = overlayTitleKeys[siteStore.overlay]
  return key ? t(key) : null
})
</script>
