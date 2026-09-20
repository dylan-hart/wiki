<template>
  <w-dialog
    :model-value="siteStore.overlayIsShown"
    class="main-overlay"
    :class="{ 'is-half-sized': isHalfSized }"
    :persistent="!isDismissible"
    :full-width="!isHalfSized"
    :full-height="!isHalfSized"
    :width="isHalfSized ? HALF_SIZE.width : null"
    :height="isHalfSized ? HALF_SIZE.height : null"
    :aria-label="overlayAriaLabel"
    @update:model-value="onDialogModelUpdate">
    <!--
      Every entry in `overlays` declares `overlay-opts`, even the ones that don't read it: an
      undeclared prop falls through to the child's DOM root as an attribute instead.
    -->
    <component :is="overlays[siteStore.overlay]" :overlay-opts="siteStore.overlayOpts" />
  </w-dialog>
</template>

<script setup>
import { computed, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'

import { pendingProfileSaves } from '../composables/profileSaving'
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
  Inbox: defineAsyncComponent({
    loader: () => import('./InboxOverlay.vue'),
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

const siteStore = useSiteStore()

const { t } = useI18n()

/**
 * The loaded child owns the only visible heading, so the dialog's accessible name is looked up here
 * rather than threaded down as a prop. Each entry must mirror the exact translation key that child's
 * own header renders; a missing key leaves that screen's dialog unnamed, with no visible symptom.
 */
const OVERLAY_TITLES = {
  BlockPicker: () => t('editor.blockPicker.title'),
  EditorMarkdownConfig: () => t('editor.settings.markdown'),
  FileManager: () => t('fileman.title'),
  Inbox: () => t('inbox.title'),
  NavEdit: () => t('navEdit.editMenuItems'),
  PageHistory: () => t('history.title'),
  Profile: () => t('profile.title'),
  TableEditor: () => t('editor.tableEditor.title'),
  Welcome: () => t('welcome.title')
}

const overlayAriaLabel = computed(() => OVERLAY_TITLES[siteStore.overlay]?.())

/**
 * Profile and Inbox are short, focused forms/lists, not a file browser or a block gallery -- a
 * full-screen panel for either dwarfs its own content. There is no ceiling above these, and the
 * floor lives in `css/_overlay-dialog.css`'s `.is-half-sized` rule, since it belongs on the panel
 * rather than on the dialog's own box.
 */
const HALF_SIZE = {
  width: '50vw',
  height: '50vh'
}
const isHalfSized = computed(() => siteStore.overlay === 'Profile' || siteStore.overlay === 'Inbox')

/**
 * These four are "browse/manage, then leave" surfaces with no risk of losing unsaved work mid-action
 * (a settings save, an inbox item, a file op each commit immediately; page history is read-only), so
 * a stray backdrop click or Escape dismisses them like any ordinary modal. Every other entry can sit
 * mid-edit with real state to lose and stays persistent for that reason, not by inheritance.
 *
 * A destructive confirmation opened ON TOP of a dismissible overlay still swallows the first Escape
 * by itself: dismissal routes through `composables/escapeStack.js`, a LIFO stack, so the confirm
 * (pushed later) is the only handler that keypress reaches.
 */
const DISMISSIBLE_OVERLAYS = new Set(['Profile', 'Inbox', 'FileManager', 'PageHistory'])
const isDismissible = computed(() => DISMISSIBLE_OVERLAYS.has(siteStore.overlay))

/**
 * `siteStore.overlayIsShown` is a Pinia getter and has no setter, so a plain two-way binding on
 * `<w-dialog>` would assign to it directly, draw a Vue `readonly` warning and close nothing. Closing
 * goes through the same `overlay: ''` `$patch` every overlay's own Close button uses.
 *
 * Profile refuses that patch while a section save is still in flight (`pendingProfileSaves`, the
 * module singleton `ProfileOverlay.vue`'s close button also reads). Refusing here rather than
 * flipping `persistent` keeps every other dismissible overlay untouched: WDialog still emits
 * `update:model-value(false)`, but `overlayIsShown` never changes, so the dialog stays open.
 */
function onDialogModelUpdate(value) {
  if (!value) {
    if (siteStore.overlay === 'Profile' && pendingProfileSaves.value > 0) {
      return
    }
    siteStore.$patch({ overlay: '' })
  }
}
</script>
