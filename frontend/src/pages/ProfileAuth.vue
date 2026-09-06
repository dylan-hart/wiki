<template>
  <w-page>
    <h1 class="w-section-header">{{ t('profile.auth') }}</h1>
    <div class="p-4">
      <div class="text-body2">{{ t('profile.authInfo') }}</div>
      <!--
        The plate is the provider's OWN logo rather than a generic glyph -- `img:` for a strategy
        icon served as a file, which is what identifies a row here; every other settings row in the
        app names its subject with a Tabler reference, and none of them stands for a third party.
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
              Only rendered once the status fetch (fired from `fetchAuthMethods()`) resolves --
              absent while loading or on a failed fetch, since this is a nudge on top of an
              auth-methods list that already rendered, not something worth its own error state.
              Under the label rather than under the control, now that the row has one hint column
              for everything it has to say about itself.
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
            One trigger rather than a row of buttons: these are occasional actions on a row that also
            has to stay readable, and the settings row keeps its whole control column on one line.
          -->
          <template v-if="auth.strategyKey === `local`">
            <div class="flex items-center gap-3">
              <!--
                Says at a glance that the account is protected, without opening the menu to find out.
                Only shown when 2FA is on: the absence of a badge is not a warning, since 2FA is
                optional unless an administrator requires it.
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
                Shaped like the Delete button on a passkey row -- same acrylic tint, drawn in the
                brand blue instead of the negative red, which `acrylic-btn` picks up on its own since
                it mixes its background out of `currentcolor`.
              -->
              <w-btn
                class="acrylic-btn"
                flat
                icon="tabler:settings"
                color="primary"
                :aria-label="t(`profile.authActions`)">
                <w-menu class="translucent-menu" auto-close anchor="bottom right" self="top right">
                  <!--
                  `!min-w-0 !pe-2` on each icon section: an avatar section is a 56px column with 16px
                  of padding after it, which is the right metric for a 40px avatar in a list row and
                  far too much air beside a 24px icon in a menu. Both rules are scoped styles in
                  WItemSection, hence `!` -- a layered utility cannot outrank them.

                  The colours are literal classes rather than WIcon's `color` prop: that prop builds
                  `text-${color}` at runtime, and Tailwind only emits a utility it can see spelled out
                  in the source, so `color="blue-7"` would compile to a class that does not exist.
                -->
                  <w-list dense padding style="min-width: 240px">
                    <w-item clickable @click="changePassword(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:key" class="text-blue-7" />
                      </w-item-section>
                      <w-item-section>{{ t('profile.authChangePassword') }}</w-item-section>
                    </w-item>
                    <w-item
                      v-if="auth.config.isTfaSetup"
                      clickable
                      @click="disableTfa(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:fingerprint" class="text-blue-7" />
                      </w-item-section>
                      <w-item-section>{{ t('profile.authDisableTfa') }}</w-item-section>
                    </w-item>
                    <w-item v-else clickable @click="setupTfa(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:fingerprint" class="text-blue-7" />
                      </w-item-section>
                      <w-item-section>{{ t('profile.authSetTfa') }}</w-item-section>
                    </w-item>
                    <w-item
                      v-if="auth.config.isTfaSetup"
                      clickable
                      @click="regenerateRecoveryCodes(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:key" class="text-blue-7" />
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
                        <w-icon name="tabler:ban" class="text-negative" />
                      </w-item-section>
                      <w-item-section class="text-negative">
                        {{ t('profile.authDisablePasswordLogin') }}
                      </w-item-section>
                    </w-item>
                    <w-item v-else clickable @click="enablePasswordLogin(auth.authId)">
                      <w-item-section avatar class="!min-w-0 !pe-2">
                        <w-icon name="tabler:arrow-forward-up" class="text-blue-7" />
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
        The card is only drawn once there is a passkey to put in it: an empty settings card is a
        header strip over nothing, where the intro above and the Add button below already say what
        this section is and what to do about it.
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
      <div class="mt-4">
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

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('profile.auth')
}))

// DATA

const state = reactive({
  authMethods: [],
  passkeys: [],
  // -> Keyed by authId. Populated lazily after `fetchAuthMethods()`, one entry per local strategy
  //    with 2FA active. Absent entry means either not applicable or the status fetch failed --
  //    both render the same way (no remaining-count line), since this is a nudge, not a blocker.
  recoveryCodesStatus: {},
  loading: 0
})

// METHODS

async function fetchAuthMethods() {
  state.loading++
  try {
    const resp = await API_CLIENT.get('users/profile/auth').json()
    state.authMethods = resp?.authMethods ?? []
    state.passkeys = resp?.passkeys ?? []
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
 * Fills in `state.recoveryCodesStatus` for every local auth method with 2FA active. Kept separate
 * from `fetchAuthMethods()`'s own try/catch: a failure here is silent (no `notify()`) since the
 * remaining-count line is a nudge on top of an auth-methods list that already rendered
 * successfully, not something worth surfacing as its own error toast.
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
        // -> Silent by design, see function doc comment above.
      }
    })
  )
}

/** Whether `authId`'s recovery codes are running low enough to nudge the user to regenerate. */
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
    try {
      const resp = await API_CLIENT.post('users/profile/tfa/recovery-codes', {
        json: {
          strategyId
        }
      }).json()
      loading.hide()
      dialog({
        component: RecoveryCodesDialog,
        componentProps: {
          codes: resp.recoveryCodes
        }
      })
    } catch (err) {
      loading.hide()
      notify({
        type: 'negative',
        message: t('profile.tfaRecoveryCodesRegenerateFailed'),
        caption: localizeError(apiErrorMessage(err), t)
      })
    }
  })
}

async function setupPasskey() {
  try {
    if (!browserSupportsWebAuthn()) {
      throw new Error(t('profile.passkeysUnsupported'))
    }
    loading.show()

    // -> Generate registration options

    const genResp = await API_CLIENT.post('users/profile/passkeys/challenge').json()

    // -> Start registration on the authenticator

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

    // -> Prompt for passkey name

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

    // -> Verify the authenticator response

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
  })
}

// MOUNTED

onMounted(() => {
  fetchAuthMethods()
})
</script>
