<template>
  <w-dialog
    v-model="dialogVisible"
    persistent
    :aria-label="t(`profile.tfaRecoveryCodes`)"
    @hide="onDialogHide">
    <w-card style="min-width: 450px">
      <w-card-section class="card-header">
        <w-icon name="cardinal:recovery-codes" size="sm" class="me-2" />
        <span>{{ t(`profile.tfaRecoveryCodes`) }}</span>
      </w-card-section>
      <w-card-section class="text-center">
        <recovery-codes-display v-model:acknowledged="state.acknowledged" :codes="props.codes" />
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          :label="t(`common.actions.close`)"
          color="primary"
          padding="xs md"
          @click="attemptClose" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { reactive } from 'vue'

import { confirm, dialogComponentEmits, useDialogComponent } from '@/composables/dialog'

import RecoveryCodesDisplay from '@/components/RecoveryCodesDisplay.vue'

/**
 * Shows a freshly-regenerated set of recovery codes -- opened from `ProfileAuth.vue` after
 * `POST /profile/tfa/recovery-codes` succeeds. The initial-setup equivalent of this screen lives
 * inline in `SetupTfaDialog.vue` instead of here, since that flow already owns a dialog of its own
 * and swapping its content mid-flow reads better than stacking a second dialog on top of it.
 */

// PROPS

const props = defineProps({
  codes: {
    type: Array,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK } = useDialogComponent()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  acknowledged: false
})

// METHODS

/**
 * These codes are shown exactly once -- closing without having copied or downloaded them throws
 * them away for good, so a close attempt before either happened is confirmed rather than silent.
 */
function attemptClose() {
  if (state.acknowledged) {
    onDialogOK()
    return
  }
  confirm({
    title: t('common.actions.confirm'),
    message: t('profile.tfaRecoveryCodesCloseWarn'),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.close')
  }).onOk(() => {
    onDialogOK()
  })
}
</script>
