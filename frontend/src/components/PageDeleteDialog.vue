<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="850px"
    :aria-label="t(`pageDeleteDialog.title`)"
    @hide="onDialogHide">
    <w-card style="min-width: 550px">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-delete-bin.svg" size="sm" class="me-2" />
        <span>{{ t(`pageDeleteDialog.title`) }}</span>
      </w-card-section>
      <w-card-section>
        <div class="text-body2">
          <i18n-t keypath="pageDeleteDialog.confirm">
            <template #name>
              <strong>{{ pageName }}</strong>
            </template>
          </i18n-t>
        </div>
        <div class="text-caption text-grey mt-2">
          {{ t('pageDeleteDialog.pageId', { id: pageId }) }}
        </div>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          unelevated
          :label="t(`common.actions.delete`)"
          color="negative"
          padding="xs md"
          :loading="state.isLoading"
          @click="confirm" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { reactive } from 'vue'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'

// PROPS

const props = defineProps({
  pageId: {
    type: String,
    required: true
  },
  pageName: {
    type: String,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  isLoading: false
})

// METHODS

async function confirm() {
  state.isLoading = true
  try {
    await API_CLIENT.delete(`sites/${siteStore.id}/pages/${props.pageId}`)
    notify({
      type: 'positive',
      message: t('pageDeleteDialog.deleteSuccess')
    })
    /*
      OpenProject #1012: a deleted page drops out of whatever `auto`/`mixed` menu generated from it,
      and `models/tree.ts`/`models/pages.ts` also clean up any per-page nav override the deleted
      entry itself held (`navigation.deleteNavForEntries`) -- neither is visible to an already-open
      tab without this. Both callers of this dialog (`PageActionsCol.vue`, `FileManager.vue`)
      navigate or reload their own view in their own `onOk`, after this promise resolves, so
      `pageStore.navigationId` here is still whatever it was going into the delete -- correct to
      force-refetch before that follow-up settles, since it is exactly what the sidebar is showing
      right now and needs told the deleted entry is gone.
    */
    await siteStore.fetchNavigation(pageStore.navigationId, true)
    onDialogOK()
  } catch (err) {
    // -> ky throws above 400 — a page deleted from another tab answers 404
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}
</script>
