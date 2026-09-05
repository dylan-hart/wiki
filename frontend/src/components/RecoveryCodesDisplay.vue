<template>
  <div>
    <div class="text-body2 text-grey-8 dark:text-grey-4">
      {{ t('profile.tfaRecoveryCodesIntro') }}
    </div>
    <div
      class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded bg-black/6 p-3 font-mono text-body2 dark:bg-white/10">
      <code v-for="code of codes" :key="code">{{ code }}</code>
    </div>
    <div class="mt-3 flex flex-wrap justify-center gap-2">
      <w-btn
        class="acrylic-btn"
        flat
        icon="tabler:copy"
        :label="t(`common.actions.copy`)"
        color="primary"
        padding="xs md"
        @click="copyCodes" />
      <w-btn
        class="acrylic-btn"
        flat
        icon="tabler:download"
        :label="t(`common.actions.download`)"
        color="primary"
        padding="xs md"
        @click="downloadCodes" />
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { fileSave } from 'browser-fs-access'

import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { copyToClipboard } from '@/helpers/clipboard'

/**
 * The one-time display of a fresh set of 2FA recovery codes -- shared between `SetupTfaDialog.vue`
 * (right after activation) and `RecoveryCodesDialog.vue` (after a regeneration on the profile page).
 * Purely presentational: the codes themselves, plus copy/download, and an `acknowledged` model the
 * host dialog gates its close button on -- neither action here closes anything itself, since a
 * setup dialog and a standalone dialog have different things to do once the user is done.
 */

// PROPS

const props = defineProps({
  codes: {
    type: Array,
    required: true
  }
})

// MODEL

const acknowledged = defineModel('acknowledged', {
  type: Boolean,
  default: false
})

// I18N

const { t } = useI18n()

// METHODS

async function copyCodes() {
  try {
    await copyToClipboard(props.codes.join('\n'))
    acknowledged.value = true
    notify({
      type: 'positive',
      message: t('profile.tfaRecoveryCodesCopySuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('profile.tfaRecoveryCodesCopyFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

async function downloadCodes() {
  try {
    // -> No `;charset=` on the type: the save picker uses it as an `accept` key and rejects a type
    //    with parameters. A Blob built from a JS string is UTF-8 regardless -- same as PageSourceOverlay
    await fileSave(new Blob([props.codes.join('\n') + '\n'], { type: 'text/plain' }), {
      fileName: 'wiki-recovery-codes.txt',
      extensions: ['.txt']
    })
    acknowledged.value = true
  } catch (err) {
    // -> The user closing the save picker rejects the same way a real failure would; not worth a toast
    if (err?.name !== 'AbortError') {
      notify({
        type: 'negative',
        message: t('profile.tfaRecoveryCodesDownloadFailed'),
        caption: apiErrorMessage(err)
      })
    }
  }
}
</script>
