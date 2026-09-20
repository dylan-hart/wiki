<template>
  <w-dialog
    v-model="dialogVisible"
    persistent
    :aria-label="t(`profile.tfaRecoveryCodes`)"
    @hide="onDialogHide">
    <w-card style="min-width: 450px">
      <w-card-section class="card-header">
        <w-icon name="tabler:list-numbers" size="sm" class="me-2" />
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
 * The initial-setup equivalent of this screen lives inline in `SetupTfaDialog.vue` instead: that
 * flow already owns a dialog, and swapping its content mid-flow reads better than stacking a second
 * dialog on top of it.
 */

const props = defineProps({
  codes: {
    type: Array,
    required: true
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK } = useDialogComponent()

const { t } = useI18n()

const state = reactive({
  acknowledged: false
})

/**
 * These codes are shown exactly once, so closing before copying or downloading them throws them
 * away for good -- confirm rather than close silently.
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
