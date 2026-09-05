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
          <blueprint-icon icon="password" />
          <w-item-section>
            <w-input
              ref="iptPassword"
              v-model="state.userPassword"
              dense
              :rules="userPasswordValidation"
              hide-bottom-space
              :label="t(`admin.users.password`)"
              lazy-rules="ondemand">
              <template #append>
                <div class="flex flex-nowrap items-center">
                  <w-badge :color="passwordStrength.color" :label="passwordStrength.label" />
                  <w-separator vertical class="mx-2 self-stretch" />
                  <w-btn flat dense padding="none xs" color="brown" @click="randomizePassword">
                    <w-icon name="la:dice-d6" />
                    <div class="ps-1 text-caption"><strong>Generate</strong></div>
                  </w-btn>
                </div>
              </template>
            </w-input>
          </w-item-section>
        </w-item>
        <!--
          The whole row is the toggle's hit area, as it was when this was a <label>-tagged item.
          `@click.stop` on the toggle keeps a direct hit on the switch from also firing the row
          handler and cancelling itself out.
        -->
        <w-item clickable @click="state.userMustChangePassword = !state.userMustChangePassword">
          <blueprint-icon icon="password-reset" />
          <w-item-section>
            <w-item-label>{{ t(`admin.users.mustChangePwd`) }}</w-item-label>
            <w-item-label caption>{{ t(`admin.users.mustChangePwdHint`) }}</w-item-label>
          </w-item-section>
          <w-item-section avatar>
            <w-toggle
              v-model="state.userMustChangePassword"
              :aria-label="t(`admin.users.mustChangePwd`)"
              @click.stop />
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
import { PASSWORD_CHARSET, randomPassword } from '@/helpers/randomPassword'
import { computed, reactive, ref } from 'vue'

// PROPS

const props = defineProps({
  userId: {
    type: String,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptPassword.value
})

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  userPassword: '',
  userMustChangePassword: false,
  isLoading: false
})

// REFS

const changeUserPwdForm = ref(null)
const iptPassword = ref(null)

// COMPUTED

const passwordStrength = computed(() => passwordStrengthBadge(state.userPassword, t))

// VALIDATION RULES

const userPasswordValidation = [
  (val) => val.length > 0 || t('admin.users.passwordMissing'),
  (val) => val.length >= 8 || t('admin.users.passwordTooShort')
]

// METHODS

function randomizePassword() {
  state.userPassword = randomPassword(16, PASSWORD_CHARSET)
}

async function save() {
  state.isLoading = true
  try {
    const isFormValid = await changeUserPwdForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('admin.users.createInvalidData'))
    }
    await API_CLIENT.put(`users/${props.userId}/password`, {
      json: {
        newPassword: state.userPassword,
        mustChangePassword: state.userMustChangePassword
      }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.users.changePasswordSuccess')
    })
    onDialogOK({
      mustChangePassword: state.userMustChangePassword
    })
  } catch (err) {
    // -> ky throws above 400 with the reason in the body, which is where the server explains itself;
    //    some error codes have a nicer translation under `admin.users.*`
    notify({
      type: 'negative',
      message: t(
        `admin.users.${err.data?.error}`,
        apiErrorMessage(err, t('common.error.unexpected'))
      )
    })
  }
  state.isLoading = false
}
</script>
