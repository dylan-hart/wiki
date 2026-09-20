<template>
  <div>
    <template v-if="props.screen === `tfa`">
      <p class="auth-subtitle">{{ t('auth.tfa.subtitle') }}</p>
      <div v-if="!state.useRecoveryCode" class="auth-otp">
        <w-otp-input v-model="state.securityCode" :length="6" autofocus @complete="verifyTFA" />
      </div>
      <!--
        The placeholder shows the code's format rather than the field's name, so the name has to
        live on `aria-label`, as it does on every other field on these screens.
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
        color="accent"
        size="13.5px"
        padding="9.5px 16px"
        :label="t(`auth.tfa.verifyToken`)"
        icon="tabler:login"
        @click="verifyTFA" />
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
    <template v-else-if="props.screen === `tfasetup`">
      <p class="auth-notice auth-notice--lead">{{ t('auth.tfaSetupTitle') }}</p>
      <p class="auth-subtitle">{{ t('auth.tfaSetupInstrFirst') }}</p>
      <div class="flex justify-center">
        <div class="auth-qr" v-html="props.qrImage" />
      </div>
      <p class="auth-subtitle mt-3">{{ t('auth.tfaSetupInstrSecond') }}</p>
      <div class="auth-otp auth-otp--sm">
        <w-otp-input v-model="state.securityCode" :length="6" autofocus />
      </div>
      <w-btn
        class="w-full mt-4"
        color="accent"
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
  },
  continuationToken: {
    type: String,
    default: ''
  },
  /** An `<svg>` string as the server rendered it, not a URL. */
  qrImage: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['login-response', 'restart'])

const state = reactive({
  securityCode: '',
  useRecoveryCode: false,
  recoveryCode: ''
})

const recoveryCodeInput = computed({
  get: () => state.recoveryCode,
  set: (val) => {
    state.recoveryCode = formatRecoveryCodeInput(val)
  }
})

/**
 * `setup` never combines with a recovery code: the toggle renders only on the `tfa` screen, and
 * the backend refuses one mid-setup since none exist yet for an unactivated secret. A wrong code
 * leaves the continuation token usable until the server's own attempt counter discards it.
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

function toggleRecoveryCodeMode() {
  state.useRecoveryCode = !state.useRecoveryCode
  state.securityCode = ''
  state.recoveryCode = ''
}

/** The server discards the continuation token after too many wrong codes, leaving no way forward. */
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

<style scoped>
/*
  Overridden here rather than at `css/tailwind.css`'s `.otp-input` default: `SetupTfaDialog.vue`
  uses the same class on an undesigned surface and should not silently inherit this screen's
  treatment. A scoped `:deep()` rule is unlayered, so it beats `@layer components` without
  `!important`.
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
  border: 1px solid var(--color-hairline);
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 500;
  color: var(--color-ink);
}

.auth-otp--sm :deep(.otp-input) {
  height: 44px;
  font-size: 18px;
}

.auth-otp :deep(.otp-input:focus),
.auth-otp :deep(.otp-input:focus-visible) {
  border-color: var(--color-accent-fill);
  outline: none;
}

/* -> Neutralises the library's own `is-complete` green: a filled digit should read as ordinary */
.auth-otp :deep(.otp-input.is-complete) {
  border-color: var(--color-hairline);
}

:global(body.body--dark .auth-otp .otp-input) {
  border-color: var(--color-hairline-dark);
  color: var(--color-text-dark);
}

:global(body.body--dark .auth-otp .otp-input.is-complete) {
  border-color: var(--color-hairline-dark);
}

/*
  The padding is the QR's quiet zone. The server hands back an `<svg>` string, so the sizing has to
  reach through to whatever element it produced rather than sitting on it.
*/
.auth-qr {
  width: 150px;
  height: 150px;
  padding: 10px;
  border: 1px solid var(--color-hairline);
  background-color: var(--color-surface);
  box-sizing: border-box;
}

.auth-qr :deep(svg),
.auth-qr :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
}

:global(body.body--dark .auth-qr) {
  border-color: var(--color-hairline-dark);
}
</style>
