<template>
  <w-dialog
    v-model="dialogVisible"
    persistent
    :aria-label="t(`profile.passkeysAdd`)"
    @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="cardinal:passkey" size="sm" class="me-2" />
        <span>{{ t(`profile.passkeysAdd`) }}</span>
      </w-card-section>
      <w-form ref="passkeyForm" class="py-2" @submit="save">
        <div class="text-body2 px-4 py-2">{{ t(`profile.passkeysNameHint`) }}</div>
        <w-item>
          <blueprint-icon icon="key" />
          <w-item-section>
            <w-input
              ref="iptName"
              v-model="state.name"
              dense
              :rules="nameValidation"
              hide-bottom-space
              :label="t(`profile.passkeysName`)"
              lazy-rules="ondemand"
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
        <w-btn :label="t(`common.actions.save`)" color="primary" padding="xs md" @click="save" />
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

// REFS

const iptName = ref(null)

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptName.value
})

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  name: ''
})

// REFS

const passkeyForm = ref(null)

// VALIDATION RULES

const nameValidation = [
  (val) => (val && val.trim().length > 0 && val.length <= 255) || t('profile.passkeysInvalidName')
]

// METHODS

async function save() {
  if (!(await passkeyForm.value.validate(true))) {
    return
  }
  onDialogOK({
    name: state.name
  })
}
</script>
