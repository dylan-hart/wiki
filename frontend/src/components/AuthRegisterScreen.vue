<template>
  <div>
    <template v-if="props.screen === `register`">
      <p class="auth-subtitle">{{ t('auth.registerSubTitle') }}</p>
      <auth-inline-error v-if="state.error" class="mb-3" :message="state.error" />
      <w-form ref="form" @submit="register">
        <!--
          Field chrome lives in `pages/Login.vue`'s `.auth` stylesheet -- this screen only ever
          renders inside that column. The name is two authored halves, never parsed: the display
          name derives from them server-side, and the last name is optional for a mononym.
        -->
        <w-input
          class="auth-field auth-field--sm"
          ref="firstNameIpt"
          v-model="state.newFirstName"
          @update:model-value="clearError"
          :rules="firstNameValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :placeholder="t(`auth.fields.firstName`)"
          :aria-label="t(`auth.fields.firstName`)"
          autocomplete="given-name">
          <template #prepend><w-icon name="tabler:user-circle" /></template>
        </w-input>
        <w-input
          class="auth-field auth-field--sm mt-2"
          v-model="state.newLastName"
          @update:model-value="clearError"
          :rules="lastNameValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :placeholder="t(`auth.fields.lastName`)"
          :aria-label="t(`auth.fields.lastName`)"
          autocomplete="family-name">
          <template #prepend><w-icon name="tabler:user-circle" /></template>
        </w-input>
        <w-input
          class="auth-field auth-field--sm mt-2"
          type="email"
          v-model="state.newEmail"
          @update:model-value="clearError"
          :rules="emailValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :placeholder="t(`auth.fields.email`)"
          :aria-label="t(`auth.fields.email`)"
          autocomplete="email">
          <template #prepend><w-icon name="tabler:mail" /></template>
        </w-input>
        <w-input
          class="auth-field auth-field--sm mt-2"
          v-model="state.newPassword"
          @update:model-value="clearError"
          :placeholder="t(`auth.fields.password`)"
          :aria-label="t(`auth.fields.password`)"
          type="password"
          autocomplete="new-password"
          :rules="passwordValidation"
          hide-bottom-space
          lazy-rules="ondemand">
          <template #append>
            <w-badge
              v-show="state.newPassword"
              :color="passwordStrength.color"
              :label="passwordStrength.label" />
          </template>
          <template #prepend><w-icon name="tabler:key" /></template>
        </w-input>
        <w-input
          class="auth-field auth-field--sm mt-2"
          v-model="state.newPasswordVerify"
          @update:model-value="clearError"
          :placeholder="t(`auth.fields.verifyPassword`)"
          :aria-label="t(`auth.fields.verifyPassword`)"
          type="password"
          autocomplete="new-password"
          :rules="passwordVerifyValidation"
          hide-bottom-space
          lazy-rules="ondemand">
          <template #prepend><w-icon name="tabler:key" /></template>
        </w-input>
        <w-btn
          class="auth-marks w-full mt-2.5"
          type="submit"
          color="accent"
          size="13.5px"
          padding="9.5px 16px"
          :label="t(`auth.actions.register`)"
          icon="tabler:user-plus" />
      </w-form>
      <w-separator spaced="16px" />
      <w-btn
        class="w-full"
        outline
        :color="chromeColor"
        size="13px"
        padding="8px 14px"
        :label="t(`auth.switchToLogin.link`)"
        icon="tabler:circle-arrow-left"
        @click="emit(`back-to-login`)" />
    </template>
    <template v-else-if="props.screen === `registerCheckEmail`">
      <!--
        `accent-fill` is the bright tone, for a glyph carrying no text of its own; `primary` is the
        darkened tone, for accent TEXT or a fill under a white label. It has no dark-mode override
        of its own, so dark mode must swap in `accent-dark` or this draws bright on a dark ground.
      -->
      <div class="flex flex-col items-center pt-3.5 text-center">
        <w-icon
          name="tabler:mail-opened"
          size="48px"
          :color="dark.isActive ? `accent-dark` : `accent-fill`"
          class="mb-3.5" />
        <p class="auth-notice">{{ t('auth.registerCheckEmail') }}</p>
      </div>
      <w-separator spaced="16px" />
      <w-btn
        class="w-full"
        outline
        :color="chromeColor"
        size="13px"
        padding="8px 14px"
        :label="t(`auth.switchToLogin.link`)"
        icon="tabler:circle-arrow-left"
        @click="emit(`back-to-login`)" />
    </template>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onMounted, reactive, ref } from 'vue'

import AuthInlineError from '@/components/AuthInlineError.vue'
import { loading } from '@/composables/loading'
import { useDark } from '@/composables/dark'
import { apiErrorMessage } from '@/helpers/apiError'
import {
  emailRules,
  firstNameRules,
  lastNameRules,
  passwordRules,
  passwordVerifyRules
} from '@/helpers/authValidation'
import { localizeError } from '@/helpers/localization'
import { passwordStrengthBadge } from '@/helpers/passwordStrength'

import { useSiteStore } from '@/stores/site'

const dark = useDark()

const siteStore = useSiteStore()

const { t } = useI18n()

const props = defineProps({
  screen: {
    type: String,
    required: true
  },
  strategyId: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['registered', 'back-to-login'])

const state = reactive({
  newFirstName: '',
  newLastName: '',
  newEmail: '',
  newPassword: '',
  newPasswordVerify: '',
  error: null
})

const firstNameIpt = ref(null)
const form = ref(null)

const passwordStrength = computed(() => passwordStrengthBadge(state.newPassword, t))

/** Same chrome-tone tokens as `AuthLoginPanel.vue`'s own `chromeColor` -- keep the two in sync. */
const chromeColor = computed(() => (dark.isActive ? 'slate-light' : 'slate'))

const firstNameValidation = firstNameRules(t)
const lastNameValidation = lastNameRules(t)
const emailValidation = emailRules(t)
const passwordValidation = passwordRules(t)
const passwordVerifyValidation = passwordVerifyRules(t, () => state.newPassword)

function clearError() {
  state.error = null
}

async function register() {
  clearError()
  loading.show({
    message: t('auth.registering')
  })
  try {
    const isFormValid = await form.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('auth.errors.register'))
    }
    const resp = await API_CLIENT.post(`sites/${siteStore.id}/auth/register`, {
      json: {
        strategyId: props.strategyId,
        firstName: state.newFirstName,
        lastName: state.newLastName,
        email: state.newEmail,
        password: state.newPassword
      }
    }).json()
    if (resp.ok) {
      state.newPassword = ''
      state.newPasswordVerify = ''
      emit('registered', resp)
    } else {
      throw new Error(resp.message || 'ERR_REGISTRATION_FAILED')
    }
  } catch (err) {
    loading.hide()
    state.error = localizeError(apiErrorMessage(err), t)
  }
}

onMounted(() => {
  firstNameIpt.value?.focus()
})
</script>
