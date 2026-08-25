<template>
  <div>
    <!-- ----------------------------------------------------- -->
    <!-- LOGIN SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-if="state.screen === `login`">
      <template v-if="formStrategies.length > 1">
        <p>{{ t('auth.selectAuthProvider') }}</p>
        <div class="auth-strategies mb-4">
          <w-btn
            v-for="str of formStrategies"
            :label="str.activeStrategy.displayName"
            :icon="`img:` + str.activeStrategy.strategy.icon"
            push
            no-caps
            :color="
              str.id === state.selectedStrategyId
                ? `primary`
                : dark.isActive
                  ? `blue-grey-9`
                  : `grey-1`
            "
            :text-color="
              str.id === state.selectedStrategyId || dark.isActive ? `white` : `blue-grey-9`
            "
            @click="state.selectedStrategyId = str.id" />
        </div>
      </template>
      <w-form ref="loginForm" @submit="login">
        <w-input
          ref="loginEmailIpt"
          v-model="state.username"
          autofocus
          outlined
          :label="
            t(`auth.fields.` + (selectedStrategy.activeStrategy?.strategy?.usernameType ?? `email`))
          "
          :rules="
            selectedStrategy.activeStrategy?.strategy?.usernameType === `username`
              ? loginUsernameValidation
              : userEmailValidation
          "
          lazy-rules="ondemand"
          hide-bottom-space
          :autocomplete="selectedStrategy.activeStrategy?.strategy?.usernameType ?? `email`">
          <template #prepend><w-icon name="la:user" /></template>
        </w-input>
        <w-input
          class="mt-2"
          v-model="state.password"
          outlined
          :label="t(`auth.fields.password`)"
          :rules="loginPasswordValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          type="password"
          autocomplete="current-password">
          <template #prepend><w-icon name="la:key" /></template>
        </w-input>
        <w-btn
          class="w-full mt-2"
          type="submit"
          push
          color="primary"
          :label="t(`auth.actions.login`)"
          no-caps
          icon="la:sign-in-alt" />
      </w-form>
      <!--
        Straight into the browser's passkey prompt: a passkey is a discoverable credential, so the
        authenticator knows which accounts it holds for this site and asking for an email address first
        would only be a step in the way.
      -->
      <template v-if="canUsePasskeys">
        <w-separator class="my-4" />
        <w-btn
          class="acrylic-btn w-full"
          flat
          color="primary"
          :label="t(`auth.passkeys.signin`)"
          no-caps
          icon="la:key"
          @click="loginWithPasskey" />
      </template>
      <!--
        The providers that sign a user in elsewhere. A link rather than a form submit, because what
        follows is a page at the provider and not an answer to a request: pressing it hands the browser
        over, and it comes back at the callback route with a session already established.
      -->
      <template v-if="redirectStrategies.length > 0">
        <w-separator class="my-4" />
        <w-btn
          class="acrylic-btn w-full mb-2"
          v-for="str of redirectStrategies"
          :key="str.id"
          flat
          color="primary"
          :label="t(`auth.actions.loginWith`, { provider: str.activeStrategy.displayName })"
          no-caps
          :icon="`img:` + str.activeStrategy.strategy.icon"
          :href="authorizeUrl(str)"
          type="a" />
      </template>
      <template v-if="selectedStrategy.activeStrategy?.strategy?.key === `local`">
        <w-separator class="my-4" />
        <w-btn
          class="acrylic-btn w-full mb-2"
          v-if="selectedStrategy.activeStrategy.registration"
          flat
          color="primary"
          :label="t(`auth.switchToRegister.link`)"
          no-caps
          icon="la:user-plus"
          @click="switchTo(`register`)" />
        <!-- -> Off where the strategy says so: a wiki that hands passwords out rather than letting
                them be chosen has nothing for this to do -->
        <w-btn
          class="acrylic-btn w-full"
          v-if="selectedStrategy.activeStrategy.allowForgotPassword"
          flat
          color="primary"
          :label="t(`auth.forgotPasswordLink`)"
          no-caps
          icon="la:life-ring"
          @click="switchTo(`forgot`)" />
      </template>
    </template>
    <!-- ----------------------------------------------------- -->
    <!-- FORGOT PASSWORD SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-else-if="state.screen === `forgot`">
      <p>{{ t('auth.forgotPasswordSubtitle') }}</p>
      <w-form ref="forgotForm" @submit="forgotPassword">
        <w-input
          ref="forgotEmailIpt"
          v-model="state.forgotEmail"
          outlined
          :rules="userEmailValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :label="t(`auth.fields.email`)"
          autocomplete="email">
          <template #prepend><w-icon name="la:envelope" /></template>
        </w-input>
        <w-btn
          class="w-full mt-2"
          type="submit"
          push
          color="primary"
          :label="t(`auth.sendResetPassword`)"
          no-caps
          icon="la:life-ring" />
      </w-form>
      <w-separator class="my-4" />
      <w-btn
        class="acrylic-btn w-full"
        flat
        color="primary"
        :label="t(`auth.forgotPasswordCancel`)"
        no-caps
        icon="la:arrow-circle-left"
        @click="switchTo(`login`)" />
    </template>
    <!-- ----------------------------------------------------- -->
    <!-- RESET PASSWORD SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-else-if="state.screen === `reset`">
      <p>{{ t('auth.resetPassword.subtitle') }}</p>
      <w-form ref="resetPasswordForm" @submit="resetPassword">
        <w-input
          ref="resetNewPwdIpt"
          v-model="state.newPassword"
          outlined
          :label="t(`auth.fields.password`)"
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
          <template #prepend><w-icon name="la:key" /></template>
        </w-input>
        <w-input
          class="mt-2"
          v-model="state.newPasswordVerify"
          outlined
          :label="t(`auth.fields.verifyPassword`)"
          type="password"
          autocomplete="new-password"
          :rules="userPasswordVerifyValidation"
          hide-bottom-space
          lazy-rules="ondemand">
          <template #prepend><w-icon name="la:key" /></template>
        </w-input>
        <w-btn
          class="w-full mt-2"
          type="submit"
          push
          color="primary"
          :label="t(`auth.resetPassword.proceed`)"
          no-caps
          icon="la:sync-alt" />
      </w-form>
      <w-separator class="my-4" />
      <w-btn
        class="acrylic-btn w-full"
        flat
        color="primary"
        :label="t(`auth.switchToLogin.link`)"
        no-caps
        icon="la:arrow-circle-left"
        @click="switchTo(`login`)" />
    </template>
    <!-- ----------------------------------------------------- -->
    <!-- REGISTER SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-else-if="state.screen === `register`">
      <p>{{ t('auth.registerSubTitle') }}</p>
      <w-form ref="registerForm" @submit="register">
        <w-input
          ref="registerNameIpt"
          v-model="state.newName"
          outlined
          :rules="userNameValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :label="t(`auth.fields.name`)"
          autocomplete="name">
          <template #prepend><w-icon name="la:user-circle" /></template>
        </w-input>
        <w-input
          class="mt-2"
          type="email"
          v-model="state.newEmail"
          outlined
          :rules="userEmailValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :label="t(`auth.fields.email`)"
          autocomplete="email">
          <template #prepend><w-icon name="la:envelope" /></template>
        </w-input>
        <w-input
          class="mt-2"
          v-model="state.newPassword"
          outlined
          :label="t(`auth.fields.password`)"
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
          <template #prepend><w-icon name="la:key" /></template>
        </w-input>
        <w-input
          class="mt-2"
          v-model="state.newPasswordVerify"
          outlined
          :label="t(`auth.fields.verifyPassword`)"
          type="password"
          autocomplete="new-password"
          :rules="userPasswordVerifyValidation"
          hide-bottom-space
          lazy-rules="ondemand">
          <template #prepend><w-icon name="la:key" /></template>
        </w-input>
        <w-btn
          class="w-full mt-2"
          type="submit"
          push
          color="primary"
          :label="t(`auth.actions.register`)"
          no-caps
          icon="la:user-plus" />
      </w-form>
      <w-separator class="my-4" />
      <w-btn
        class="acrylic-btn w-full"
        flat
        color="primary"
        :label="t(`auth.switchToLogin.link`)"
        no-caps
        icon="la:arrow-circle-left"
        @click="switchTo(`login`)" />
    </template>
    <!-- ----------------------------------------------------- -->
    <!-- REGISTER CHECK EMAIL SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-else-if="state.screen === `registerCheckEmail`">
      <div class="flex flex-col items-center text-center">
        <w-icon name="la:envelope-open-text" size="48px" color="primary" class="mb-4" />
        <p>{{ t('auth.registerCheckEmail') }}</p>
      </div>
      <w-separator class="my-4" />
      <w-btn
        class="acrylic-btn w-full"
        flat
        color="primary"
        :label="t(`auth.switchToLogin.link`)"
        no-caps
        icon="la:arrow-circle-left"
        @click="switchTo(`login`)" />
    </template>
    <!-- ----------------------------------------------------- -->
    <!-- CHANGE PASSWORD SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-else-if="state.screen === `changePwd`">
      <p v-if="state.continuationToken">{{ t('auth.changePwd.instructions') }}</p>
      <w-form ref="changePwdForm" @submit="changePwd">
        <w-input
          v-if="!state.continuationToken"
          ref="changePwdCurrentIpt"
          v-model="state.password"
          outlined
          type="password"
          :rules="loginPasswordValidation"
          lazy-rules="ondemand"
          hide-bottom-space
          :label="t(`auth.changePwd.currentPassword`)"
          autocomplete="password">
          <template #prepend><w-icon name="la:key" /></template>
        </w-input>
        <w-input
          class="mt-2"
          ref="changePwdNewPwdIpt"
          v-model="state.newPassword"
          outlined
          :label="t(`auth.changePwd.newPassword`)"
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
          <template #prepend><w-icon name="la:key" /></template>
        </w-input>
        <w-input
          class="mt-2"
          v-model="state.newPasswordVerify"
          outlined
          :label="t(`auth.changePwd.newPasswordVerify`)"
          type="password"
          autocomplete="new-password"
          :rules="userPasswordVerifyValidation"
          hide-bottom-space
          lazy-rules="ondemand">
          <template #prepend><w-icon name="la:key" /></template>
        </w-input>
        <w-btn
          class="w-full mt-2"
          type="submit"
          push
          color="primary"
          :label="t(`auth.changePwd.proceed`)"
          no-caps
          icon="la:sync-alt" />
      </w-form>
    </template>
    <!-- ----------------------------------------------------- -->
    <!-- TFA SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-else-if="state.screen === `tfa`">
      <p>{{ t('auth.tfa.subtitle') }}</p>
      <v-otp-input
        v-if="!state.useRecoveryCode"
        v-model:value="state.securityCode"
        :num-inputs="6"
        :should-auto-focus="true"
        input-classes="otp-input"
        input-type="number"
        separator=""
        @on-complete="verifyTFA" />
      <w-input
        v-else
        v-model="recoveryCodeInput"
        outlined
        autofocus
        class="mt-2"
        :label="t(`auth.tfa.recoveryCodeLabel`)"
        :hint="t(`auth.tfa.recoveryCodeHint`)"
        placeholder="XXXX-XXXX-XXXX-XXXX"
        @keyup:enter="verifyTFA" />
      <w-btn
        class="w-full mt-4"
        push
        color="primary"
        :label="t(`auth.tfa.verifyToken`)"
        no-caps
        icon="la:sign-in-alt"
        @click="verifyTFA" />
      <w-btn
        class="w-full mt-2"
        flat
        no-caps
        color="grey"
        :label="
          state.useRecoveryCode ? t('auth.tfa.useSecurityCode') : t('auth.tfa.useRecoveryCode')
        "
        @click="toggleRecoveryCodeMode" />
    </template>
    <!-- ----------------------------------------------------- -->
    <!-- TFA SETUP SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-else-if="state.screen === `tfasetup`">
      <p>{{ t('auth.tfaSetupTitle') }}</p>
      <p>{{ t('auth.tfaSetupInstrFirst') }}</p>
      <div style="justify-content: center; display: flex">
        <div v-html="state.tfaQRImage" style="width: 200px" />
      </div>
      <p class="mt-2">{{ t('auth.tfaSetupInstrSecond') }}</p>
      <v-otp-input
        v-model:value="state.securityCode"
        :num-inputs="6"
        :should-auto-focus="true"
        input-classes="otp-input"
        input-type="number"
        separator="" />
      <w-btn
        class="w-full mt-4"
        push
        color="primary"
        :label="t(`auth.tfa.verifyToken`)"
        no-caps
        icon="la:sign-in-alt"
        @click="finishSetupTFA" />
    </template>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { useDark } from '@/composables/dark'
import { apiErrorMessage } from '@/helpers/apiError'
import { localizeError } from '@/helpers/localization'
import { formatRecoveryCodeInput, isValidTfaCode } from '@/helpers/tfaCode'
import { passwordStrengthScore } from '@/helpers/passwordStrength'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { isFollowableRedirectTarget } from '@/helpers/pageRedirect'
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser'
import VOtpInput from 'vue3-otp-input'

// COMPOSABLES

const dark = useDark()

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  strategies: [],
  selectedStrategyId: null,
  screen: 'login',
  username: '',
  password: '',
  securityCode: '',
  useRecoveryCode: false,
  recoveryCode: '',
  continuationToken: '',
  newName: '',
  newEmail: '',
  newPassword: '',
  newPasswordVerify: '',
  forgotEmail: '',
  resetToken: '',
  isTFAShown: false,
  isTFASetupShown: false,
  tfaQRImage: ''
})

// REFS

const loginEmailIpt = ref(null)
const forgotEmailIpt = ref(null)
const registerNameIpt = ref(null)
const changePwdCurrentIpt = ref(null)
const changePwdNewPwdIpt = ref(null)
const resetNewPwdIpt = ref(null)
const loginForm = ref(null)
const forgotForm = ref(null)
const registerForm = ref(null)
const changePwdForm = ref(null)
const resetPasswordForm = ref(null)

// COMPUTED

/*
  The two kinds of strategy this screen deals with, and they are drawn nothing alike: one is a username
  and a password typed here, the other is a button that leaves for the provider. Splitting them is also
  what stops a provider from being picked in the selector above the form, where it would then be asked
  for a password it has no use for.
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

const passwordStrength = computed(() => {
  if (state.newPassword.length < 8) {
    return {
      color: 'negative',
      label: t('common.password.weak')
    }
  } else {
    switch (passwordStrengthScore(state.newPassword)) {
      case 1:
        return {
          color: 'deep-orange-7',
          label: t('common.password.poor')
        }
      case 2:
        return {
          color: 'purple-7',
          label: t('common.password.average')
        }
      case 3:
        return {
          color: 'blue-7',
          label: t('common.password.good')
        }
      case 4:
        return {
          color: 'green-7',
          label: t('common.password.strong')
        }
      default:
        return {
          color: 'negative',
          label: t('common.password.weak')
        }
    }
  }
})

const canUsePasskeys = computed(() => {
  return browserSupportsWebAuthn()
})

/** Reformats the recovery code field as the user types, matching the server's display shape. */
const recoveryCodeInput = computed({
  get: () => state.recoveryCode,
  set: (val) => {
    state.recoveryCode = formatRecoveryCodeInput(val)
  }
})

// VALIDATION RULES

const loginUsernameValidation = [(val) => val.length > 0 || t('auth.errors.missingUsername')]

const loginPasswordValidation = [(val) => val.length > 0 || t('auth.errors.missingPassword')]

const userNameValidation = [
  (val) => val.length > 0 || t('auth.errors.missingName'),
  (val) => /^[^<>"]+$/.test(val) || t('auth.errors.invalidName')
]

const userEmailValidation = [
  (val) => val.length > 0 || t('auth.errors.missingEmail'),
  (val) => /^.+@.+\..+$/.test(val) || t('auth.errors.invalidEmail')
]

const userPasswordValidation = [
  (val) => val.length > 0 || t('auth.errors.missingPassword'),
  (val) => val.length >= 8 || t('auth.errors.passwordTooShort')
]

const userPasswordVerifyValidation = [
  (val) => val.length > 0 || t('auth.errors.missingVerifyPassword'),
  (val) => val === state.newPassword || t('auth.errors.passwordsNotMatch')
]

// METHODS

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
      state.screen = 'register'
      nextTick(() => {
        registerNameIpt.value.focus()
      })
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
      throw new Error('Invalid Screen')
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
 * Where a provider button goes: the backend builds the URL at the provider, because everything that
 * ties the answer back to this browser — `state`, `nonce`, the PKCE verifier — is generated there and
 * kept on the session.
 */
function authorizeUrl(str) {
  const params = new URLSearchParams({ siteId: siteStore.id })
  return `/_api/auth/${str.id}/authorize?${params.toString()}`
}

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
      state.securityCode = ''
      state.useRecoveryCode = false
      state.recoveryCode = ''
      state.screen = 'tfa'
      loading.hide()
      break
    }
    case 'setupTfa': {
      state.securityCode = ''
      state.useRecoveryCode = false
      state.recoveryCode = ''
      state.screen = 'tfasetup'
      state.tfaQRImage = resp.tfaQRImage
      loading.hide()
      break
    }
    case 'redirect': {
      /*
        Task 468 (feature 362) checked this side of the same staleness question logout() had: every
        code path that ends a successful sign-in -- the form (`login()`), TFA verification, and a
        just-completed registration -- funnels through this one `nextAction: 'redirect'` case, and
        every branch of it below calls `window.location.replace()`, a real browser navigation rather
        than a router push. That tears down and rebuilds the whole SPA from `bootstrap`, so the nav
        sidebar is never in a position to go stale here the way it could across logout -- there is no
        surviving Pinia state for it to go stale IN. The other kind of strategy (`redirectStrategies`,
        a provider button) never reaches this function at all: it leaves via a plain `<a>` to the
        backend's `/authorize` endpoint, which itself lands the browser back on a real page URL after
        the provider round trip -- also a full reload, never the SPA's router. Confirmed, not assumed:
        no fix needed on this side.
      */
      loading.show({
        message: t('auth.loginSuccess')
      })
      setTimeout(() => {
        /*
          `resp.redirect` is a group's `redirectOnLogin` (`models/users.ts`), validated server-side on
          the way in (`api/groups.ts`) -- but checked again here, the same defence-in-depth reasoning
          `api/authentication.ts#finishProviderLogin` applies server-side, against a row written before
          that validation existed. `javascript:…` parses as a valid `URL` with no error, so this cannot
          be a bare try/catch around `new URL()` -- it has to look at what scheme came back
          (OpenProject #1360/#2208, 2026-08-24 security audit §2, §9).
        */
        window.location.replace(
          resp.redirect && isFollowableRedirectTarget(resp.redirect) ? resp.redirect : '/'
        )
      }, 1000)
      break
    }
    default: {
      loading.hide()
      notify({
        type: 'negative',
        message: 'Unexpected Authentication Response'
      })
    }
  }
}

/**
 * LOGIN
 */
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
      },
      throwHttpErrors: (statusNumber) => statusNumber > 400 // Don't throw for 400
    }).json()
    if (resp.ok) {
      state.password = ''
      handleLoginResponse(resp)
    } else {
      throw new Error(resp.message || 'ERR_LOGIN_FAILED')
    }
  } catch (err) {
    console.warn(err)
    loading.hide()
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err), t)
    })
  }
}

/**
 * LOGIN WITH PASSKEY
 */
async function loginWithPasskey() {
  loading.show({
    message: t('auth.signingIn')
  })
  try {
    const respGen = await API_CLIENT.post(`sites/${siteStore.id}/auth/passkey/challenge`).json()
    if (!respGen?.ok) {
      throw new Error(respGen?.message || 'ERR_LOGIN_FAILED')
    }

    // -> No `useBrowserAutofill`: that fills a passkey into a form field the user is typing in, and
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
    // -> Dismissing the browser's passkey prompt is not a failure to report: the user asked for the
    //    prompt and then changed their mind, and is looking at the login form again either way
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
 * FORGOT PASSWORD
 *
 * Always shows the same generic message, whatever the backend actually did behind it -- an unknown
 * address, a strategy with resets turned off and a real match all answer the same 200. Branching this
 * on the response would turn the form into exactly the account-enumeration oracle it exists to avoid
 * being (see `POST /sites/:siteId/auth/forgotPassword`'s doc comment in `backend/api/authentication.ts`).
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
    const isFormValid = await registerForm.value.validate(true)
    if (!isFormValid) {
      throw new Error(t('auth.errors.register'))
    }
    const resp = await API_CLIENT.post(`sites/${siteStore.id}/auth/register`, {
      json: {
        strategyId: state.selectedStrategyId,
        name: state.newName,
        email: state.newEmail,
        password: state.newPassword
      },
      throwHttpErrors: (statusNumber) => statusNumber > 400 // Don't throw for 400
    }).json()
    if (resp.ok) {
      state.password = ''
      state.newPassword = ''
      state.newPasswordVerify = ''
      if (resp.nextAction === 'verify') {
        state.screen = 'registerCheckEmail'
        loading.hide()
      } else {
        await handleLoginResponse(resp)
      }
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

/**
 * CHANGE PASSWORD
 */
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
      },
      throwHttpErrors: (statusNumber) => statusNumber > 400 // Don't throw for 400
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

/**
 * RESET PASSWORD
 *
 * Where the token `detectResetToken()` (below) picks up off a forgot-password email link is spent:
 * exchanged for a new password. `resetPassword()` on the backend always finishes with the same
 * `afterLoginChecks()` every other successful auth attempt goes through -- an active 2FA still has to
 * be cleared first (`nextAction: 'provideTfa'`), but there is no "changed, now please sign in manually"
 * outcome for this route to ever answer, so -- like `changePwd()` above -- every success is simply
 * handed to `handleLoginResponse()` rather than branched here.
 */
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
      },
      throwHttpErrors: (statusNumber) => statusNumber > 400 // Don't throw for 400
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

/**
 * Send the security code for the login this panel is in the middle of.
 *
 * The continuation token is only cleared once the code is accepted: a mistyped one can be entered
 * again, up to the handful of attempts the server allows before it discards the token -- and the
 * same counter (`countTfaFailure` on the backend) applies whether the wrong entry was a 6-digit
 * TOTP code or a recovery code, since both go through this one call.
 *
 * `setup` never combines with a recovery code -- the toggle only renders on the `tfa` screen, never
 * `tfasetup` -- matching the backend, which refuses a recovery code mid-setup since none exist yet
 * for a secret that has not been activated.
 *
 * @param setup True on the setup screen, where a correct code also activates the new secret
 * @returns The login response, to be handed to `handleLoginResponse()`
 */
async function submitTFA(setup) {
  const isRecoveryCode = !setup && state.useRecoveryCode
  const code = isRecoveryCode ? state.recoveryCode : state.securityCode
  if (!isValidTfaCode(code, isRecoveryCode)) {
    throw new Error(t('auth.errors.tfaMissing'))
  }
  const resp = await API_CLIENT.put(`sites/${siteStore.id}/auth/tfa`, {
    json: {
      strategyId: state.selectedStrategyId,
      continuationToken: state.continuationToken,
      securityCode: code,
      setup
    }
  }).json()
  if (!resp?.ok) {
    throw new Error(resp?.message || 'ERR_LOGIN_FAILED')
  }
  state.continuationToken = ''
  state.securityCode = ''
  state.recoveryCode = ''
  return resp
}

/** Switches the `tfa` screen between the 6-digit authenticator field and the recovery code field. */
function toggleRecoveryCodeMode() {
  state.useRecoveryCode = !state.useRecoveryCode
  state.securityCode = ''
  state.recoveryCode = ''
}

/**
 * Report a failed 2FA attempt, and start the login over when there is nothing left to continue: an
 * expired token, or one the server has discarded after too many wrong codes, leaves this screen with
 * no way forward.
 */
async function handleTFAError(err) {
  const code = apiErrorMessage(err)
  loading.hide()
  notify({
    type: 'negative',
    message: localizeError(code, t)
  })
  if (code === 'ERR_INVALID_VALIDATION_TOKEN' || code === 'ERR_EXPIRED_VALIDATION_TOKEN') {
    state.continuationToken = ''
    state.securityCode = ''
    state.useRecoveryCode = false
    state.recoveryCode = ''
    state.password = ''
    switchTo('login')
  }
}

async function verifyTFA() {
  loading.show({
    message: t('auth.signingIn')
  })
  try {
    await handleLoginResponse(await submitTFA(false))
  } catch (err) {
    await handleTFAError(err)
  }
}

/**
 * FINISH TFA SETUP
 */
async function finishSetupTFA() {
  loading.show({
    message: t('auth.tfaSetupVerifying')
  })
  try {
    const resp = await submitTFA(true)
    notify({
      type: 'positive',
      message: t('auth.tfaSetupSuccess')
    })
    await handleLoginResponse(resp)
  } catch (err) {
    await handleTFAError(err)
  }
}

// MOUNTED

onMounted(async () => {
  await fetchStrategies()
  reportRedirectLoginError()
  reportVerifiedSuccess()
  detectResetToken()
})

/**
 * Say what went wrong on a login that happened somewhere else.
 *
 * A provider login fails at the callback route, which has a browser to redirect and no request to
 * answer — so it puts the reason in the URL and this puts it in front of the reader. Taken out of the
 * address bar afterwards, so that reloading the page does not report it a second time.
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

/**
 * Say a mailed verification link succeeded.
 *
 * `GET /auth/verify/:token` redirects here with `?verified=true` on success -- taken out of the
 * address bar afterwards for the same reason as `error` above: a reload should not repeat the toast.
 */
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
 * Pick up a password-reset token off the URL and switch straight to the reset screen.
 *
 * `mail.ts`'s forgot-password email points at `/login/reset-password/:token` -- a path segment
 * rather than a query string, so this reads `window.location.pathname` rather than following
 * `reportVerifiedSuccess()`'s `URLSearchParams` pattern above.
 */
function detectResetToken() {
  const match = window.location.pathname.match(/^\/login\/reset-password\/([^/]+)\/?$/)
  if (!match) {
    return
  }
  state.resetToken = decodeURIComponent(match[1])
  switchTo('reset')
}
</script>
