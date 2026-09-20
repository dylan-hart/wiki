<template>
  <div>
    <template v-if="state.screen === `login`">
      <template v-if="formStrategies.length > 1">
        <p class="auth-hint">{{ t('auth.selectAuthProvider') }}</p>
        <div class="auth-strategies">
          <w-btn
            v-for="str of formStrategies"
            :key="str.id"
            :label="str.activeStrategy.displayName"
            :icon="`img:` + str.activeStrategy.strategy.icon"
            size="13px"
            padding="7px 12px"
            :outline="str.id !== state.selectedStrategyId"
            :color="str.id === state.selectedStrategyId ? `accent` : chromeColor"
            @click="state.selectedStrategyId = str.id" />
        </div>
      </template>
      <w-form ref="loginForm" @submit="login">
        <!--
          No visible label, so the placeholder is the field's name and `aria-label` is the only
          thing keeping it a named control for a screen reader (and for e2e's `getByLabel`).
        -->
        <w-input
          class="auth-field"
          ref="loginEmailIpt"
          v-model="state.username"
          :placeholder="usernameFieldLabel"
          :aria-label="usernameFieldLabel"
          :rules="
            selectedStrategy.activeStrategy?.strategy?.usernameType === `username`
              ? loginUsernameValidation
              : userEmailValidation
          "
          lazy-rules="ondemand"
          hide-bottom-space
          :autocomplete="selectedStrategy.activeStrategy?.strategy?.usernameType ?? `email`">
          <template #prepend><w-icon name="tabler:user" /></template>
        </w-input>
        <w-input
          class="auth-field mt-2"
          v-model="state.password"
          :placeholder="t(`auth.fields.password`)"
          :aria-label="t(`auth.fields.password`)"
          :rules="loginPasswordValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          type="password"
          autocomplete="current-password">
          <template #prepend><w-icon name="tabler:key" /></template>
        </w-input>
        <w-btn
          class="auth-marks w-full mt-2.5"
          type="submit"
          color="accent"
          size="14px"
          padding="10px 16px"
          :label="t(`auth.actions.login`)"
          icon="tabler:login" />
      </w-form>
      <!--
        No email field first: a passkey is a discoverable credential, so the authenticator already
        knows which accounts it holds for this site.
      -->
      <template v-if="canUsePasskeys">
        <w-separator spaced="18px" />
        <!--
          Outline, not `acrylic-btn`: that class paints a borderless tinted slab rather than the
          hairline box this screen's other secondary rows use. Accent tone, since this is a way in.
        -->
        <w-btn
          class="w-full"
          outline
          color="accent"
          size="13.5px"
          padding="8.5px 14px"
          :label="t(`auth.passkeys.signin`)"
          icon="tabler:key"
          @click="loginWithPasskey" />
      </template>
      <!--
        A link, not a form submit: this hands the browser to the provider, which returns at the
        callback route with a session already established.
      -->
      <template v-if="redirectStrategies.length > 0">
        <w-separator spaced="18px" />
        <w-btn
          class="w-full mb-2"
          v-for="str of redirectStrategies"
          :key="str.id"
          outline
          :color="chromeColor"
          size="13.5px"
          padding="8.5px 14px"
          :label="t(`auth.actions.loginWith`, { provider: str.activeStrategy.displayName })"
          :icon="`img:` + str.activeStrategy.strategy.icon"
          :href="authorizeUrl(str)"
          type="a" />
      </template>
      <template v-if="selectedStrategy.activeStrategy?.strategy?.key === `local`">
        <w-separator spaced="18px" />
        <w-btn
          class="w-full mb-2"
          v-if="selectedStrategy.activeStrategy.selfRegistration"
          outline
          :color="chromeColor"
          size="13px"
          padding="8px 14px"
          :label="t(`auth.switchToRegister.link`)"
          icon="tabler:user-plus"
          @click="switchTo(`register`)" />
        <w-btn
          class="w-full"
          v-if="selectedStrategy.activeStrategy.allowForgotPassword"
          outline
          :color="chromeColor"
          size="13px"
          padding="8px 14px"
          :label="t(`auth.forgotPasswordLink`)"
          icon="tabler:lifebuoy"
          @click="switchTo(`forgot`)" />
      </template>
    </template>
    <template v-else-if="state.screen === `forgot`">
      <p class="auth-subtitle">{{ t('auth.forgotPasswordSubtitle') }}</p>
      <w-form ref="forgotForm" @submit="forgotPassword">
        <w-input
          class="auth-field auth-field--sm"
          ref="forgotEmailIpt"
          v-model="state.forgotEmail"
          :rules="userEmailValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :placeholder="t(`auth.fields.email`)"
          :aria-label="t(`auth.fields.email`)"
          autocomplete="email">
          <template #prepend><w-icon name="tabler:mail" /></template>
        </w-input>
        <w-btn
          class="auth-marks w-full mt-2.5"
          type="submit"
          color="accent"
          size="13.5px"
          padding="9.5px 16px"
          :label="t(`auth.sendResetPassword`)"
          icon="tabler:lifebuoy" />
      </w-form>
      <w-separator spaced="16px" />
      <w-btn
        class="w-full"
        outline
        :color="chromeColor"
        size="13px"
        padding="8px 14px"
        :label="t(`auth.forgotPasswordCancel`)"
        icon="tabler:circle-arrow-left"
        @click="switchTo(`login`)" />
    </template>
    <template v-else-if="state.screen === `reset`">
      <p class="auth-subtitle">{{ t('auth.resetPassword.subtitle') }}</p>
      <w-form ref="resetPasswordForm" @submit="resetPassword">
        <w-input
          class="auth-field auth-field--sm"
          ref="resetNewPwdIpt"
          v-model="state.newPassword"
          :placeholder="t(`auth.fields.password`)"
          :aria-label="t(`auth.fields.password`)"
          type="password"
          autocomplete="new-password"
          :rules="userPasswordValidation"
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
          :rules="userPasswordVerifyValidation"
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
          :label="t(`auth.resetPassword.proceed`)"
          icon="tabler:refresh" />
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
        @click="switchTo(`login`)" />
    </template>
    <auth-register-screen
      v-else-if="[`register`, `registerCheckEmail`].includes(state.screen)"
      :screen="state.screen"
      :strategy-id="state.selectedStrategyId"
      @registered="finishRegistration"
      @back-to-login="switchTo(`login`)" />
    <template v-else-if="state.screen === `changePwd`">
      <p v-if="state.continuationToken" class="auth-subtitle">
        {{ t('auth.changePwd.instructions') }}
      </p>
      <w-form ref="changePwdForm" @submit="changePwd">
        <w-input
          class="auth-field auth-field--sm"
          v-if="!state.continuationToken"
          ref="changePwdCurrentIpt"
          v-model="state.password"
          type="password"
          :rules="loginPasswordValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :placeholder="t(`auth.changePwd.currentPassword`)"
          :aria-label="t(`auth.changePwd.currentPassword`)"
          autocomplete="password">
          <template #prepend><w-icon name="tabler:key" /></template>
        </w-input>
        <w-input
          class="auth-field auth-field--sm mt-2"
          ref="changePwdNewPwdIpt"
          v-model="state.newPassword"
          :placeholder="t(`auth.changePwd.newPassword`)"
          :aria-label="t(`auth.changePwd.newPassword`)"
          type="password"
          autocomplete="new-password"
          :rules="userPasswordValidation"
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
          :placeholder="t(`auth.changePwd.newPasswordVerify`)"
          :aria-label="t(`auth.changePwd.newPasswordVerify`)"
          type="password"
          autocomplete="new-password"
          :rules="userPasswordVerifyValidation"
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
          :label="t(`auth.changePwd.proceed`)"
          icon="tabler:refresh" />
      </w-form>
    </template>
    <!-- Keyed on the screen: switching between the two remounts it with empty fields. -->
    <auth-tfa-screens
      v-else-if="[`tfa`, `tfasetup`].includes(state.screen)"
      :key="state.screen"
      :screen="state.screen"
      :strategy-id="state.selectedStrategyId"
      :continuation-token="state.continuationToken"
      :qr-image="state.tfaQRImage"
      @login-response="handleLoginResponse"
      @restart="restartAfterTfa" />
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { useDark } from '@/composables/dark'
import { apiErrorMessage } from '@/helpers/apiError'
import { emailRules, passwordRules, passwordVerifyRules } from '@/helpers/authValidation'
import { localizeError } from '@/helpers/localization'
import { log } from '@/helpers/log'
import { passwordStrengthBadge } from '@/helpers/passwordStrength'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { isFollowableRedirectTarget } from '@/helpers/pageRedirect'
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser'

import AuthRegisterScreen from '@/components/AuthRegisterScreen.vue'
import AuthTfaScreens from '@/components/AuthTfaScreens.vue'

/** `Login.vue` owns the exit-animation CSS; this component owns the trigger and its timing. */
const emit = defineEmits(['exit-flourish'])

const dark = useDark()

const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

const state = reactive({
  strategies: [],
  selectedStrategyId: null,
  screen: 'login',
  username: '',
  password: '',
  continuationToken: '',
  newPassword: '',
  newPasswordVerify: '',
  forgotEmail: '',
  resetToken: '',
  isTFAShown: false,
  isTFASetupShown: false,
  tfaQRImage: ''
})

const loginEmailIpt = ref(null)
const forgotEmailIpt = ref(null)
const changePwdCurrentIpt = ref(null)
const changePwdNewPwdIpt = ref(null)
const resetNewPwdIpt = ref(null)
const loginForm = ref(null)
const forgotForm = ref(null)
const changePwdForm = ref(null)
const resetPasswordForm = ref(null)

/*
  Split because the two are drawn nothing alike -- credentials typed here versus a button that
  leaves for the provider -- and so a provider can never be picked in the form's own selector,
  where it would be asked for a password it has no use for.
*/
const formStrategies = computed(() =>
  state.strategies.filter((str) => str.activeStrategy?.strategy?.useForm !== false)
)

const redirectStrategies = computed(() =>
  state.strategies.filter((str) => str.activeStrategy?.strategy?.useForm === false)
)

const selectedStrategy = computed(() => {
  return (
    (state.selectedStrategyId && state.strategies.find((s) => s.id === state.selectedStrategyId)) ||
    {}
  )
})

const passwordStrength = computed(() => passwordStrengthBadge(state.newPassword, t))

/**
 * `slate` is a chrome tone for a LIGHT ground; on the ink ground it disappears into the panel, so
 * dark mode takes the lightened rung. A `dark:` utility can't do this: `WBtn` resolves `color` to
 * an inline `var(--color-…)`, so the switch has to happen at the prop.
 */
const chromeColor = computed(() => (dark.isActive ? 'slate-light' : 'slate'))

const usernameFieldLabel = computed(() =>
  t(`auth.fields.` + (selectedStrategy.value.activeStrategy?.strategy?.usernameType ?? `email`))
)

const canUsePasskeys = computed(() => {
  return browserSupportsWebAuthn()
})

const loginUsernameValidation = [(val) => val.length > 0 || t('auth.errors.missingUsername')]

const loginPasswordValidation = [(val) => val.length > 0 || t('auth.errors.missingPassword')]

const userEmailValidation = emailRules(t)

const userPasswordValidation = passwordRules(t)

const userPasswordVerifyValidation = passwordVerifyRules(t, () => state.newPassword)

function switchTo(screen) {
  switch (screen) {
    case 'login': {
      state.screen = 'login'
      nextTick(() => {
        loginEmailIpt.value.focus()
      })
      break
    }
    case 'forgot': {
      state.screen = 'forgot'
      nextTick(() => {
        forgotEmailIpt.value.focus()
      })
      break
    }
    case 'register': {
      // -> No focus call: `AuthRegisterScreen` mounts with this screen and focuses its own first
      //    field.
      state.screen = 'register'
      break
    }
    case 'reset': {
      state.screen = 'reset'
      nextTick(() => {
        resetNewPwdIpt.value.focus()
      })
      break
    }
    default: {
      throw new Error('ERR_INVALID_SCREEN')
    }
  }
}

async function fetchStrategies(showAll = false) {
  state.strategies = await API_CLIENT.get(`sites/${siteStore.id}/auth/strategies`, {
    searchParams: {
      visibleOnly: !showAll
    }
  }).json()
  // -> The selection drives the form, so it has to be a strategy that has one
  state.selectedStrategyId = formStrategies.value[0]?.id ?? null
}

/**
 * The backend builds the authorize URL: everything that ties the answer back to this browser --
 * `state`, the nonce, the PKCE verifier -- is generated there and kept on the session.
 */
function authorizeUrl(str) {
  const params = new URLSearchParams({ siteId: siteStore.id })
  return `/_api/auth/${str.id}/authorize?${params.toString()}`
}

/** Read-and-cleared by `MainLayout.vue` on mount to gate the entrance flourish. */
const JUST_LOGGED_IN_KEY = 'cardinal:justLoggedIn'

/** Matches `Login.vue`'s `.auth-content`/`.auth-bg` exit-transition duration. */
const EXIT_FLOURISH_MS = 320

async function handleLoginResponse(resp) {
  state.continuationToken = resp.continuationToken
  switch (resp.nextAction) {
    case 'changePassword': {
      state.screen = 'changePwd'
      nextTick(() => {
        if (state.continuationToken) {
          changePwdNewPwdIpt.value.focus()
        } else {
          changePwdCurrentIpt.value.focus()
        }
      })
      loading.hide()
      break
    }
    case 'provideTfa': {
      state.screen = 'tfa'
      loading.hide()
      break
    }
    case 'setupTfa': {
      state.screen = 'tfasetup'
      state.tfaQRImage = resp.tfaQRImage
      loading.hide()
      break
    }
    case 'redirect': {
      /*
        `window.location.replace()` below is a real navigation, not a router push: the whole SPA is
        rebuilt from `bootstrap`, so no Pinia state survives here to go stale, unlike across
        logout().
      */
      loading.show({
        message: t('auth.loginSuccess')
      })
      /*
        Re-checked client-side as well: `javascript:…` parses as a valid `URL` with no error, so a
        bare try/catch around `new URL()` isn't enough -- the scheme itself has to be checked.
      */
      const target =
        resp.redirect && isFollowableRedirectTarget(resp.redirect) ? resp.redirect : '/'
      /*
        Set before either branch navigates, the reduced-motion one included: the flag has to exist
        by the time `MainLayout.vue` reads it on the next mount, even on a run that never animates.
      */
      sessionStorage.setItem(JUST_LOGGED_IN_KEY, '1')
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        window.location.replace(target)
      } else {
        emit('exit-flourish')
        setTimeout(() => {
          window.location.replace(target)
        }, EXIT_FLOURISH_MS)
      }
      break
    }
    default: {
      loading.hide()
      notify({
        type: 'negative',
        message: t('auth.errors.unexpectedResponse')
      })
    }
  }
}

async function login() {
  loading.show({
    message: t('auth.signingIn')
  })
  try {
    const isFormValid = await loginForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('auth.errors.login'))
    }
    const resp = await API_CLIENT.put(`sites/${siteStore.id}/auth/login`, {
      json: {
        strategyId: state.selectedStrategyId,
        username: state.username,
        password: state.password
      }
    }).json()
    if (resp.ok) {
      state.password = ''
      handleLoginResponse(resp)
    } else {
      throw new Error(resp.message || 'ERR_LOGIN_FAILED')
    }
  } catch (err) {
    log.warn('auth', 'could not sign in', err)
    loading.hide()
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  }
}

async function loginWithPasskey() {
  loading.show({
    message: t('auth.signingIn')
  })
  try {
    const respGen = await API_CLIENT.post(`sites/${siteStore.id}/auth/passkey/challenge`).json()
    if (!respGen?.ok) {
      throw new Error(respGen?.message || 'ERR_LOGIN_FAILED')
    }

    // -> No `useBrowserAutofill`: that fills a passkey into a field the user is typing in, and
    //    there is no field here -- this opens the browser's own account picker instead
    const authResp = await startAuthentication({ optionsJSON: respGen.authOptions })

    const respVerif = await API_CLIENT.put(`sites/${siteStore.id}/auth/passkey/login`, {
      json: {
        authResponse: authResp
      }
    }).json()
    if (!respVerif?.ok) {
      throw new Error(respVerif?.message || 'ERR_LOGIN_FAILED')
    }
    await handleLoginResponse(respVerif)
  } catch (err) {
    loading.hide()
    // -> Dismissing the browser's passkey prompt is a change of mind, not a failure to report
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      return
    }
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  }
}

/**
 * The same generic message whatever the backend actually did -- an unknown address, a strategy
 * with resets turned off and a real match all answer the same 200. Branching on the response would
 * turn this form into an account-enumeration oracle.
 */
async function forgotPassword() {
  loading.show({
    message: t('auth.forgotPasswordLoading')
  })
  try {
    const isFormValid = await forgotForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('auth.errors.forgotPassword'))
    }
    await API_CLIENT.post(`sites/${siteStore.id}/auth/forgotPassword`, {
      json: {
        strategyId: state.selectedStrategyId,
        email: state.forgotEmail
      }
    }).json()
    state.forgotEmail = ''
    notify({
      type: 'positive',
      message: t('auth.forgotPasswordSuccess')
    })
    switchTo('login')
  } catch (err) {
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  } finally {
    loading.hide()
  }
}

/** Clears the login form's own password field -- it belongs to that form, not the register one. */
function finishRegistration(resp) {
  state.password = ''
  if (resp.nextAction === 'verify') {
    state.screen = 'registerCheckEmail'
    loading.hide()
  } else {
    handleLoginResponse(resp)
  }
}

async function changePwd() {
  try {
    const isFormValid = await changePwdForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('auth.errors.register'))
    }
    const resp = await API_CLIENT.put(`sites/${siteStore.id}/auth/changePassword`, {
      json: {
        strategyId: state.selectedStrategyId,
        continuationToken: state.continuationToken,
        newPassword: state.newPassword
      }
    }).json()
    if (resp.ok) {
      state.password = ''
      notify({
        type: 'positive',
        message: t('auth.changePwd.success')
      })
      await handleLoginResponse(resp)
    } else {
      throw new Error(resp.message || 'ERR_CHANGE_PASSWORD_FAILED')
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  }
}

async function resetPassword() {
  try {
    const isFormValid = await resetPasswordForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('auth.errors.resetPassword'))
    }
    const resp = await API_CLIENT.put(`sites/${siteStore.id}/auth/resetPassword`, {
      json: {
        strategyId: state.selectedStrategyId,
        token: state.resetToken,
        newPassword: state.newPassword
      }
    }).json()
    if (resp.ok) {
      state.newPassword = ''
      state.newPasswordVerify = ''
      notify({
        type: 'positive',
        message: t('auth.resetPassword.success')
      })
      await handleLoginResponse(resp)
    } else {
      throw new Error(resp.message || 'ERR_RESET_PASSWORD_FAILED')
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  }
}

/** The continuation token is spent or expired, so nothing is left to continue from. */
function restartAfterTfa() {
  state.continuationToken = ''
  state.password = ''
  switchTo('login')
}

onMounted(async () => {
  /*
    Before `fetchStrategies()`'s round trip: reading the URL costs nothing, so the caret can land
    on first paint. Guarded on the screen still being `login` -- a reset-password link switches
    screens and focuses its own field, and this would otherwise steal focus back.
  */
  detectResetToken()
  if (state.screen === 'login') {
    nextTick(() => {
      loginEmailIpt.value?.focus()
    })
  }
  await fetchStrategies(shouldShowAllStrategies())
  reportRedirectLoginError()
  reportVerifiedSuccess()
})

/**
 * A provider login fails at the callback route, which has a browser to redirect and no request to
 * answer, so the reason travels in the URL. Stripped afterwards so a reload doesn't repeat it.
 */
function reportRedirectLoginError() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('error')
  if (!code) {
    return
  }
  notify({
    type: 'negative',
    message: t('auth.errors.loginError'),
    caption: localizeError(code, t)
  })
  params.delete('error')
  const query = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}`
  )
}

/** `GET /auth/verify/:token` redirects here with `?verified=true` on success. */
function reportVerifiedSuccess() {
  const params = new URLSearchParams(window.location.search)
  if (params.get('verified') !== 'true') {
    return
  }
  notify({
    type: 'positive',
    message: t('auth.verifySuccess')
  })
  params.delete('verified')
  const query = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}`
  )
}

/**
 * The forgot-password email points at `/login/reset-password/:token` -- a path segment, not a
 * query param.
 */
function detectResetToken() {
  const match = window.location.pathname.match(/^\/login\/reset-password\/([^/]+)\/?$/)
  if (!match) {
    return
  }
  state.resetToken = decodeURIComponent(match[1])
  switchTo('reset')
}

/**
 * Escape hatch: `?all` shows every strategy, Visible or not, so local admin login stays reachable
 * without exposing that provider to normal users. Left in the address bar so it survives a reload.
 */
function shouldShowAllStrategies() {
  const params = new URLSearchParams(window.location.search)
  if (!params.has('all')) {
    return false
  }
  const value = params.get('all')
  return value === '' || value === '1' || value === 'true'
}
</script>
