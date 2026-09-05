<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`inbox.reviewDecline`)" @hide="onDialogHide">
    <w-card style="min-width: 450px">
      <w-card-section class="card-header">
        <w-icon name="tabler:x" size="sm" class="me-2" />
        <span>{{ t(`inbox.reviewDecline`) }}</span>
      </w-card-section>
      <!-- -> `pb-0`: the field below adds its own margin for the floating label, matching
           `PageReasonForChangeDialog.vue`'s spacing -->
      <w-card-section class="pb-0">
        <div class="text-body2">{{ t(`inbox.reviewDeclineConfirm`) }}</div>
      </w-card-section>
      <w-form class="pb-2" @submit="commit">
        <w-item>
          <w-item-section>
            <w-input
              ref="iptReason"
              v-model="state.reason"
              type="textarea"
              dense
              :rows="3"
              hide-bottom-space
              :label="t(`inbox.reviewDeclineReasonLabel`)" />
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
        <w-btn :label="t(`inbox.reviewDecline`)" color="negative" padding="xs md" @click="commit" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { reactive, ref } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'

/**
 * The decline confirmation, with an optional reason -- shown back to the suggestion's author once
 * this reviewer's decline lands (`models/approvals.ts#rejectSubmission`'s `resolvedReason`). Modeled
 * on `PageReasonForChangeDialog.vue`: same layout, same optional-textarea shape, but for decline
 * rather than a save.
 */

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptReason.value
})

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  reason: ''
})

// REFS

const iptReason = ref(null)

// METHODS

/** Trimmed and emptied to null rather than an empty string -- what the reject route's body expects. */
function commit() {
  onDialogOK({ reason: state.reason.trim() || null })
}
</script>
