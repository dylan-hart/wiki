<template>
  <w-page class="admin-mail">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:mail" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.mail.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.mail.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/mail`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="tabler:refresh"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="tabler:check"
          :label="t(`common.actions.apply`)"
          color="slate"
          @click="save"
          :disabled="state.loading > 0" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-7">
        <!-- ----------------------- -->
        <!-- Configuration -->
        <!-- ----------------------- -->
        <w-settings-card :title="t('admin.mail.configuration')">
          <w-settings-row
            icon="tabler:address-book"
            :label="t(`admin.mail.senderName`)"
            :hint="t(`admin.general.senderNameHint`)">
            <w-input
              v-model="state.config.senderName"
              dense
              hide-bottom-space
              :aria-label="t(`admin.mail.senderName`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:mail"
            :label="t(`admin.mail.senderEmail`)"
            :hint="t(`admin.general.senderEmailHint`)">
            <w-input
              v-model="state.config.senderEmail"
              dense
              :aria-label="t(`admin.mail.senderEmail`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:world-www"
            :label="t(`admin.mail.defaultBaseURL`)"
            :hint="t(`admin.general.defaultBaseURLHint`)">
            <w-input
              v-model="state.config.defaultBaseURL"
              dense
              :aria-label="t(`admin.mail.defaultBaseURL`)" />
          </w-settings-row>
        </w-settings-card>
        <!-- ----------------------- -->
        <!-- SMTP -->
        <!-- ----------------------- -->
        <w-settings-card class="mt-4" :title="t('admin.mail.smtp')">
          <w-settings-row
            icon="tabler:world-www"
            :label="t(`admin.mail.smtpHost`)"
            :hint="t(`admin.mail.smtpHostHint`)">
            <w-input
              v-model="state.config.host"
              dense
              hide-bottom-space
              :aria-label="t(`admin.mail.smtpHost`)" />
          </w-settings-row>
          <w-settings-row
            control-width="fixed"
            icon="tabler:network-off"
            :label="t(`admin.mail.smtpPort`)"
            :hint="t(`admin.mail.smtpPortHint`)">
            <w-input v-model="state.config.port" dense :aria-label="t(`admin.mail.smtpPort`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:shield-check"
            :label="t(`admin.mail.smtpTLS`)"
            :hint="t(`admin.mail.smtpTLSHint`)">
            <w-toggle v-model="state.config.secure" :aria-label="t(`admin.mail.smtpTLS`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:certificate"
            :label="t(`admin.mail.smtpVerifySSL`)"
            :hint="t(`admin.mail.smtpVerifySSLHint`)">
            <w-toggle
              v-model="state.config.verifySSL"
              :aria-label="t(`admin.mail.smtpVerifySSL`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:user-check"
            :label="t(`admin.mail.smtpUser`)"
            :hint="t(`admin.mail.smtpUserHint`)">
            <w-input v-model="state.config.user" dense :aria-label="t(`admin.mail.smtpUser`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:password"
            :label="t(`admin.mail.smtpPwd`)"
            :hint="t(`admin.mail.smtpPwdHint`)">
            <w-input v-model="state.config.pass" dense :aria-label="t(`admin.mail.smtpPwd`)" />
          </w-settings-row>
          <w-settings-row
            icon="tabler:server"
            :label="t(`admin.mail.smtpName`)"
            :hint="t(`admin.mail.smtpNameHint`)">
            <w-input
              v-model="state.config.name"
              dense
              hide-bottom-space
              :aria-label="t(`admin.mail.smtpName`)" />
          </w-settings-row>
        </w-settings-card>
        <!-- ----------------------- -->
        <!-- DKIM -->
        <!-- ----------------------- -->
        <w-settings-card class="mt-4" :title="t('admin.mail.dkim')">
          <template #hint>{{ t('admin.mail.dkimHint') }}</template>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:inbox"
            :label="t(`admin.mail.dkimUse`)"
            :hint="t(`admin.mail.dkimUseHint`)">
            <w-toggle v-model="state.config.useDKIM" :aria-label="t(`admin.mail.dkimUse`)" />
          </w-settings-row>
          <template v-if="state.config.useDKIM">
            <w-settings-row
              icon="tabler:world-www"
              :label="t(`admin.mail.dkimDomainName`)"
              :hint="t(`admin.mail.dkimDomainNameHint`)">
              <w-input
                v-model="state.config.dkimDomainName"
                dense
                :aria-label="t(`admin.mail.dkimDomainName`)" />
            </w-settings-row>
            <w-settings-row
              icon="tabler:shield-lock"
              :label="t(`admin.mail.dkimKeySelector`)"
              :hint="t(`admin.mail.dkimKeySelectorHint`)">
              <w-input
                v-model="state.config.dkimKeySelector"
                dense
                :aria-label="t(`admin.mail.dkimKeySelector`)" />
            </w-settings-row>
            <w-settings-row
              icon="tabler:key"
              :label="t(`admin.mail.dkimPrivateKey`)"
              :hint="t(`admin.mail.dkimPrivateKeyHint`)">
              <w-input
                v-model="state.config.dkimPrivateKey"
                dense
                :aria-label="t(`admin.mail.dkimPrivateKey`)"
                type="textarea" />
            </w-settings-row>
          </template>
        </w-settings-card>
      </div>
      <div class="col-span-12 lg:col-span-5">
        <!-- ----------------------- -->
        <!-- SMTP TEST -->
        <!-- ----------------------- -->
        <w-settings-card :title="t('admin.mail.test')">
          <w-settings-row
            icon="tabler:mail"
            :label="t(`admin.mail.testRecipient`)"
            :hint="t(`admin.mail.testRecipientHint`)">
            <w-input v-model="state.testEmail" dense :aria-label="t(`admin.mail.testRecipient`)" />
          </w-settings-row>
          <!--
            The send button acts on the field above rather than being a setting of its own, so it
            takes a row of its own with no label and sits at the trailing edge under the field.
          -->
          <w-settings-row control-width="auto" icon="tabler:send">
            <w-btn
              color="primary"
              icon="tabler:send"
              :label="t(`admin.mail.testSend`)"
              @click="sendTest"
              :loading="state.testLoading" />
          </w-settings-row>
        </w-settings-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { useAdminSettings } from '@/composables/adminSettings'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.mail.title')
}))

// DATA

/**
 * Fallbacks for config keys the API may not return yet, so that every control renders with a
 * defined value. Must mirror the mail defaults seeded by the backend.
 */
function defaultConfig() {
  return {
    senderName: '',
    senderEmail: '',
    defaultBaseURL: '',
    host: '',
    port: 465,
    name: '',
    secure: true,
    verifySSL: true,
    user: '',
    pass: '',
    useDKIM: false,
    dkimDomainName: '',
    dkimKeySelector: '',
    dkimPrivateKey: ''
  }
}

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.mail',
  // -> Instance-wide settings, not one site's: no site picker, no reload on switching site
  siteScoped: false,
  // -> This form has never raised the full-screen overlay to read its own values
  overlay: false,
  defaults: defaultConfig,
  extraState: {
    testEmail: '',
    testLoading: false
  },
  fetch: () => API_CLIENT.get('mail/config').json(),
  pick: (resp) => {
    if (!resp) {
      throw new Error(t('admin.mail.loadFailed'))
    }
    return resp
  },
  onLoaded: () => {
    adminStore.info.isMailConfigured = state.config?.host?.length > 2
  }
})

// METHODS

async function save() {
  if (state.loading > 0) {
    return
  }

  state.loading++
  try {
    await API_CLIENT.put('mail/config', {
      json: {
        senderName: state.config.senderName || '',
        senderEmail: state.config.senderEmail || '',
        defaultBaseURL: state.config.defaultBaseURL || '',
        host: state.config.host || '',
        port: Number.parseInt(state.config.port, 10) || 465,
        name: state.config.name || '',
        secure: state.config.secure ?? false,
        verifySSL: state.config.verifySSL ?? false,
        user: state.config.user || '',
        pass: state.config.pass || '',
        useDKIM: state.config.useDKIM ?? false,
        dkimDomainName: state.config.dkimDomainName || '',
        dkimKeySelector: state.config.dkimKeySelector || '',
        dkimPrivateKey: state.config.dkimPrivateKey || ''
      }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.mail.saveSuccess')
    })
    adminStore.info.isMailConfigured = state.config?.host?.length > 2
  } catch (err) {
    notify({
      type: 'negative',
      message: t(
        `admin.mail.${err.data?.error}`,
        apiErrorMessage(err, t('common.error.unexpected'))
      )
    })
  }
  state.loading--
}

async function sendTest() {
  if (state.testLoading) {
    return
  }

  state.testLoading = true
  try {
    await API_CLIENT.post('mail/test', {
      json: { recipientEmail: state.testEmail || '' }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.mail.sendTestSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  state.testLoading = false
}
</script>

<style lang="scss"></style>
