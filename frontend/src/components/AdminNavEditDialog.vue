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
 * The admin-launched menu editor: no page and no mode, just a menu whose id the caller already
 * knows, so it saves straight to `navId` rather than through `NavEditOverlay.vue`'s page-context
 * save.
 */

const pageStore = usePageStore()
const siteStore = useSiteStore()

const props = defineProps({
  siteId: {
    type: String,
    required: true
  },
  navId: {
    type: String,
    required: true
  },
  title: {
    type: String,
    default: ''
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const { t } = useI18n()

const state = reactive({
  saving: 0,
  editorLoading: false
})

const editorRef = ref(null)

const isBusy = computed(() => state.saving > 0 || state.editorLoading)

/**
 * With no page context, neither the save nor `nav-item-editor`'s "Copy from..." can tell whether the
 * reader-facing sidebar shows the menu it just changed. `props.siteId` (from
 * `adminStore.currentSiteId`) can differ from the site loaded in this tab, hence the guard; and
 * refetching whatever menu the tab's current page shows rather than `props.navId` covers both cases
 * -- a harmless no-op when the two differ.
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
    // -> `reconstructMenuItems()` throws a plain error code rather than a translated string, so it
    //    stays testable with no i18n context; translation happens here, at the display boundary.
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
