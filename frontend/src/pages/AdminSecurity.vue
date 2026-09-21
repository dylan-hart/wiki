<template>
  <w-page class="admin-mail">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:shield" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.security.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.security.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/security`"
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
          :loading="state.loading > 0" />
      </div>
    </div>
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-6">
        <w-settings-card :title="t('admin.security.title')">
          <div class="p-3">
            <w-card class="bg-negative text-white rounded">
              <w-card-section class="items-center" horizontal>
                <w-card-section class="flex-none pe-0">
                  <w-icon name="tabler:alert-triangle" size="lg" />
                </w-card-section>
                <w-card-section class="text-caption">
                  <div>{{ t('admin.security.warn') }}</div>
                  <!-- These are read when the HTTP server builds its plugin chain, not per request (Trust Proxy excepted) -->
                  <div class="mt-1">{{ t('admin.security.restartRequired') }}</div>
                </w-card-section>
              </w-card-section>
            </w-card>
          </div>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:maximize"
            :label="t(`admin.security.disallowIframe`)"
            :hint="t(`admin.security.disallowIframeHint`)">
            <w-toggle
              v-model="state.config.disallowIframe"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.disallowIframe`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:hand-off"
            :label="t(`admin.security.enforceSameOriginReferrerPolicy`)"
            :hint="t(`admin.security.enforceSameOriginReferrerPolicyHint`)">
            <w-toggle
              v-model="state.config.enforceSameOriginReferrerPolicy"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.enforceSameOriginReferrerPolicy`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:arrow-back-up"
            :label="t(`admin.security.disallowOpenRedirect`)"
            :hint="t(`admin.security.disallowOpenRedirectHint`)">
            <w-toggle
              v-model="state.config.disallowOpenRedirect"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.disallowOpenRedirect`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:cloud-download"
            :label="t(`admin.security.forceAssetDownload`)"
            :hint="t(`admin.security.forceAssetDownloadHint`)">
            <w-toggle
              v-model="state.config.forceAssetDownload"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.forceAssetDownload`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:door"
            :label="t(`admin.security.trustProxy`)"
            :hint="t(`admin.security.trustProxyHint`)">
            <w-toggle
              v-model="trustProxyEnabled"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.trustProxy`)" />
          </w-settings-row>
          <template v-if="trustProxyEnabled">
            <w-settings-row
              control-width="fixed"
              icon="tabler:map-pin"
              :label="t(`admin.security.trustProxyAddresses`)"
              :hint="t(`admin.security.trustProxyAddressesHint`)">
              <w-input
                v-model="trustProxyAddresses"
                dense
                :placeholder="t(`admin.security.trustProxyAddressesPlaceholder`)"
                :aria-label="t(`admin.security.trustProxyAddresses`)" />
            </w-settings-row>
          </template>
          <!--
            `!trustProxy` is implied by `insecureCookieRiskAt` ever being set, but kept explicit so
            flipping the toggle above hides the warning at once, not after a reload.
          -->
          <template v-if="state.config.insecureCookieRiskAt && !state.config.trustProxy">
            <div class="p-3">
              <w-card class="bg-negative text-white rounded">
                <w-card-section class="items-center" horizontal>
                  <w-card-section class="flex-none pe-0">
                    <w-icon name="tabler:alert-triangle" size="lg" />
                  </w-card-section>
                  <w-card-section class="text-caption">
                    <div>{{ t('admin.security.insecureCookieRiskWarn') }}</div>
                    <div class="mt-1">
                      {{
                        t('admin.security.insecureCookieRiskWarnSince', {
                          date: humanizeDate(t, state.config.insecureCookieRiskAt)
                        })
                      }}
                    </div>
                  </w-card-section>
                </w-card-section>
              </w-card>
            </div>
          </template>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.security.hsts')">
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:lock-square-rounded"
            :label="t(`admin.security.enforceHsts`)"
            :hint="t(`admin.security.enforceHstsHint`)">
            <w-toggle
              v-model="state.config.enforceHsts"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.enforceHsts`)" />
          </w-settings-row>
          <template v-if="state.config.enforceHsts">
            <w-settings-row
              control-width="fixed"
              icon="tabler:clock-play"
              :label="t(`admin.security.hstsDuration`)"
              :hint="t(`admin.security.hstsDurationHint`)">
              <w-select
                v-model="state.config.hstsDuration"
                :options="hstsDurations"
                option-value="value"
                option-label="text"
                emit-value
                map-options
                dense
                :aria-label="t(`admin.security.hstsDuration`)" />
            </w-settings-row>
          </template>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.security.passkeys')">
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:key"
            :label="t(`admin.security.allowPasskeys`)"
            :hint="t(`admin.security.allowPasskeysHint`)">
            <w-toggle
              v-model="state.config.allowPasskeys"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.allowPasskeys`)" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.security.rateLimit')">
          <div class="p-3">
            <w-card class="bg-negative text-white rounded">
              <w-card-section class="items-center" horizontal>
                <w-card-section class="flex-none pe-0">
                  <w-icon name="tabler:alert-triangle" size="lg" />
                </w-card-section>
                <w-card-section class="text-caption">
                  <div v-if="!state.config.trustProxy">
                    {{ t('admin.security.rateLimitProxyWarn') }}
                  </div>
                  <div :class="{ 'mt-1': !state.config.trustProxy }">
                    {{ t('admin.security.rateLimitRecommended') }}
                  </div>
                </w-card-section>
              </w-card-section>
            </w-card>
          </div>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:filter"
            :label="t(`admin.security.rateLimitEnabled`)"
            :hint="t(`admin.security.rateLimitEnabledHint`)">
            <w-toggle
              v-model="state.config.authRateLimitEnabled"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.rateLimitEnabled`)" />
          </w-settings-row>
          <template v-if="state.config.authRateLimitEnabled">
            <w-settings-row
              control-width="fixed"
              icon="tabler:grid-dots"
              :label="t(`admin.security.rateLimitMax`)"
              :hint="t(`admin.security.rateLimitMaxHint`)">
              <w-input
                v-model.number="state.config.authRateLimitMax"
                dense
                :suffix="t(`admin.security.rateLimitMaxSuffix`)"
                :aria-label="t(`admin.security.rateLimitMax`)" />
            </w-settings-row>
            <w-settings-row
              control-width="fixed"
              icon="tabler:clock-play"
              :label="t(`admin.security.rateLimitWindow`)"
              :hint="t(`admin.security.rateLimitWindowHint`)">
              <w-input
                v-model="state.config.authRateLimitWindow"
                dense
                :placeholder="t(`admin.security.durationPlaceholder`)"
                :aria-label="t(`admin.security.rateLimitWindow`)" />
            </w-settings-row>
            <w-settings-row
              control-width="fixed"
              icon="tabler:ban"
              :label="t(`admin.security.rateLimitBan`)"
              :hint="t(`admin.security.rateLimitBanHint`)">
              <w-input
                v-model="state.config.authRateLimitBan"
                dense
                :placeholder="t(`admin.security.durationPlaceholder`)"
                :aria-label="t(`admin.security.rateLimitBan`)" />
            </w-settings-row>
          </template>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.security.apiRateLimit')">
          <div class="p-3">
            <w-card class="bg-negative text-white rounded">
              <w-card-section class="items-center" horizontal>
                <w-card-section class="flex-none pe-0">
                  <w-icon name="tabler:alert-triangle" size="lg" />
                </w-card-section>
                <w-card-section class="text-caption">
                  <div v-if="!state.config.trustProxy">
                    {{ t('admin.security.rateLimitProxyWarn') }}
                  </div>
                  <div :class="{ 'mt-1': !state.config.trustProxy }">
                    {{ t('admin.security.apiRateLimitRecommended') }}
                  </div>
                </w-card-section>
              </w-card-section>
            </w-card>
          </div>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:filter"
            :label="t(`admin.security.apiRateLimitEnabled`)"
            :hint="t(`admin.security.apiRateLimitEnabledHint`)">
            <w-toggle
              v-model="state.config.apiRateLimitEnabled"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.apiRateLimitEnabled`)" />
          </w-settings-row>
          <template v-if="state.config.apiRateLimitEnabled">
            <w-settings-row
              control-width="fixed"
              icon="tabler:grid-dots"
              :label="t(`admin.security.apiRateLimitMax`)"
              :hint="t(`admin.security.apiRateLimitMaxHint`)">
              <w-input
                v-model.number="state.config.apiRateLimitMax"
                dense
                :suffix="t(`admin.security.apiRateLimitMaxSuffix`)"
                :aria-label="t(`admin.security.apiRateLimitMax`)" />
            </w-settings-row>
            <w-settings-row
              control-width="fixed"
              icon="tabler:clock-play"
              :label="t(`admin.security.apiRateLimitWindow`)"
              :hint="t(`admin.security.apiRateLimitWindowHint`)">
              <w-input
                v-model="state.config.apiRateLimitWindow"
                dense
                :placeholder="t(`admin.security.durationPlaceholder`)"
                :aria-label="t(`admin.security.apiRateLimitWindow`)" />
            </w-settings-row>
            <w-settings-row
              control-width="fixed"
              icon="tabler:ban"
              :label="t(`admin.security.apiRateLimitBan`)"
              :hint="t(`admin.security.apiRateLimitBanHint`)">
              <w-input
                v-model="state.config.apiRateLimitBan"
                dense
                :placeholder="t(`admin.security.durationPlaceholder`)"
                :aria-label="t(`admin.security.apiRateLimitBan`)" />
            </w-settings-row>
          </template>
        </w-settings-card>
      </div>
      <div class="col-span-12 lg:col-span-6">
        <w-settings-card :title="t('admin.security.uploads')">
          <div class="p-3">
            <w-card class="bg-info text-white rounded">
              <w-card-section class="items-center" horizontal>
                <w-card-section class="flex-none pe-0">
                  <w-icon name="tabler:info-circle" size="lg" />
                </w-card-section>
                <w-card-section class="text-caption">
                  <div>{{ t('admin.security.uploadsInfo') }}</div>
                </w-card-section>
              </w-card-section>
            </w-card>
          </div>
          <w-settings-row
            control-width="fixed"
            icon="tabler:cloud-upload"
            :label="t(`admin.security.maxUploadSize`)"
            :hint="t(`admin.security.maxUploadSizeHint`)">
            <w-input
              v-model.number="state.humanUploadMaxFileSize"
              dense
              :aria-label="t(`admin.security.maxUploadSize`)" />
          </w-settings-row>
          <w-settings-row
            control-width="fixed"
            icon="tabler:files"
            :label="t(`admin.security.maxFilesPerBatch`)"
            :hint="t(`admin.security.maxFilesPerBatchHint`)">
            <w-input
              v-model.number="state.config.uploadMaxFilesPerBatch"
              dense
              :suffix="t(`admin.security.maxFilesPerBatchSuffix`)"
              :aria-label="t(`admin.security.maxFilesPerBatch`)" />
          </w-settings-row>
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:scan"
            :label="t(`admin.security.scanSVG`)"
            :hint="t(`admin.security.scanSVGHint`)">
            <w-toggle
              v-model="state.config.uploadScanSVG"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.scanSVG`)" />
          </w-settings-row>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.security.cors')">
          <w-settings-row
            icon="tabler:wall"
            :label="t(`admin.security.corsMode`)"
            :hint="t(`admin.security.corsModeHint`)">
            <w-select
              v-model="state.config.corsMode"
              :options="corsModes"
              option-value="value"
              option-label="text"
              emit-value
              map-options
              dense
              :aria-label="t(`admin.security.corsMode`)" />
          </w-settings-row>
          <template v-if="state.config.corsMode === `HOSTNAMES`">
            <w-settings-row
              icon="tabler:list-check"
              key="corsHostnames"
              :label="t(`admin.security.corsHostnames`)"
              :hint="t(`admin.security.corsHostnamesHint`)">
              <w-input
                v-model="state.config.corsConfig"
                dense
                type="textarea"
                :aria-label="t(`admin.security.corsHostnames`)" />
            </w-settings-row>
          </template>
          <template v-else-if="state.config.corsMode === `REGEX`">
            <w-settings-row
              icon="tabler:checkbox"
              key="corsRegex"
              :label="t(`admin.security.corsRegex`)"
              :hint="t(`admin.security.corsRegexHint`)">
              <w-input
                v-model="state.config.corsConfig"
                dense
                :aria-label="t(`admin.security.corsRegex`)" />
            </w-settings-row>
          </template>
        </w-settings-card>
        <w-settings-card class="mt-4" :title="t('admin.security.csp')">
          <w-settings-row
            tag="label"
            control-width="auto"
            icon="tabler:shield-check"
            :label="t(`admin.security.enforceCsp`)"
            :hint="t(`admin.security.enforceCspHint`)">
            <w-toggle
              v-model="state.config.enforceCsp"
              :loading="state.loading > 0"
              :aria-label="t(`admin.security.enforceCsp`)" />
          </w-settings-row>
          <template v-if="state.config.enforceCsp">
            <w-settings-row
              icon="tabler:file-code"
              key="cspDirectives"
              :label="t(`admin.security.cspDirectives`)"
              :hint="t(`admin.security.cspDirectivesHint`)">
              <w-input
                v-model="state.config.cspDirectives"
                dense
                type="textarea"
                :placeholder="t(`admin.security.cspDirectivesPlaceholder`)"
                :aria-label="t(`admin.security.cspDirectives`)" />
            </w-settings-row>
          </template>
        </w-settings-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'

import { useAdminSettings } from '@/composables/adminSettings'
import { useMeta } from '@/composables/meta'

import { useSiteStore } from '@/stores/site'

import { humanizeDate } from '@/helpers/datetime'
import { formatFileSize, parseFileSize } from '@/helpers/fileSize'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.security.title')
}))

function defaultConfig() {
  return {
    corsConfig: '',
    corsMode: 'OFF',
    cspDirectives: '',
    disallowIframe: false,
    disallowOpenRedirect: false,
    enforceCsp: false,
    enforceHsts: false,
    enforceSameOriginReferrerPolicy: false,
    forceAssetDownload: false,
    hstsDuration: 0,
    trustProxy: false,
    insecureCookieRiskAt: null,
    allowPasskeys: true,
    authRateLimitEnabled: true,
    authRateLimitMax: 10,
    authRateLimitWindow: '5m',
    authRateLimitBan: '15m',
    apiRateLimitEnabled: true,
    apiRateLimitMax: 300,
    apiRateLimitWindow: '5m',
    apiRateLimitBan: '15m',
    uploadMaxFileSize: 0,
    uploadMaxFilesPerBatch: 10,
    uploadScanSVG: false
  }
}

const { state, load, save } = useAdminSettings({
  i18nPrefix: 'admin.security',
  siteScoped: false,
  defaults: defaultConfig,
  extraState: { humanUploadMaxFileSize: '0' },
  fetch: () => API_CLIENT.get('system/security').json(),
  // -> Merged over what the form holds, not over a fresh `defaultConfig()`: a key the server does
  //    not send back keeps the value already on screen rather than snapping to a default.
  pick: (resp) => ({ ...state.config, ...resp }),
  onLoaded: () => {
    if (typeof state.config.trustProxy === 'string') {
      trustProxyAddressCache.value = state.config.trustProxy
    }
    state.humanUploadMaxFileSize = formatFileSize(state.config.uploadMaxFileSize)
  },
  commit: (siteId, config) => {
    let uploadMaxFileSize
    try {
      uploadMaxFileSize = parseFileSize(state.humanUploadMaxFileSize || '0')
    } catch {
      throw new Error(t('admin.security.maxUploadSizeInvalid'))
    }
    if (!(uploadMaxFileSize > 0)) {
      throw new Error(t('admin.security.maxUploadSizeInvalid'))
    }
    // -> ky throws above 400: the server rejects combinations that would store a setting doing
    //    nothing, such as enforcing a CSP with no directives.
    return API_CLIENT.put('system/security', {
      json: { ...config, uploadMaxFileSize }
    }).json()
  },
  // -> Re-read rather than trusting the sent values: the server normalises some of them
  onSaved: () => load()
})

const hstsDurations = [
  { value: 300, text: '5 minutes' },
  { value: 86400, text: '1 day' },
  { value: 604800, text: '1 week' },
  { value: 2592000, text: '1 month' },
  { value: 31536000, text: '1 year' },
  { value: 63072000, text: '2 years' }
]

const corsModes = [
  { value: 'OFF', text: 'Off / Same-Origin' },
  { value: 'REFLECT', text: 'Reflect Request Origin' },
  { value: 'HOSTNAMES', text: 'Hostnames Whitelist' },
  { value: 'REGEX', text: 'Regex Pattern Match' }
]

/*
  `state.config.trustProxy` is `false` or a comma-separated address/CIDR list, so the boolean toggle
  and the text field each get their own computed view of the one field rather than a second field
  kept in sync by hand. `trustProxyAddressCache` survives a toggle-off, which sets the field to
  `false` and would otherwise discard a typed list the moment it is hidden.
*/
const trustProxyAddressCache = ref('')

const trustProxyEnabled = computed({
  get: () => Boolean(state.config.trustProxy),
  set: (val) => {
    // -> `true`, not `''`: the insecure-cookie-risk warning keys off `!state.config.trustProxy`,
    //    where an empty string is as falsy as `false`. `true` (trust every proxy) is a valid stored
    //    value on its own, so nothing is papered over by it.
    state.config.trustProxy = val ? trustProxyAddressCache.value || true : false
  }
})
const trustProxyAddresses = computed({
  get: () => (typeof state.config.trustProxy === 'string' ? state.config.trustProxy : ''),
  set: (val) => {
    trustProxyAddressCache.value = val
    // -> Blank falls back to `true` rather than an ambiguous empty string: the toggle is still on,
    //    so no address list means the same state as having just flipped it on.
    state.config.trustProxy = val.trim() === '' ? true : val
  }
})
</script>

<style></style>
