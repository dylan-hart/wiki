<template>
  <w-dialog v-model="dialogVisible" persistent @hide="onDialogHide">
    <w-card style="min-width: 450px">
      <w-card-section class="card-header">
        <w-icon name="mdi:source-branch-sync" size="sm" class="mr-2" />
        <span>{{ t(`editor.collab.saveConflict.title`) }}</span>
      </w-card-section>
      <w-card-section class="pb-0">
        <div class="text-body2">
          {{ t(`editor.collab.saveConflict.message`, { authorName: props.authorName }) }}
        </div>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`editor.collab.saveConflict.discard`)"
          color="grey"
          padding="xs md"
          @click="onDialogOK('discard')" />
        <w-btn
          unelevated
          :label="t(`editor.collab.saveConflict.saveAnyway`)"
          color="primary"
          padding="xs md"
          @click="onDialogOK('overwrite')" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'

// PROPS

const props = defineProps({
  /** Whoever saved the newer version the server now has, for the dialog message. */
  authorName: {
    type: String,
    required: false,
    default: ''
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK } = useDialogComponent()

// I18N

const { t } = useI18n()
</script>
