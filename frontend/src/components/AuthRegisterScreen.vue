<template>
  <div>
    <template v-if="props.screen === `register`">
      <p class="auth-subtitle">{{ t('auth.registerSubTitle') }}</p>
      <w-form ref="form" @submit="register">
        <!--
          Five 40px fields carrying their own name as a placeholder, no label above -- matching the
          login form's fields above it. Chrome lives in `pages/Login.vue`'s `.auth` stylesheet,
          since this screen only ever renders inside that column.

          The name is two authored halves rather than one to split: no parsing is ever applied, and
          the display name derives from them server-side. The last name is optional, for a mononym.
        -->
        <w-input
          class="auth-field auth-field--sm"
          ref="firstNameIpt"
          v-model="state.newFirstName"
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
          :placeholder="t(`auth.fields.verifyPassword`)"
          :aria-label="t(`auth.fields.verifyPassword`)"
          type="password"
          autocomplete="new-password"
          :rules="passwordVerifyValidation"
          hide-bottom-space
          lazy-rules="ondemand">
          <template #prepend><w-icon name="tabler:key" /></template>
        </w-input>
        <!-- `color="accent"`, not `primary`: a distinct "accent fill, white text" role from primary
             text/link color. -->
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
        `accent-fill`, not `primary`: the glyph is a 48px line drawing carrying no text of its own,
        so it uses the bright accent tone (`primary` is the darkened tone, for accent TEXT or a
        fill under a white label).

        `dark.isActive` swaps it for `accent-dark` under dark mode -- `--color-accent-fill` has no
        dark-mode override of its own, so left alone this would draw the same bright tone against a
        dark ground.
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

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
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

/**
 * Split out of `AuthLoginPanel.vue` because the five fields it fills in are read by nothing else --
 * the panel's own reset and change-password screens ask for a password too, but their own -- so the
 * only thing this needs from the sign-in attempt is which strategy to register against.
 */

const dark = useDark()

const siteStore = useSiteStore()

const { t } = useI18n()

const props = defineProps({
  /** Which of the two screens to draw: `register` or `registerCheckEmail`. */
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
  newPasswordVerify: ''
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

/**
 * `nextAction: 'verify'` means the strategy requires email validation: the account was created
 * unverified and a link was mailed to it, so this shows a "check your email" screen instead of
 * calling `handleLoginResponse()` -- there is no session to establish yet. Any other `nextAction`
 * is a login like any other, handed to the same response handler the rest of the panel uses.
 */
async function register() {
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
      // -> Where the flow goes next -- check-your-email or straight into a session -- is the
      //    panel's call, same as any other successful auth attempt; it also owns the login form's
      //    own password field, which a completed registration clears.
      emit('registered', resp)
    } else {
      throw new Error(resp.message || 'ERR_REGISTRATION_FAILED')
    }
  } catch (err) {
    loading.hide()
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  }
}

// This component exists only while the register screen is up, so mounting is the moment to focus
// its first field.
onMounted(() => {
  firstNameIpt.value?.focus()
})
</script>
