<template>
  <w-dialog
    v-model="dialogVisible"
    full-width
    full-height
    persistent
    :aria-label="title || t(`navEdit.editMenuItems`)"
    @hide="onDialogHide">
    <w-layout container>
      <w-header class="card-header">
        <w-icon name="tabler:layout-sidebar" left size="md" />
        <span>{{ title || t(`navEdit.editMenuItems`) }}</span>
        <w-space />
        <transition name="syncing">
          <w-spinner class="me-2" v-show="isBusy" color="accent" size="24px" />
        </transition>
        <w-btn-group>
          <w-btn
            color="white"
            text-color="grey-7"
            :label="t(`common.actions.cancel`)"
            :aria-label="t(`common.actions.cancel`)"
            icon="tabler:x"
            @click="onDialogCancel" />
          <w-btn
            color="positive"
            text-color="white"
            :label="t(`common.actions.save`)"
            :aria-label="t(`common.actions.save`)"
            icon="tabler:check"
            :disabled="isBusy"
            @click="save" />
        </w-btn-group>
      </w-header>
      <nav-item-editor
        ref="editorRef"
        :site-id="siteId"
        :nav-id="navId"
        @load-error="onDialogCancel"
        @update:loading="state.editorLoading = $event"
        @copied="onCopied" />
    </w-layout>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, reactive, ref } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { apiErrorMessage } from '@/helpers/apiError'
import NavItemEditor from '@/components/NavItemEditor.vue'

/**
 * The admin-launched navigation menu editor: `NavItemEditor` driven from a `dialog()`-opened
 * full-screen panel rather than from a live page, for `AdminNavigation.vue`'s two entry points --
 * the site-wide default menu, and an override found in its list.
 *
 * Saves straight to the resolved `navId` (`PUT /sites/:siteId/navigation/:navId`), unlike
 * `NavEditOverlay.vue`'s page-context save: there is no page and no mode here, just a menu whose id
 * the caller already knows.
 */

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// PROPS

const props = defineProps({
  siteId: {
    type: String,
    required: true
  },
  navId: {
    type: String,
    required: true
  },
  /** Shown in the header in place of the generic "Edit Menu Items" title. */
  title: {
    type: String,
    default: ''
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  saving: 0,
  /** Mirrors `NavItemEditor`'s own `loading` via `@update:loading`. */
  editorLoading: false
})

const editorRef = ref(null)

// COMPUTED

const isBusy = computed(() => state.saving > 0 || state.editorLoading)

// METHODS

/**
 * Neither this dialog's own save nor `nav-item-editor`'s "Copy from..." action (`@copied`, below)
 * has any page context of its own to know whether the reader-facing sidebar (`NavSidebar.vue`, keyed
 * off `siteStore.nav`/`pageStore.navigationId`) needs to see the change -- unlike
 * `NavEditOverlay.vue`'s page-context save, which always knows exactly which menu it just changed
 * (OpenProject #1012). `adminStore.currentSiteId` (what `props.siteId` resolves from) can differ
 * from `siteStore.id`, the site actually loaded in this browser tab, so this only forces a refetch
 * when they match; refetching `pageStore.navigationId` (whatever menu the tab's current page
 * actually shows) rather than `props.navId` covers it either way -- a no-op re-fetch of unrelated,
 * still-correct data when the two differ, and the fix itself when they don't.
 */
async function invalidateSidebarNav() {
  if (props.siteId === siteStore.id) {
    await siteStore.fetchNavigation(pageStore.navigationId, true)
  }
}

async function onCopied() {
  await invalidateSidebarNav()
}

async function save() {
  state.saving++
  loading.show()
  try {
    const items = editorRef.value.buildSaveItems()
    await API_CLIENT.put(`sites/${props.siteId}/navigation/${props.navId}`, {
      json: { items }
    }).json()
    notify({
      type: 'positive',
      message: t('navEdit.saveSuccess')
    })
    await invalidateSidebarNav()
    onDialogOK()
  } catch (err) {
    // -> `reconstructMenuItems()` (`helpers/navigation.js`) throws a plain error code, not a
    //    translated string, so it stays testable with no i18n context -- translate its one thrown
    //    code here, at the display boundary, same as every other message shown to the user.
    const isNestedLinkError = err.message === 'ERR_NESTED_LINK_WITHOUT_PARENT'
    notify({
      type: 'negative',
      message: isNestedLinkError
        ? t('navEdit.nestedItemWithoutParent')
        : apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  loading.hide()
  state.saving--
}
</script>
