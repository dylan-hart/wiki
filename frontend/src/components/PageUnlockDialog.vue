<template>
  <w-dialog v-model="dialogVisible" :aria-label="t('common.page.unlockTitle')" @hide="onDialogHide">
    <w-card style="width: 450px; max-width: 90vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:lock" size="sm" class="me-2" />
        <span>{{ t('common.page.unlockTitle') }}</span>
      </w-card-section>
      <w-form ref="unlockForm" class="py-2" @submit="unlock">
        <w-item>
          <blueprint-icon icon="tabler:key" />
          <w-item-section>
            <w-input
              ref="iptPassword"
              v-model="state.password"
              dense
              type="password"
              autocomplete="current-password"
              revealable
              hide-bottom-space
              :label="t(`auth.fields.password`)"
              :rules="passwordValidation"
              lazy-rules="ondemand" />
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
          icon="tabler:lock-open"
          :label="t(`common.page.unlock`)"
          color="primary"
          padding="xs md"
          :loading="state.isLoading"
          @click="unlock" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'

import { usePageStore } from '@/stores/page'

import { apiErrorMessage } from '@/helpers/apiError'

/**
 * `ok` resolves only once the server has accepted the password and the page store holds the content,
 * so whoever opened this can take it to mean the page is readable.
 */

defineEmits([...dialogComponentEmits])

const iptPassword = ref(null)
const unlockForm = ref(null)

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptPassword.value
})

const pageStore = usePageStore()

const { t } = useI18n()

const state = reactive({
  password: '',
  isLoading: false
})

const passwordValidation = [(val) => val.length > 0 || t('auth.errors.missingPassword')]

async function unlock() {
  state.isLoading = true
  try {
    if (!(await unlockForm.value.validate(true))) {
      throw new Error(t('auth.errors.missingPassword'))
    }
    await pageStore.pageUnlock(state.password)
    onDialogOK()
  } catch (err) {
    notify({
      type: 'negative',
      // -> A rejected password is the expected outcome here, not a failure to report as one
      message:
        err.response?.status === 401 ? t('common.page.lockedWrongPassword') : apiErrorMessage(err)
    })
    state.password = ''
    iptPassword.value?.focus()
  }
  state.isLoading = false
}
</script>
