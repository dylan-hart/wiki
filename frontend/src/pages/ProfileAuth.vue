<template>
  <w-page>
    <h1 class="w-section-header">{{ t('profile.auth') }}</h1>
    <div class="p-4">
      <div class="text-body2">{{ t('profile.authInfo') }}</div>
      <!--
        `img:` rather than a Tabler reference: what identifies a row here is the provider's own
        logo, served as a file.
      -->
      <w-settings-card class="mt-4" :title="t('profile.auth')">
        <w-settings-row
          v-for="auth of state.authMethods"
          :key="auth.id"
          control-width="auto"
          :icon="`img:` + auth.strategyIcon"
          :label="auth.authName">
          <template #hint>
            <div v-if="!auth.config.isPasswordLoginEnabled" class="text-negative">
              {{ t('profile.authPasswordLoginOff') }}
            </div>
            <!--
              A disabled button with no reason next to it reads as a bug. This is the reason: the
              server refuses to turn password login off while it is the only way into the account.
            -->
            <div
              v-else-if="auth.strategyKey === `local` && !auth.config.canDisablePasswordLogin"
              class="text-grey">
              {{ t('profile.authPasswordLoginOnlyMethod') }}
            </div>
            <!--
              Absent while the status fetch is in flight and on a failed one: a nudge on top of an
              auth-methods list that already rendered does not earn an error state of its own.
            -->
            <template v-if="auth.config.isTfaSetup && state.recoveryCodesStatus[auth.authId]">
              <div :class="isRecoveryCodesLow(auth.authId) ? 'text-negative' : 'text-grey-7'">
                {{
                  t('profile.tfaRecoveryCodesRemaining', {
                    remaining: state.recoveryCodesStatus[auth.authId].remaining,
                    total: state.recoveryCodesStatus[auth.authId].total
                  })
                }}
              </div>
              <div v-if="isRecoveryCodesLow(auth.authId)" class="text-negative">
                {{ t('profile.tfaRecoveryCodesLow') }}
              </div>
            </template>
          </template>
          <!--
            One trigger rather than a row of buttons: the settings row keeps its whole control
            column on one line, and these are occasional actions.
          -->
          <template v-if="auth.strategyKey === `local`">
            <div class="flex items-center gap-3">
              <!--
                Shown only when 2FA is on: its absence is not a warning, since 2FA is optional
                unless an administrator requires it.
              -->
              <w-badge
                v-if="auth.config.isTfaSetup"
                class="gap-1"
                color="positive"
                rounded
                :title="t('profile.authTfaActive')">
                <w-icon name="tabler:check" />
                <span>{{ t('profile.authTfaBadge') }}</span>
              </w-badge>
              <!--
                `acrylic-btn` mixes its background out of `currentcolor`, so the tint follows the
                button's own colour with nothing further to set.
              -->
              <w-btn
                class="acrylic-btn"
                flat
                icon="tabler:settings"
                color="primary"
                :aria-label="t(`profile.authActions`)">
                <w-menu class="translucent-menu" auto-close anchor="bottom right" self="top right">
                  <!--
                  `!min-w-0 !pe-2`: an avatar section is sized for a 40px avatar in a list row, far
                  too much air beside a menu icon. Both rules are WItemSection scoped styles, hence
                  `!` -- a layered utility cannot outrank them.

                  The colours are literal classes, `dark:` counterparts included, rather than
                  WIcon's `color` prop or a `dark.isActive` conditional: that prop builds
                  `text-${color}` at runtime, and Tailwind only emits a utility it can see spelled
                  out in the source.
                -->
                  <w-list dense padding style="min-width: 240px">
                    <w-item
                      v-if="auth.config?.canChangePassword !== false"
                      clickable
                      @click="changePassword(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:key" class="text-blue-7 dark:text-blue-4" />
                      </w-item-section>
                      <w-item-section>{{ t('profile.authChangePassword') }}</w-item-section>
                    </w-item>
                    <w-item
                      v-if="auth.config.isTfaSetup"
                      clickable
                      @click="disableTfa(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:fingerprint" class="text-blue-7 dark:text-blue-4" />
                      </w-item-section>
                      <w-item-section>{{ t('profile.authDisableTfa') }}</w-item-section>
                    </w-item>
                    <w-item v-else clickable @click="setupTfa(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:fingerprint" class="text-blue-7 dark:text-blue-4" />
                      </w-item-section>
                      <w-item-section>{{ t('profile.authSetTfa') }}</w-item-section>
                    </w-item>
                    <w-item
                      v-if="auth.config.isTfaSetup"
                      clickable
                      @click="regenerateRecoveryCodes(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:key" class="text-blue-7 dark:text-blue-4" />
                      </w-item-section>
                      <w-item-section>{{ t('profile.tfaRecoveryCodesRegenerate') }}</w-item-section>
                    </w-item>
                    <w-separator class="my-2" />
                    <w-item
                      v-if="auth.config.isPasswordLoginEnabled"
                      clickable
                      :disabled="!auth.config.canDisablePasswordLogin"
                      @click="disablePasswordLogin(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:ban" class="text-negative dark:text-accent-dark" />
                      </w-item-section>
                      <w-item-section class="text-negative">
                        {{ t('profile.authDisablePasswordLogin') }}
                      </w-item-section>
                    </w-item>
                    <w-item v-else clickable @click="enablePasswordLogin(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon
                          name="tabler:arrow-forward-up"
                          class="text-blue-7 dark:text-blue-4" />
                      </w-item-section>
                      <w-item-section>{{ t('profile.authEnablePasswordLogin') }}</w-item-section>
                    </w-item>
                  </w-list>
                </w-menu>
              </w-btn>
            </div>
          </template>
        </w-settings-row>
      </w-settings-card>

      <div class="text-body2 mt-6">{{ t('profile.passkeysIntro') }}</div>
      <!--
        Drawn only once there is a passkey to put in it: an empty settings card is a header strip
        over nothing, and the intro above and the Add button below already say what to do.
      -->
      <w-settings-card
        v-if="state.passkeys?.length > 0"
        class="mt-4"
        :title="t('profile.passkeys')">
        <w-settings-row
          v-for="pkey of state.passkeys"
          :key="pkey.id"
          control-width="auto"
          icon="tabler:key"
          :label="pkey.name">
          <template #hint>
            <div>{{ pkey.siteHostname }}</div>
            <div class="text-grey-7">{{ humanizeDate(t, pkey.createdAt) }}</div>
          </template>
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:trash"
            :aria-label="t(`common.actions.delete`)"
            color="negative"
            @click="deactivatePasskey(pkey)" />
        </w-settings-row>
      </w-settings-card>
      <div v-if="state.passkeysEnabled" class="mt-4">
        <w-btn
          icon="tabler:plus"
          :label="t(`profile.passkeysAdd`)"
          color="primary"
          @click="setupPasskey" />
      </div>
    </div>

    <w-inner-loading :showing="state.loading > 0" />
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'
import { profileSaving } from '@/composables/profileSaving'
import { confirm, dialog } from '@/composables/dialog'
import { onMounted, reactive } from 'vue'
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser'
import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { localizeError } from '@/helpers/localization'

import ChangePwdDialog from '@/components/ChangePwdDialog.vue'
import SetupTfaDialog from '@/components/SetupTfaDialog.vue'
import RecoveryCodesDialog from '@/components/RecoveryCodesDialog.vue'
import PasskeyCreateDialog from '@/components/PasskeyCreateDialog.vue'

const { t } = useI18n()

useMeta(() => ({
  title: t('profile.auth')
}))

const state = reactive({
  authMethods: [],
  passkeys: [],
  passkeysEnabled: true,
  // -> Keyed by authId, one entry per local strategy with 2FA active. An absent entry means either
  //    not applicable or a failed status fetch, and both render the same: no remaining-count line.
  recoveryCodesStatus: {},
  loading: 0
})

async function fetchAuthMethods() {
  state.loading++
  try {
    const resp = await API_CLIENT.get('users/profile/auth').json()
    state.authMethods = resp?.authMethods ?? []
    state.passkeys = resp?.passkeys ?? []
    state.passkeysEnabled = resp?.passkeysEnabled !== false
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.authLoadingFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--

  await fetchRecoveryCodesStatuses()
}

/**
 * Kept out of `fetchAuthMethods()`'s own try/catch: a failure here stays silent, since the
 * remaining-count line is a nudge on top of a list that already rendered, not its own error toast.
 */
async function fetchRecoveryCodesStatuses() {
  const tfaMethods = state.authMethods.filter(
    (auth) => auth.strategyKey === 'local' && auth.config?.isTfaSetup
  )
  await Promise.all(
    tfaMethods.map(async (auth) => {
      try {
        const resp = await API_CLIENT.get('users/profile/tfa/recovery-codes', {
          searchParams: { strategyId: auth.authId }
        }).json()
        if (resp?.ok) {
          state.recoveryCodesStatus[auth.authId] = { total: resp.total, remaining: resp.remaining }
        }
      } catch {
        // -> Silent by design: the count is a nudge, not a blocker.
      }
    })
  )
}

function isRecoveryCodesLow(authId) {
  const status = state.recoveryCodesStatus[authId]
  if (!status || status.total <= 0) {
    return false
  }
  return status.remaining / status.total <= 0.2
}

function changePassword(strategyId) {
  dialog({
    component: ChangePwdDialog,
    componentProps: {
      strategyId
    }
  })
}

function disableTfa(strategyId) {
  confirm({
    title: t('common.actions.confirm'),
    message: t('profile.authDisableTfaConfirm'),
    cancel: true,
    color: 'negative',
    okLabel: t('profile.authDisableTfa')
  }).onOk(async () => {
    loading.show()
    profileSaving.begin()
    try {
      await API_CLIENT.delete(`users/profile/tfa/${strategyId}`)
      notify({
        type: 'positive',
        message: t('profile.authDisableTfaSuccess')
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('profile.authDisableTfaFailed'),
        caption: localizeError(apiErrorMessage(err), t)
      })
    }
    await fetchAuthMethods()
    loading.hide()
    profileSaving.end()
  })
}

function disablePasswordLogin(strategyId) {
  confirm({
    title: t('common.actions.confirm'),
    message: t('profile.authDisablePasswordLoginConfirm'),
    cancel: true,
    color: 'negative',
    okLabel: t('profile.authDisablePasswordLogin')
  }).onOk(() => setPasswordLogin(strategyId, false))
}

function enablePasswordLogin(strategyId) {
  setPasswordLogin(strategyId, true)
}

async function setPasswordLogin(strategyId, isEnabled) {
  loading.show()
  profileSaving.begin()
  try {
    await API_CLIENT.put('users/profile/password-login', {
      json: {
        strategyId,
        isEnabled
      }
    }).json()
    notify({
      type: 'positive',
      message: isEnabled
        ? t('profile.authEnablePasswordLoginSuccess')
        : t('profile.authDisablePasswordLoginSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: isEnabled
        ? t('profile.authEnablePasswordLoginFailed')
        : t('profile.authDisablePasswordLoginFailed'),
      caption: localizeError(apiErrorMessage(err), t)
    })
  }
  await fetchAuthMethods()
  loading.hide()
  profileSaving.end()
}

function setupTfa(strategyId) {
  dialog({
    component: SetupTfaDialog,
    componentProps: {
      strategyId
    }
  }).onOk(() => {
    fetchAuthMethods()
  })
}

function regenerateRecoveryCodes(strategyId) {
  confirm({
    title: t('common.actions.confirm'),
    message: t('profile.tfaRecoveryCodesRegenerateConfirm'),
    cancel: true,
    color: 'negative',
    okLabel: t('profile.tfaRecoveryCodesRegenerate')
  }).onOk(async () => {
    loading.show()
    profileSaving.begin()
    try {
      const resp = await API_CLIENT.post('users/profile/tfa/recovery-codes', {
        json: {
          strategyId
        }
      }).json()
      loading.hide()
      profileSaving.end()
      dialog({
        component: RecoveryCodesDialog,
        componentProps: {
          codes: resp.recoveryCodes
        }
      })
    } catch (err) {
      loading.hide()
      profileSaving.end()
      notify({
        type: 'negative',
        message: t('profile.tfaRecoveryCodesRegenerateFailed'),
        caption: localizeError(apiErrorMessage(err), t)
      })
    }
  })
}

async function setupPasskey() {
  profileSaving.begin()
  try {
    if (!browserSupportsWebAuthn()) {
      throw new Error(t('profile.passkeysUnsupported'))
    }
    loading.show()

    const genResp = await API_CLIENT.post('users/profile/passkeys/challenge').json()

    let attResp
    try {
      attResp = await startRegistration({ optionsJSON: genResp.registrationOptions })
    } catch (err) {
      if (err.name === 'InvalidStateError') {
        throw new Error(t('error.ERR_PK_ALREADY_REGISTERED'))
      } else {
        throw err
      }
    }

    loading.hide()
    const passkeyName = await new Promise((resolve, reject) => {
      dialog({
        component: PasskeyCreateDialog
      })
        .onOk(({ name }) => {
          resolve(name)
        })
        .onCancel(() => {
          reject(new Error(t('error.ERR_PK_USER_CANCELLED')))
        })
    })
    loading.show()

    await API_CLIENT.post('users/profile/passkeys', {
      json: {
        name: passkeyName,
        registrationResponse: attResp
      }
    }).json()
    notify({
      type: 'positive',
      message: t('profile.passkeysSetupSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.passkeysSetupFailed'),
      caption: localizeError(apiErrorMessage(err), t)
    })
  }
  await fetchAuthMethods()
  loading.hide()
  profileSaving.end()
}

async function deactivatePasskey(pkey) {
  confirm({
    title: t('common.actions.confirm'),
    message: t('profile.passkeysDeactivateConfirm'),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(async () => {
    loading.show()
    profileSaving.begin()
    try {
      await API_CLIENT.delete(`users/profile/passkeys/${encodeURIComponent(pkey.id)}`)
      notify({
        type: 'positive',
        message: t('profile.passkeysDeactivateSuccess')
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('profile.passkeysDeactivateFailed'),
        caption: localizeError(apiErrorMessage(err), t)
      })
    }
    await fetchAuthMethods()
    loading.hide()
    profileSaving.end()
  })
}

onMounted(() => {
  fetchAuthMethods()
})
</script>
