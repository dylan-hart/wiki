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
            :key="str.id"
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
          v-if="selectedStrategy.activeStrategy.selfRegistration"
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
    <!-- REGISTER SCREENS -->
    <!-- ----------------------------------------------------- -->
    <auth-register-screen
      v-else-if="[`register`, `registerCheckEmail`].includes(state.screen)"
      :screen="state.screen"
      :strategy-id="state.selectedStrategyId"
      @registered="finishRegistration"
      @back-to-login="switchTo(`login`)" />
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
    <!-- TWO-FACTOR SCREENS -->
    <!-- ----------------------------------------------------- -->
    <!--
      Keyed on the screen so that moving between the two remounts it with empty fields -- which is
      what this panel used to clear by hand in `handleLoginResponse` before the screens moved out.
    -->
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
import { passwordStrengthBadge } from '@/helpers/passwordStrength'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { isFollowableRedirectTarget } from '@/helpers/pageRedirect'
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser'

import AuthRegisterScreen from '@/components/AuthRegisterScreen.vue'
import AuthTfaScreens from '@/components/AuthTfaScreens.vue'

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
  continuationToken: '',
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
const changePwdCurrentIpt = ref(null)
const changePwdNewPwdIpt = ref(null)
const resetNewPwdIpt = ref(null)
const loginForm = ref(null)
const forgotForm = ref(null)
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

const passwordStrength = computed(() => passwordStrengthBadge(state.newPassword, t))

const canUsePasskeys = computed(() => {
  return browserSupportsWebAuthn()
})

// VALIDATION RULES

const loginUsernameValidation = [(val) => val.length > 0 || t('auth.errors.missingUsername')]

const loginPasswordValidation = [(val) => val.length > 0 || t('auth.errors.missingPassword')]

const userEmailValidation = emailRules(t)

const userPasswordValidation = passwordRules(t)

const userPasswordVerifyValidation = passwordVerifyRules(t, () => state.newPassword)

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
      // -> No focus call: `AuthRegisterScreen` mounts with this screen and focuses its own first
      //    field, which is the same moment this used to reach for it on.
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
 * Where a provider button goes: the backend builds the URL at the provider, because everything that
 * ties the answer back to this browser — `state`, `nonce`, the PKCE verifier — is generated there and
 * kept on the session.
 *
 * No `redirect` param is set here: this used to be read off a `loginRedirect` cookie, but nothing in
 * this app ever wrote one (OpenProject #2208 §9 -- confirmed by grep, not assumed), so it was a dead
 * read of a value that could only ever come from something else able to set a cookie on this wiki's
 * registrable domain. The backend's own `GET /_api/auth/:strategyId/authorize` already defaults an
 * absent `redirect` to `/`, and validates one that IS given (`helpers/redirectTarget.ts`) -- so
 * dropping this rather than reintroducing a writer is the "where I was going" memory this component
 * loses, not a regression in what a caller can still ask for explicitly via a query param of its own.
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
          `api/auth/provider.ts#finishProviderLogin` applies server-side, against a row written before
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
        message: t('auth.errors.unexpectedResponse')
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
      }
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
 * being (see `POST /sites/:siteId/auth/forgotPassword`'s doc comment in `backend/api/auth/site.ts`).
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
 * A registration the server accepted. Where it goes next is the same question every other successful
 * auth attempt asks -- either the account still has to be activated from an emailed link, in which
 * case there is no session to establish yet, or it is a login like any other and goes to the same
 * response handler. The login form's own password field is cleared here because it belongs to that
 * form, not to the one that just registered.
 */
function finishRegistration(resp) {
  state.password = ''
  if (resp.nextAction === 'verify') {
    state.screen = 'registerCheckEmail'
    loading.hide()
  } else {
    handleLoginResponse(resp)
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

/**
 * 2FA could not continue: an expired continuation token, or one the server discarded after too many
 * wrong codes. Nothing is left to go on with, so the login starts over from this panel's own screen.
 */
function restartAfterTfa() {
  state.continuationToken = ''
  state.password = ''
  switchTo('login')
}

// MOUNTED

onMounted(async () => {
  /*
    Ahead of `fetchStrategies()`'s network round trip, not after it: `detectResetToken()` only reads
    `window.location.pathname` and needs nothing it fetches, so running it first lets the caret land
    on first paint rather than waiting on a response. Guarded on `state.screen` staying `login`
    afterwards -- a reset-password link switches screens itself (and focuses its own field via
    `switchTo()`), and this would otherwise steal focus right back.
  */
  detectResetToken()
  if (state.screen === 'login') {
    nextTick(() => {
      loginEmailIpt.value?.focus()
    })
  }
  await fetchStrategies()
  reportRedirectLoginError()
  reportVerifiedSuccess()
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
