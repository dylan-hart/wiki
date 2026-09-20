<template>
  <w-dialog
    v-model="dialogVisible"
    max-width="450px"
    :aria-label="t(`admin.sites.delete`)"
    @hide="onDialogHide">
    <w-card style="min-width: 350px">
      <w-card-section class="card-header">
        <w-icon name="tabler:trash" size="sm" class="me-2" />
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

const props = defineProps({
  site: {
    type: Object,
    required: true
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const adminStore = useAdminStore()

const { t } = useI18n()

const state = reactive({
  isLoading: false,
  confirmText: ''
})

const isConfirmed = computed(() => state.confirmText === props.site.title)

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
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}
</script>
