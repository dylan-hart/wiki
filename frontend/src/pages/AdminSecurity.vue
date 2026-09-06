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
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-6">
        <!-- ----------------------- -->
        <!-- Security -->
        <!-- ----------------------- -->
        <w-settings-card :title="t('admin.security.title')">
          <div class="p-3">
            <w-card class="bg-negative text-white rounded">
              <w-card-section class="items-center" horizontal>
                <w-card-section class="flex-none pe-0">
                  <w-icon name="tabler:alert-triangle" size="lg" />
                </w-card-section>
                <w-card-section class="text-caption">
                  <div>{{ t('admin.security.warn') }}</div>
                  <!-- These are read when the HTTP server builds its plugin chain, not per request -->
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
            Only shown once the backend has actually seen the misconfiguration on a live request
            (`GET /system/security`'s `insecureCookieRiskAt`) -- unlike the rate-limit warnings
            above, this is not "off by default, turn it on", it is "something is provably wrong
            right now". `!trustProxy` is implied by the field ever being set at all (see
            `Security#observeRequest`), but kept explicit so flipping the toggle above hides the
            warning immediately rather than waiting on a restart + reload to confirm it.
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
        <!-- ----------------------- -->
        <!-- HSTS -->
        <!-- ----------------------- -->
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
        <!-- ----------------------- -->
        <!-- Rate Limiting -->
        <!-- ----------------------- -->
        <w-settings-card class="mt-4" :title="t('admin.security.rateLimit')">
          <!--
            First thing in the card, and in the same red the security warning above uses: both say
            something that decides whether the settings under them do what they look like they do.
          -->
          <div class="p-3">
            <w-card class="bg-negative text-white rounded">
              <w-card-section class="items-center" horizontal>
                <w-card-section class="flex-none pe-0">
                  <w-icon name="tabler:alert-triangle" size="lg" />
                </w-card-section>
                <w-card-section class="text-caption">
                  <!-- -> With `trustProxy` off behind a proxy every request carries the proxy's
                       address, so one visitor going over the limit takes everybody with them -->
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
        <!-- ----------------------- -->
        <!-- API Rate Limiting -->
        <!-- ----------------------- -->
        <w-settings-card class="mt-4" :title="t('admin.security.apiRateLimit')">
          <!--
            Same red warning-first layout as the authentication rate-limit card above: both say
            something that decides whether the settings under them do what they look like they do.
          -->
          <div class="p-3">
            <w-card class="bg-negative text-white rounded">
              <w-card-section class="items-center" horizontal>
                <w-card-section class="flex-none pe-0">
                  <w-icon name="tabler:alert-triangle" size="lg" />
                </w-card-section>
                <w-card-section class="text-caption">
                  <!-- -> With `trustProxy` off behind a proxy every request carries the proxy's
                       address, so one caller going over the limit takes everybody with them -->
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
        <!-- ----------------------- -->
        <!-- Uploads -->
        <!-- ----------------------- -->
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
        <!-- ----------------------- -->
        <!-- CORS -->
        <!-- ----------------------- -->
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
        <!-- ----------------------- -->
        <!-- CSP -->
        <!-- ----------------------- -->
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

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.security.title')
}))

// DATA

/**
 * Fallbacks for every control on this page, so each renders with a defined value before
 * `GET system/security` has answered.
 */
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
    authRateLimitEnabled: true,
    authRateLimitMax: 10,
    authRateLimitWindow: '5m',
    authRateLimitBan: '15m',
    apiRateLimitEnabled: true,
    apiRateLimitMax: 300,
    apiRateLimitWindow: '5m',
    apiRateLimitBan: '15m',
    uploadMaxFileSize: 0,
    uploadScanSVG: false
  }
}

const { state, load, save } = useAdminSettings({
  i18nPrefix: 'admin.security',
  // -> Instance-wide settings, not one site's: no site picker, no reload on switching site
  siteScoped: false,
  defaults: defaultConfig,
  extraState: { humanUploadMaxFileSize: '0' },
  fetch: () => API_CLIENT.get('system/security').json(),
  // -> Over whatever the form currently holds, not over a fresh `defaultConfig()`: the reload that
  //    follows a save is what re-reads the server's normalised values, and a key it does not send
  //    back keeps the value already on screen rather than snapping to a default.
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
    // -> ky throws above 400 -- the server rejects combinations that would store a setting doing
    //    nothing, e.g. enforcing a CSP with no directives
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
  `state.config.trustProxy` is boolean-or-string now (see `backend/models/security.ts`'s widened
  `validate()`): `false` off, or a comma-separated trusted-proxy address/CIDR list on. The toggle
  below still needs a plain boolean to bind to, and the new text field below it needs a plain string
  -- these two computed properties are that split, rather than a second field in `state.config` that
  would need to be kept in sync with it by hand. `trustProxyAddressCache` remembers the last-typed
  list across a toggle-off/on cycle -- flipping the toggle off sets `state.config.trustProxy` to
  `false`, which would otherwise lose whatever address list was typed in the moment the field is
  hidden (`v-if="trustProxyEnabled"` above), forcing a re-type on every accidental toggle.
*/
const trustProxyAddressCache = ref('')

const trustProxyEnabled = computed({
  get: () => Boolean(state.config.trustProxy),
  set: (val) => {
    // -> Flipping on lands on the cached address list if there is one, else `true` (not `''`) --
    //    `!state.config.trustProxy` is what the insecure-cookie-risk warning below keys off of to
    //    hide itself the instant the toggle flips, and an empty string is just as falsy as `false`
    //    there. `true` still validates on the backend (see `models/security.test.ts`'s "still
    //    accepts the bare boolean true"), so it is a real, save-able value on its own -- filling in
    //    the address field below (which overwrites it with the real string) is what the admin should
    //    still do before saving, not something this toggle can silently paper over by picking a
    //    falsy placeholder instead.
    state.config.trustProxy = val ? trustProxyAddressCache.value || true : false
  }
})
const trustProxyAddresses = computed({
  get: () => (typeof state.config.trustProxy === 'string' ? state.config.trustProxy : ''),
  set: (val) => {
    trustProxyAddressCache.value = val
    // -> Clearing the field entirely falls back to `true` (trust every proxy) rather than saving an
    //    ambiguous empty string -- the toggle is still on, so the field being blank should mean "no
    //    address list configured yet," the same state as just having flipped the toggle on.
    state.config.trustProxy = val.trim() === '' ? true : val
  }
})
</script>

<style lang="scss"></style>
