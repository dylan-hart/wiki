<template>
  <div>
    <template v-if="props.screen === `tfa`">
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
    <template v-else-if="props.screen === `tfasetup`">
      <p>{{ t('auth.tfaSetupTitle') }}</p>
      <p>{{ t('auth.tfaSetupInstrFirst') }}</p>
      <div style="justify-content: center; display: flex">
        <div v-html="props.qrImage" style="width: 200px" />
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
