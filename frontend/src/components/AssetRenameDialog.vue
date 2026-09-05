<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`fileman.assetRename`)" @hide="onDialogHide">
    <w-card class="relative" style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="cardinal:rename" size="sm" class="me-2" />
        <span>{{ t(`fileman.assetRename`) }}</span>
      </w-card-section>
      <w-form ref="renameAssetForm" class="py-2" @submit="rename">
        <w-item>
          <blueprint-icon icon="image" class="self-start" />
          <w-item-section>
            <w-input
              ref="iptPath"
              v-model="state.path"
              dense
              :rules="nameValidation"
              hide-bottom-space
              :label="t(`fileman.assetFileName`)"
              :hint="t(`fileman.assetFileNameHint`)"
              lazy-rules="ondemand"
              @keyup:enter="rename" />
          </w-item-section>
        </w-item>
      </w-form>
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
          :label="t(`common.actions.rename`)"
          color="primary"
          padding="xs md"
          :loading="state.loading > 0"
          @click="rename" />
      </w-card-actions>
      <w-inner-loading :showing="state.loading > 0" size="38px" spinner-class="text-accent" />
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { onMounted, reactive, ref } from 'vue'

import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'

// PROPS

const props = defineProps({
  assetId: {
    type: String,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// REFS

const iptPath = ref(null)

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptPath.value
})

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  path: '',
  loading: false
})

// REFS

const renameAssetForm = ref(null)

// VALIDATION RULES

const nameValidation = [
  (val) => (val?.length >= 2 && val?.includes('.')) || t('fileman.renameAssetInvalid')
]

// METHODS

async function rename() {
  const isFormValid = await renameAssetForm.value.validate(true)
  if (!isFormValid) {
    return
  }
  state.loading++
  try {
    await API_CLIENT.patch(`sites/${siteStore.id}/assets/${props.assetId}`, {
      json: {
        fileName: state.path
      }
    }).json()
    notify({
      type: 'positive',
      message: t('fileman.renameAssetSuccess')
    })
    onDialogOK()
  } catch (err) {
    // -> ky throws above 400 — a name already taken in this folder answers 409
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.loading--
}

// MOUNTED

onMounted(async () => {
  state.loading++
  try {
    const asset = await API_CLIENT.get(`sites/${siteStore.id}/assets/${props.assetId}`).json()
    if (asset?.id !== props.assetId) {
      throw new Error(t('fileman.fetchAssetDataFailed'))
    }
    state.path = asset.fileName
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
    onDialogCancel()
  }
  state.loading--
})
</script>
