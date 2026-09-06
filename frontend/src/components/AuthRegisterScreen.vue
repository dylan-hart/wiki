<template>
  <div>
    <template v-if="props.screen === `register`">
      <p class="auth-subtitle">{{ t('auth.registerSubTitle') }}</p>
      <w-form ref="form" @submit="register">
        <!--
          Five 40px fields carrying their own name as a placeholder, no label above -- the shape
          `Cardinal Wiki - Auth Screens 3x.dc.html` draws, and the same conversion the login form
          above it made. The chrome itself lives in `pages/Login.vue`'s `.auth` stylesheet, since
          this screen only ever renders inside that column.

          The name is two authored halves rather than one to split: an account created here is this
          instance's own, so the display name derives from them server-side (Feature #2608) and no
          parsing is ever applied. The last name is optional, for a mononym.
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
        <w-btn
          class="auth-marks w-full mt-2.5"
          type="submit"
          color="primary"
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
    <!-- ----------------------------------------------------- -->
    <!-- REGISTER CHECK EMAIL SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-else-if="props.screen === `registerCheckEmail`">
      <!--
        `accent-fill`, not `primary`: the glyph is a 48px line drawing carrying no text of its own,
        and the bright tone is the one the language reserves for exactly that (`primary` is the
        darkened tone, for accent TEXT and for a fill under a white label). The design draws it at
        `#e4676b`.
      -->
      <div class="flex flex-col items-center pt-3.5 text-center">
        <w-icon name="tabler:mail-opened" size="48px" color="accent-fill" class="mb-3.5" />
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
 * The self-registration screens of `AuthLoginPanel.vue`: the sign-up form, and the "check your
 * emails" screen a site with email validation on ends it at.
 *
 * Split out of the panel because the five fields it fills in are read by nothing else -- the panel's
 * own reset and change-password screens ask for a password too, but their own -- so the only thing
 * it needs from the sign-in attempt is which strategy to register against.
 */

// COMPOSABLES

const dark = useDark()

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// PROPS

const props = defineProps({
  /** Which of the two screens to draw: `register` or `registerCheckEmail`. */
  screen: {
    type: String,
    required: true
  },
  /** The strategy to register against. */
  strategyId: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['registered', 'back-to-login'])

// DATA

const state = reactive({
  newFirstName: '',
  newLastName: '',
  newEmail: '',
  newPassword: '',
  newPasswordVerify: ''
})

// REFS

const firstNameIpt = ref(null)
const form = ref(null)

// COMPUTED

const passwordStrength = computed(() => passwordStrengthBadge(state.newPassword, t))

/** See `AuthLoginPanel`'s own `chromeColor`: the chrome tone, lightened for the ink ground. */
const chromeColor = computed(() => (dark.isActive ? 'slate-light' : 'slate'))

// VALIDATION RULES

const firstNameValidation = firstNameRules(t)
const lastNameValidation = lastNameRules(t)
const emailValidation = emailRules(t)
const passwordValidation = passwordRules(t)
const passwordVerifyValidation = passwordVerifyRules(t, () => state.newPassword)

// METHODS

/**
 * REGISTER
 *
 * `nextAction: 'verify'` means the strategy requires email validation: the account was created
 * unverified and a link was mailed to it, so this shows a "check your email" screen instead of
 * calling `handleLoginResponse()` -- there is no session to establish yet. Any other `nextAction`
 * (validation off) is a login exactly like every other successful auth attempt, so it's handed to
 * the same response handler the rest of this panel uses.
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
      // -> Where the flow goes next -- the check-your-email screen or straight into a session -- is
      //    the panel's to decide, the same as it is for every other successful auth attempt. It also
      //    owns the login form's own password field, which a completed registration clears.
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

// MOUNTED

/*
  The panel used to focus this from its own `switchTo('register')`, on the tick after the screen
  changed. Mounting IS that moment now -- this component exists only while the register screen is up.
*/
onMounted(() => {
  firstNameIpt.value?.focus()
})
</script>
