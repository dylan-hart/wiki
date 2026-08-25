<template>
  <w-dialog v-model="dialogVisible" persistent @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-add-key.svg" size="sm" class="mr-2" />
        <span>{{ t(`profile.passkeysAdd`) }}</span>
      </w-card-section>
      <w-form ref="passkeyCreateForm" class="py-2">
        <div class="text-body2 px-4 py-2">{{ t(`profile.passkeysNameHint`) }}</div>
        <w-item>
          <blueprint-icon icon="key" />
          <w-item-section>
            <w-input
              v-model="state.name"
              outlined
              dense
              :rules="nameValidation"
              hide-bottom-space
              :label="t(`profile.passkeysName`)"
              lazy-rules="ondemand"
              autofocus
              @keyup:enter="save" />
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
          unelevated
          :label="t(`common.actions.save`)"
          color="primary"
          padding="xs md"
          @click="save" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { reactive, ref } from 'vue'

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  name: ''
})

// REFS

const passkeyCreateForm = ref(null)

// VALIDATION RULES

const nameValidation = [
  (val) => (!!val && val.trim().length > 0 && val.length <= 255) || t('profile.passkeysInvalidName')
]

// METHODS

async function save() {
  const isFormValid = await passkeyCreateForm.value?.validate()
  if (!isFormValid) {
    return
  }
  onDialogOK({
    name: state.name
  })
}
</script>
