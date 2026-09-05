<template>
  <w-dialog
    v-model="dialogVisible"
    persistent
    :aria-label="t(`profile.authSetTfa`)"
    @hide="onDialogHide">
    <w-card style="min-width: 450px">
      <w-card-section class="card-header">
        <w-icon name="tabler:list-numbers" size="sm" class="me-2" />
        <span>{{ t(`profile.authSetTfa`) }}</span>
      </w-card-section>
      <template v-if="!state.isInit">
        <w-linear-progress query color="positive" />
        <w-card-section class="text-center text-grey">
          {{ t(`profile.authSetTfaLoading`) }}
        </w-card-section>
      </template>
      <template v-else-if="state.step === `verify`">
        <w-card-section class="relative text-center">
          <p>{{ t('auth.tfaSetupInstrFirst') }}</p>
          <div style="justify-content: center; display: flex">
            <!-- eslint-disable-next-line vue/no-v-html -- server-generated QR code SVG -->
            <div v-html="state.tfaQRImage" style="width: 200px" />
          </div>
          <!--
            The same secret in text, for an authenticator app that is not on the device showing this,
            or a user who would rather type it than point a camera at the screen. Grouped in fours to
            be readable; the copy button copies it without the spaces.
          -->
          <div class="mt-2 text-caption text-grey">{{ t('auth.tfaSetupInstrManual') }}</div>
          <div class="mt-1 flex items-center justify-center gap-2">
            <code class="rounded bg-black/6 px-2 py-1 font-mono text-body2 dark:bg-white/10">{{
              groupedSecret
            }}</code>
            <w-btn
              class="acrylic-btn"
              flat
              dense
              icon="la:copy"
              :aria-label="t(`common.actions.copy`)"
              color="primary"
              @click="copySecret" />
          </div>
          <p class="mt-4">{{ t('auth.tfaSetupInstrSecond') }}</p>
          <div class="flex flex-wrap justify-center">
            <v-otp-input
              v-model:value="state.securityCode"
              :num-inputs="6"
              :should-auto-focus="true"
              input-classes="otp-input"
              input-type="number"
              separator="" />
          </div>
          <w-inner-loading :showing="state.isLoading" />
        </w-card-section>
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
            :label="t(`auth.tfa.verifyToken`)"
            color="primary"
            padding="xs md"
            :loading="state.isLoading"
            @click="save" />
        </w-card-actions>
      </template>
      <!--
        2FA is already active by this point -- the codes step only shows what `save()` got back and
        cannot fail the way the code entry above can, so it gets no loading/error handling of its own.
      -->
      <template v-else>
        <w-card-section class="text-center">
          <p>{{ t('profile.tfaRecoveryCodes') }}</p>
          <recovery-codes-display
            v-model:acknowledged="state.acknowledged"
            :codes="state.recoveryCodes" />
        </w-card-section>
        <w-card-actions class="card-actions">
          <w-space />
          <w-btn
            :label="t(`common.actions.close`)"
            color="primary"
            padding="xs md"
            @click="attemptFinish" />
        </w-card-actions>
      </template>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { confirm, dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { copyToClipboard } from '@/helpers/clipboard'
import { localizeError } from '@/helpers/localization'
import { computed, onMounted, reactive } from 'vue'

import VOtpInput from 'vue3-otp-input'
import RecoveryCodesDisplay from '@/components/RecoveryCodesDisplay.vue'

// PROPS

const props = defineProps({
  strategyId: {
    type: String,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  isInit: false,
  isLoading: false,
  /** `verify` (entering the code) then `codes` (showing the recovery codes issued on activation). */
  step: 'verify',
  securityCode: '',
  tfaQRImage: '',
  tfaSecret: '',
  continuationToken: '',
  recoveryCodes: [],
  acknowledged: false
})

// COMPUTED

/** The secret in groups of four, which is how a 32-character string stays readable to type. */
const groupedSecret = computed(() => state.tfaSecret.replace(/.{4}(?=.)/g, '$& '))

// METHODS

async function copySecret() {
  try {
    // -> Without the display grouping: a space is harmless in most authenticator apps, but not all
    await copyToClipboard(state.tfaSecret)
    notify({
      type: 'positive',
      message: t('auth.tfaSetupKeyCopied')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('auth.tfaSetupKeyCopyFailed'),
      caption: err.message
    })
  }
}

async function load() {
  state.isInit = false
  try {
    const resp = await API_CLIENT.post('users/profile/tfa', {
      json: {
        strategyId: props.strategyId
      }
    }).json()
    state.continuationToken = resp.continuationToken
    state.tfaQRImage = resp.tfaQRImage
    state.tfaSecret = resp.tfaSecret
    state.isInit = true
  } catch (err) {
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err, 'An unexpected error occured.'), t)
    })
    onDialogCancel()
  }
}

async function save() {
  state.isLoading = true
  try {
    if (!/^[0-9]{6}$/.test(state.securityCode)) {
      throw new Error(t('auth.errors.tfaMissing'))
    }
    const resp = await API_CLIENT.put('users/profile/tfa', {
      json: {
        strategyId: props.strategyId,
        continuationToken: state.continuationToken,
        securityCode: state.securityCode
      }
    }).json()
    state.continuationToken = ''
    state.securityCode = ''
    notify({
      type: 'positive',
      message: t('auth.tfaSetupSuccess')
    })
    if (resp.recoveryCodes?.length > 0) {
      // -> The one and only time these are ever shown; move to the codes step rather than closing
      state.recoveryCodes = resp.recoveryCodes
      state.step = 'codes'
    } else {
      onDialogOK()
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: localizeError(apiErrorMessage(err, t('auth.errors.loginError')), t)
    })
  }
  state.isLoading = false
}

/**
 * The codes step is the only place these codes are ever shown -- closing before the user copied or
 * downloaded them throws them away for good, so a close attempt before either happened is confirmed
 * rather than silent. 2FA is already active on the account by this point either way, hence `onDialogOK`
 * in both branches: unlike the verify step above, there is no unsaved setup left to discard.
 */
function attemptFinish() {
  if (state.acknowledged) {
    onDialogOK()
    return
  }
  confirm({
    title: t('common.actions.confirm'),
    message: t('profile.tfaRecoveryCodesCloseWarn'),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.close')
  }).onOk(() => {
    onDialogOK()
  })
}

onMounted(() => {
  load()
})
</script>
