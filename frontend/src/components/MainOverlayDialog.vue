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
 * full-screen panel for either dwarfed its own content (OpenProject #2543 follow-up feedback). Half
 * the viewport instead, exactly as the design draws it
 * (`ui-redesign/Cardinal Wiki - Inbox 3x.dc.html`: `50vw`/`50vh` with a `min(560px, 100%)` /
 * `420px` floor, and no ceiling above it -- a `clamp()` capped both at a size the design does not).
 * The floor is in `MainLayout.vue`'s `.main-overlay.is-half-sized` rule, since it belongs on the
 * panel rather than on the dialog's own box. Every other entry keeps the full-screen treatment it
 * needs for its own content (a tree, a table, a block gallery).
 */
const HALF_SIZE = {
  width: '50vw',
  height: '50vh'
}
const isHalfSized = computed(() => siteStore.overlay === 'Profile' || siteStore.overlay === 'Inbox')

/**
 * Profile, Inbox, FileManager and PageHistory are all "browse/manage, then leave" surfaces with no
 * risk of losing unsaved work mid-action (a settings save, an inbox item, a file op each commit
 * immediately; page history is read-only browsing -- compare two versions, choose a rollback) -- a
 * stray click on the blurred rest of the app, or an Escape, dismisses them the way a reader would
 * expect from any ordinary modal. PageHistory joined them in OpenProject #2638: it was persistent
 * only by omission from this set, which left its Close button the single way out of a dialog that
 * discards nothing when it closes.
 *
 * The remaining entries (BlockPicker, NavEdit, TableEditor, Welcome) can sit mid-edit with real
 * state to lose (a half-built block insert, an in-progress nav/table edit, the first-run
 * create-home-page flow), and each stays persistent for that reason rather than by inheritance.
 *
 * A destructive confirmation opened ON TOP of a dismissible overlay -- PageHistory's rollback
 * confirm is the one that matters -- still swallows the first Escape by itself: dismissal is routed
 * through `composables/escapeStack.js`, a LIFO stack, so the confirm (pushed later) is the only
 * handler that keypress reaches, and the overlay underneath needs a second Escape.
 */
const DISMISSIBLE_OVERLAYS = new Set(['Profile', 'Inbox', 'FileManager', 'PageHistory'])
const isDismissible = computed(() => DISMISSIBLE_OVERLAYS.has(siteStore.overlay))

/**
 * `siteStore.overlayIsShown` is a getter derived from `siteStore.overlay` (a Pinia getter has no
 * setter), so a plain `v-model` on `<w-dialog>` -- which assigns to it directly -- silently failed
 * a Vue `readonly` warning and never actually closed anything. Latent until now: every entry was
 * `persistent`, so `WDialog` never had a reason to emit `update:model-value` at all. Now that every
 * entry in `DISMISSIBLE_OVERLAYS` above dismisses via backdrop click or Escape, this is reachable,
 * and closing needs the same `overlay: ''` `$patch` every overlay's own Close button already uses.
 */
function onDialogModelUpdate(value) {
  if (!value) {
    siteStore.$patch({ overlay: '' })
  }
}
</script>
