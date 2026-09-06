<template>
  <div>
    <template v-if="props.screen === `tfa`">
      <p class="auth-subtitle">{{ t('auth.tfa.subtitle') }}</p>
      <div v-if="!state.useRecoveryCode" class="auth-otp">
        <v-otp-input
          v-model:value="state.securityCode"
          :num-inputs="6"
          :should-auto-focus="true"
          input-classes="otp-input"
          input-type="number"
          separator=""
          @on-complete="verifyTFA" />
      </div>
      <!--
        The design draws no recovery-code field at all -- it covers the six-digit state only -- so
        this keeps the format placeholder, which says something the field's own name does not, and
        moves the name onto `aria-label` the way every other field on these screens now does.
      -->
      <w-input
        v-else
        v-model="recoveryCodeInput"
        autofocus
        class="auth-field auth-field--sm mt-2"
        :aria-label="t(`auth.tfa.recoveryCodeLabel`)"
        :hint="t(`auth.tfa.recoveryCodeHint`)"
        placeholder="XXXX-XXXX-XXXX-XXXX"
        @keyup:enter="verifyTFA" />
      <w-btn
        class="w-full mt-4"
        color="primary"
        size="13.5px"
        padding="9.5px 16px"
        :label="t(`auth.tfa.verifyToken`)"
        icon="tabler:login"
        @click="verifyTFA" />
      <!--
        The alternative to the six digits is a plain line of type, not a second button: the design
        gives it no fill, no border and no glyph, so it does not compete with Verify above it.
      -->
      <w-btn
        class="w-full mt-1.5"
        flat
        color="text-secondary"
        size="12.5px"
        padding="7px 8px"
        :label="
          state.useRecoveryCode ? t('auth.tfa.useSecurityCode') : t('auth.tfa.useRecoveryCode')
        "
        @click="toggleRecoveryCodeMode" />
    </template>
    <!-- ----------------------------------------------------- -->
    <!-- TFA SETUP SCREEN -->
    <!-- ----------------------------------------------------- -->
    <template v-else-if="props.screen === `tfasetup`">
      <!--
        The design leads with the requirement in bold and then two ordinary instruction lines; the QR
        is a 150px hairline-framed plate rather than a bare 200px SVG dropped into the flow.
      -->
      <p class="auth-notice auth-notice--lead">{{ t('auth.tfaSetupTitle') }}</p>
      <p class="auth-subtitle">{{ t('auth.tfaSetupInstrFirst') }}</p>
      <div class="flex justify-center">
        <div class="auth-qr" v-html="props.qrImage" />
      </div>
      <p class="auth-subtitle mt-3">{{ t('auth.tfaSetupInstrSecond') }}</p>
      <div class="auth-otp auth-otp--sm">
        <v-otp-input
          v-model:value="state.securityCode"
          :num-inputs="6"
          :should-auto-focus="true"
          input-classes="otp-input"
          input-type="number"
          separator="" />
      </div>
      <w-btn
        class="w-full mt-4"
        color="primary"
        size="13.5px"
        padding="9.5px 16px"
        :label="t(`auth.tfa.verifyToken`)"
        icon="tabler:login"
        @click="finishSetupTFA" />
    </template>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, reactive } from 'vue'

import { loading } from '@/composables/loading'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { localizeError } from '@/helpers/localization'
import { formatRecoveryCodeInput, isValidTfaCode } from '@/helpers/tfaCode'

import { useSiteStore } from '@/stores/site'

import VOtpInput from 'vue3-otp-input'

/**
 * The two-factor screens of `AuthLoginPanel.vue`: entering a code to finish a sign-in (`tfa`, with
 * the recovery-code alternative), and entering one to activate a newly-issued secret (`tfasetup`).
 *
 * Split out of the panel because the code being typed is theirs alone -- no other screen reads it --
 * and everything they need from the sign-in attempt is the strategy and the continuation token that
 * identify it. The panel is keyed on `screen`, so moving between the two remounts this with the
 * fields empty, which is what the panel used to clear them by hand for.
 */

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// PROPS

const props = defineProps({
  /** Which of the two screens to draw: `tfa` or `tfasetup`. */
  screen: {
    type: String,
    required: true
  },
  /** The strategy the sign-in attempt was made against. */
  strategyId: {
    type: String,
    default: null
  },
  /** The token that ties this code back to that attempt. */
  continuationToken: {
    type: String,
    default: ''
  },
  /** The `tfasetup` screen's QR image, as the server rendered it. */
  qrImage: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['login-response', 'restart'])

// DATA

const state = reactive({
  securityCode: '',
  useRecoveryCode: false,
  recoveryCode: ''
})

// COMPUTED

/** Reformats the recovery code field as the user types, matching the server's display shape. */
const recoveryCodeInput = computed({
  get: () => state.recoveryCode,
  set: (val) => {
    state.recoveryCode = formatRecoveryCodeInput(val)
  }
})

// METHODS

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
 * @returns The login response, for the panel's own `handleLoginResponse()`
 */
async function submitTFA(setup) {
  const isRecoveryCode = !setup && state.useRecoveryCode
  const code = isRecoveryCode ? state.recoveryCode : state.securityCode
  if (!isValidTfaCode(code, isRecoveryCode)) {
    throw new Error(t('auth.errors.tfaMissing'))
  }
  const resp = await API_CLIENT.put(`sites/${siteStore.id}/auth/tfa`, {
    json: {
      strategyId: props.strategyId,
      continuationToken: props.continuationToken,
      securityCode: code,
      setup
    }
  }).json()
  if (!resp?.ok) {
    throw new Error(resp?.message || 'ERR_LOGIN_FAILED')
  }
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
    state.securityCode = ''
    state.useRecoveryCode = false
    state.recoveryCode = ''
    // -> Nothing left to continue with. The panel owns the continuation token and the password
    //    typed into its own login form, so it is the one that clears them and puts that screen back.
    emit('restart')
  }
}

async function verifyTFA() {
  loading.show({
    message: t('auth.signingIn')
  })
  try {
    emit('login-response', await submitTFA(false))
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
    emit('login-response', resp)
  } catch (err) {
    await handleTFAError(err)
  }
}
</script>

<style scoped lang="scss">
/*
  The digit row, re-dressed for the auth panel.

  `css/tailwind.css`'s `.otp-input` is the app-wide default `vue3-otp-input` takes -- a fixed
  3rem square with a 2px `rgba(0,0,0,.2)` edge, 4px side margins, and a GREEN edge once a digit is
  entered. `Cardinal Wiki - Auth Screens 3x.dc.html` draws something else: six boxes that share the
  row's full width (`flex:1`), separated by an 8px gap rather than by margins, in a 1px hairline, and
  with the accent on the box being typed into rather than the ones already filled -- "here" instead
  of "done".

  Overridden here rather than at source deliberately. The design file covers the LOGIN panel's 2FA;
  `SetupTfaDialog.vue` (the profile's own 2FA activation) uses the same class on an undesigned
  surface and should not silently inherit this screen's treatment. A scoped `:deep()` rule is
  unlayered, so it beats `@layer components` without needing `!important`.
*/
.auth-otp :deep(.otp-input-container) {
  display: flex;
  gap: 8px;
  flex-wrap: nowrap;
  justify-content: space-between;
}

.auth-otp :deep(.otp-input) {
  flex: 1;
  width: auto;
  min-width: 0;
  height: 48px;
  margin: 0;
  border: 1px solid $hairline;
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 500;
  color: $ink;
}

/* -> The setup screen's row is one step shorter than the sign-in screen's */
.auth-otp--sm :deep(.otp-input) {
  height: 44px;
  font-size: 18px;
}

/* -> The box being typed into, which is the one the design marks */
.auth-otp :deep(.otp-input:focus),
.auth-otp :deep(.otp-input:focus-visible) {
  border-color: $accent-fill;
  outline: none;
}

/*
  A filled digit reads as ordinary: the library's own `is-complete` class is what painted five green
  boxes and left the one still wanted looking the same as an empty one.
*/
.auth-otp :deep(.otp-input.is-complete) {
  border-color: $hairline;
}

:global(body.body--dark .auth-otp .otp-input) {
  border-color: $hairline-dark;
  color: $text-dark;
}

:global(body.body--dark .auth-otp .otp-input.is-complete) {
  border-color: $hairline-dark;
}

/*
  The QR plate. 150px inside a hairline frame with 10px of quiet zone, as the design draws it -- the
  server hands back an `<svg>` string, so the sizing has to reach through to whatever element it
  produced rather than sitting on it.
*/
.auth-qr {
  width: 150px;
  height: 150px;
  padding: 10px;
  border: 1px solid $hairline;
  background-color: $surface;
  box-sizing: border-box;
}

.auth-qr :deep(svg),
.auth-qr :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
}

:global(body.body--dark .auth-qr) {
  border-color: $hairline-dark;
}
</style>
