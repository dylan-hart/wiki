<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="850px"
    :aria-label="t(`pageDeleteDialog.title`)"
    @hide="onDialogHide">
    <w-card style="min-width: 550px">
      <w-card-section class="card-header">
        <w-icon name="tabler:trash" size="sm" class="me-2" />
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

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  isLoading: false
})

async function confirm() {
  state.isLoading = true
  try {
    await API_CLIENT.delete(`sites/${siteStore.id}/pages/${props.pageId}`)
    notify({
      type: 'positive',
      message: t('pageDeleteDialog.deleteSuccess')
    })
    /*
      Forced past the cache: a deleted page drops out of any `auto`/`mixed` menu generated from it,
      and its per-page nav override is cleaned up server-side, neither of which an already-open tab
      can see. Callers navigate in their own `onOk`, after this resolves, so `navigationId` is still
      the menu the sidebar is showing right now.
    */
    await siteStore.fetchNavigation(pageStore.navigationId, true)
    onDialogOK()
  } catch (err) {
    // -> A page already deleted from another tab answers 404, which ky throws
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}
</script>
