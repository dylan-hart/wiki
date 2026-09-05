<template>
  <w-dialog
    v-model="dialogVisible"
    :aria-label="t(`admin.users.changePassword`)"
    @hide="onDialogHide">
    <w-card style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="tabler:lock-cog" size="sm" class="me-2" />
        <span>{{ t(`admin.users.changePassword`) }}</span>
      </w-card-section>
      <w-form ref="changeUserPwdForm" class="py-2" @submit="save">
        <w-item>
          <blueprint-icon icon="tabler:lock" />
          <w-item-section>
            <w-input
              ref="currentPasswordIpt"
              v-model="state.currentPassword"
              dense
              type="password"
              autocomplete="current-password"
              :rules="currentPasswordValidation"
              hide-bottom-space
              :label="t(`auth.changePwd.currentPassword`)"
              lazy-rules="ondemand" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="tabler:password" />
          <w-item-section>
            <w-input
              ref="newPasswordIpt"
              v-model="state.newPassword"
              dense
              type="password"
              autocomplete="new-password"
              revealable
              :rules="newPasswordValidation"
              hide-bottom-space
              :label="t(`auth.changePwd.newPassword`)"
              lazy-rules="ondemand">
              <template #append>
                <div class="flex flex-nowrap items-center">
                  <w-badge :color="passwordStrength.color" :label="passwordStrength.label" />
                  <w-separator vertical class="mx-2 self-stretch" />
                  <w-btn flat dense padding="none xs" color="brown" @click="randomizePassword">
                    <w-icon name="tabler:cube" />
                    <div class="ps-1 text-caption"><strong>Generate</strong></div>
                  </w-btn>
                </div>
              </template>
            </w-input>
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="tabler:lock-check" />
          <w-item-section>
            <w-input
              v-model="state.verifyPassword"
              dense
              type="password"
              autocomplete="new-password"
              :rules="verifyPasswordValidation"
              hide-bottom-space
              :label="t(`auth.changePwd.newPasswordVerify`)"
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
          :label="t(`common.actions.update`)"
          color="primary"
          padding="xs md"
          :loading="state.isLoading"
          @click="save" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { passwordStrengthBadge } from '@/helpers/passwordStrength'
import { localizeError } from '@/helpers/localization'
import { PASSWORD_CHARSET, randomPassword } from '@/helpers/randomPassword'
import { computed, reactive, ref } from 'vue'

// PROPS

const props = defineProps({
  strategyId: {
    type: String,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => currentPasswordIpt.value
})

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  currentPassword: '',
  newPassword: '',
  verifyPassword: '',
  isLoading: false
})

// REFS

const changeUserPwdForm = ref(null)
const currentPasswordIpt = ref(null)
const newPasswordIpt = ref(null)

// COMPUTED

const passwordStrength = computed(() => passwordStrengthBadge(state.newPassword, t))

// VALIDATION RULES

const currentPasswordValidation = [(val) => val.length > 0 || t('auth.errors.missingPassword')]
const newPasswordValidation = [
  (val) => val.length > 0 || t('auth.errors.missingPassword'),
  (val) => val.length >= 8 || t('auth.errors.passwordTooShort')
]
const verifyPasswordValidation = [
  (val) => val.length > 0 || t('auth.errors.missingVerifyPassword'),
  (val) => val === state.newPassword || t('auth.errors.passwordsNotMatch')
]

// METHODS

function randomizePassword() {
  state.newPassword = randomPassword(16, PASSWORD_CHARSET)
  // -> A password the user never typed has to be readable, or there is no way to record it anywhere
  newPasswordIpt.value.reveal()
}

async function save() {
  state.isLoading = true
  try {
    const isFormValid = await changeUserPwdForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('auth.errors.fields'))
    }
    await API_CLIENT.put('users/profile/password', {
      json: {
        strategyId: props.strategyId,
        currentPassword: state.currentPassword,
        newPassword: state.newPassword
      }
    }).json()
    notify({
      type: 'positive',
      message: t('auth.changePwd.success')
    })
    onDialogOK()
  } catch (err) {
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  }
  state.isLoading = false
}
</script>
