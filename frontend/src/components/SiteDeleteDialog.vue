<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="450px"
    :aria-label="t(`admin.sites.delete`)"
    @hide="onDialogHide">
    <w-card style="min-width: 350px">
      <w-card-section class="card-header">
        <w-icon name="cardinal:pages-deleted" size="sm" class="me-2" />
        <span>{{ t(`admin.sites.delete`) }}</span>
      </w-card-section>
      <w-card-section>
        <div class="text-body2">
          <i18n-t keypath="admin.sites.deleteConfirm">
            <template #siteTitle>
              <strong>{{ props.site.title }}</strong>
            </template>
          </i18n-t>
        </div>
        <div class="text-body2 mt-4">
          <strong class="text-negative">{{ t(`admin.sites.deleteConfirmWarn`) }}</strong>
        </div>
        <w-input
          v-model="state.confirmText"
          class="mt-4"
          dense
          :label="t(`admin.sites.deleteConfirmType`, { siteTitle: props.site.title })" />
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
          :disabled="!isConfirmed"
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
import { apiErrorMessage } from '@/helpers/apiError'
import { computed, reactive } from 'vue'

import { useAdminStore } from '../stores/admin'

// PROPS

const props = defineProps({
  site: {
    type: Object,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// STORES

const adminStore = useAdminStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  isLoading: false,
  confirmText: ''
})

// COMPUTED

const isConfirmed = computed(() => state.confirmText === props.site.title)

// METHODS

async function confirm() {
  if (!isConfirmed.value) {
    return
  }
  state.isLoading = true
  try {
    await API_CLIENT.delete(`sites/${props.site.id}`)
    notify({
      type: 'positive',
      message: t('admin.sites.deleteSuccess')
    })
    adminStore.$patch({
      sites: adminStore.sites.filter((s) => s.id !== props.site.id)
    })
    onDialogOK()
  } catch (err) {
    // -> ky throws for statuses above 400 (e.g. 409 for the "last site" or "still holds content"
    //    guards), where the reason the API gave is in the response body rather than in the error
    //    message
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}
</script>
