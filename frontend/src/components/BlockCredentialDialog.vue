<template>
  <w-dialog v-model="dialogVisible" @hide="onDialogHide">
    <w-card style="width: 450px; max-width: 90vw">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-key-2.svg" size="sm" class="mr-2" />
        <span>{{
          isRotate ? t('admin.blocks.credentialRotate') : t('admin.blocks.credentialAdd')
        }}</span>
      </w-card-section>
      <w-card-section>
        <p class="text-body2 text-grey">
          {{
            isRotate
              ? t('admin.blocks.credentialRotateSubtitle', { name: props.credential?.name ?? '' })
              : t('admin.blocks.credentialAddSubtitle')
          }}
        </p>
        <w-input
          v-if="!isRotate"
          outlined
          v-model="state.name"
          :label="t('admin.blocks.credentialName')"
          :hint="t('admin.blocks.credentialNameHint')"
          autofocus
          class="mb-2" />
        <w-input
          outlined
          v-model="state.secret"
          type="password"
          :autofocus="isRotate"
          :label="t('admin.blocks.credentialSecret')"
          :hint="t('admin.blocks.credentialSecretHint')" />
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
          :label="isRotate ? t('admin.blocks.credentialRotate') : t('admin.blocks.credentialAdd')"
          color="primary"
          padding="xs md"
          :loading="state.isLoading"
          :disabled="(!isRotate && !state.name.trim()) || !state.secret.trim()"
          @click="submit" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, reactive } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { useAdminStore } from '@/stores/admin'
import { apiErrorMessage } from '@/helpers/apiError'

// PROPS

const props = defineProps({
  mode: {
    type: String,
    required: true,
    validator: (value) => ['create', 'rotate'].includes(value)
  },
  /** Required for mode `rotate`: the credential row (id, name) being rotated. */
  credential: {
    type: Object,
    default: null
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

const isRotate = computed(() => props.mode === 'rotate')

const state = reactive({
  name: '',
  secret: '',
  isLoading: false
})

// METHODS

async function submit() {
  state.isLoading = true
  try {
    if (isRotate.value) {
      const resp = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/block-credentials/${props.credential.id}/rotate`,
        { json: { secret: state.secret } }
      ).json()
      if (!resp?.ok) {
        throw new Error(resp?.message || 'An unexpected error occured.')
      }
      notify({ type: 'positive', message: t('admin.blocks.credentialRotateSuccess') })
      onDialogOK()
    } else {
      const credential = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/block-credentials`,
        {
          json: { name: state.name.trim(), secret: state.secret }
        }
      ).json()
      notify({ type: 'positive', message: t('admin.blocks.credentialCreateSuccess') })
      onDialogOK(credential)
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: isRotate.value
        ? t('admin.blocks.credentialRotateFailed')
        : t('admin.blocks.credentialCreateFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}
</script>
