<template>
  <w-page class="admin-mail">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon name="tabler:shield" size="64px" class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.security.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.security.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="la:question-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/security`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="me-2"
          icon="la:redo-alt"
          outline
          color="slate-soft"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="mdi:check"
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
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.security.title') }}</w-card-header>
          <w-item class="pt-0">
            <w-item-section>
              <w-card class="bg-negative text-white rounded">
                <w-card-section class="items-center" horizontal>
                  <w-card-section class="flex-none pe-0">
                    <w-icon name="la:exclamation-triangle" size="lg" />
                  </w-card-section>
                  <w-card-section class="text-caption">
                    <div>{{ t('admin.security.warn') }}</div>
                    <!-- These are read when the HTTP server builds its plugin chain, not per request -->
                    <div class="mt-1">{{ t('admin.security.restartRequired') }}</div>
                  </w-card-section>
                </w-card-section>
              </w-card>
            </w-item-section>
          </w-item>
          <w-item tag="label">
            <blueprint-icon icon="maximize-window" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.disallowIframe`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.security.disallowIframeHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.disallowIframe"
                :loading="state.loading > 0"
                :aria-label="t(`admin.security.disallowIframe`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="do-not-touch" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.enforceSameOriginReferrerPolicy`) }}</w-item-label>
              <w-item-label caption>{{
                t(`admin.security.enforceSameOriginReferrerPolicyHint`)
              }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.enforceSameOriginReferrerPolicy"
                :loading="state.loading > 0"
                :aria-label="t(`admin.security.enforceSameOriginReferrerPolicy`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="curly-arrow" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.disallowOpenRedirect`) }}</w-item-label>
              <w-item-label caption>{{
                t(`admin.security.disallowOpenRedirectHint`)
              }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.disallowOpenRedirect"
                :loading="state.loading > 0"
                :aria-label="t(`admin.security.disallowOpenRedirect`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="download-from-cloud" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.forceAssetDownload`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.security.forceAssetDownloadHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.forceAssetDownload"
                :loading="state.loading > 0"
                :aria-label="t(`admin.security.forceAssetDownload`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="door-sensor-alarmed" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.trustProxy`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.security.trustProxyHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="trustProxyEnabled"
                :loading="state.loading > 0"
                :aria-label="t(`admin.security.trustProxy`)" />
            </w-item-section>
          </w-item>
          <template v-if="trustProxyEnabled">
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="address" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.trustProxyAddresses`) }}</w-item-label>
                <w-item-label caption>{{
                  t(`admin.security.trustProxyAddressesHint`)
                }}</w-item-label>
              </w-item-section>
              <w-item-section style="flex: 0 0 260px">
                <w-input
                  v-model="trustProxyAddresses"
                  dense
                  :placeholder="t(`admin.security.trustProxyAddressesPlaceholder`)"
                  :aria-label="t(`admin.security.trustProxyAddresses`)" />
              </w-item-section>
            </w-item>
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
            <w-separator class="my-2" inset />
            <w-item>
              <w-item-section>
                <w-card class="bg-negative text-white rounded">
                  <w-card-section class="items-center" horizontal>
                    <w-card-section class="flex-none pe-0">
                      <w-icon name="la:exclamation-triangle" size="lg" />
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
              </w-item-section>
            </w-item>
          </template>
        </w-card>
        <!-- ----------------------- -->
        <!-- HSTS -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.security.hsts') }}</w-card-header>
          <w-item tag="label">
            <blueprint-icon icon="hips" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.enforceHsts`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.security.enforceHstsHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.enforceHsts"
                :loading="state.loading > 0"
                :aria-label="t(`admin.security.enforceHsts`)" />
            </w-item-section>
          </w-item>
          <template v-if="state.config.enforceHsts">
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="timer" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.hstsDuration`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.security.hstsDurationHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section style="flex: 0 0 200px">
                <w-select
                  v-model="state.config.hstsDuration"
                  :options="hstsDurations"
                  option-value="value"
                  option-label="text"
                  emit-value
                  map-options
                  dense
                  :aria-label="t(`admin.security.hstsDuration`)" />
              </w-item-section>
            </w-item>
          </template>
        </w-card>
        <!-- ----------------------- -->
        <!-- Rate Limiting -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.security.rateLimit') }}</w-card-header>
          <!--
            First thing in the card, and in the same red the security warning above uses: both say
            something that decides whether the settings under them do what they look like they do.
          -->
          <w-item class="pt-0">
            <w-item-section>
              <w-card class="bg-negative text-white rounded">
                <w-card-section class="items-center" horizontal>
                  <w-card-section class="flex-none pe-0">
                    <w-icon name="la:exclamation-triangle" size="lg" />
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
            </w-item-section>
          </w-item>
          <w-item tag="label">
            <blueprint-icon icon="filtration" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.rateLimitEnabled`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.security.rateLimitEnabledHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.authRateLimitEnabled"
                :loading="state.loading > 0"
                :aria-label="t(`admin.security.rateLimitEnabled`)" />
            </w-item-section>
          </w-item>
          <template v-if="state.config.authRateLimitEnabled">
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="pin-pad" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.rateLimitMax`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.security.rateLimitMaxHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section style="flex: 0 0 200px">
                <w-input
                  v-model.number="state.config.authRateLimitMax"
                  dense
                  :suffix="t(`admin.security.rateLimitMaxSuffix`)"
                  :aria-label="t(`admin.security.rateLimitMax`)" />
              </w-item-section>
            </w-item>
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="timer" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.rateLimitWindow`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.security.rateLimitWindowHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section style="flex: 0 0 200px">
                <w-input
                  v-model="state.config.authRateLimitWindow"
                  dense
                  :placeholder="t(`admin.security.durationPlaceholder`)"
                  :aria-label="t(`admin.security.rateLimitWindow`)" />
              </w-item-section>
            </w-item>
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="denied" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.rateLimitBan`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.security.rateLimitBanHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section style="flex: 0 0 200px">
                <w-input
                  v-model="state.config.authRateLimitBan"
                  dense
                  :placeholder="t(`admin.security.durationPlaceholder`)"
                  :aria-label="t(`admin.security.rateLimitBan`)" />
              </w-item-section>
            </w-item>
          </template>
        </w-card>
        <!-- ----------------------- -->
        <!-- API Rate Limiting -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.security.apiRateLimit') }}</w-card-header>
          <!--
            Same red warning-first layout as the authentication rate-limit card above: both say
            something that decides whether the settings under them do what they look like they do.
          -->
          <w-item class="pt-0">
            <w-item-section>
              <w-card class="bg-negative text-white rounded">
                <w-card-section class="items-center" horizontal>
                  <w-card-section class="flex-none pe-0">
                    <w-icon name="la:exclamation-triangle" size="lg" />
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
            </w-item-section>
          </w-item>
          <w-item tag="label">
            <blueprint-icon icon="filtration" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.apiRateLimitEnabled`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.security.apiRateLimitEnabledHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.apiRateLimitEnabled"
                :loading="state.loading > 0"
                :aria-label="t(`admin.security.apiRateLimitEnabled`)" />
            </w-item-section>
          </w-item>
          <template v-if="state.config.apiRateLimitEnabled">
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="pin-pad" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.apiRateLimitMax`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.security.apiRateLimitMaxHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section style="flex: 0 0 200px">
                <w-input
                  v-model.number="state.config.apiRateLimitMax"
                  dense
                  :suffix="t(`admin.security.apiRateLimitMaxSuffix`)"
                  :aria-label="t(`admin.security.apiRateLimitMax`)" />
              </w-item-section>
            </w-item>
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="timer" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.apiRateLimitWindow`) }}</w-item-label>
                <w-item-label caption>{{
                  t(`admin.security.apiRateLimitWindowHint`)
                }}</w-item-label>
              </w-item-section>
              <w-item-section style="flex: 0 0 200px">
                <w-input
                  v-model="state.config.apiRateLimitWindow"
                  dense
                  :placeholder="t(`admin.security.durationPlaceholder`)"
                  :aria-label="t(`admin.security.apiRateLimitWindow`)" />
              </w-item-section>
            </w-item>
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="denied" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.apiRateLimitBan`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.security.apiRateLimitBanHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section style="flex: 0 0 200px">
                <w-input
                  v-model="state.config.apiRateLimitBan"
                  dense
                  :placeholder="t(`admin.security.durationPlaceholder`)"
                  :aria-label="t(`admin.security.apiRateLimitBan`)" />
              </w-item-section>
            </w-item>
          </template>
        </w-card>
      </div>
      <div class="col-span-12 lg:col-span-6">
        <!-- ----------------------- -->
        <!-- Uploads -->
        <!-- ----------------------- -->
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.security.uploads') }}</w-card-header>
          <w-item class="pt-0">
            <w-item-section>
              <w-card class="bg-info text-white rounded">
                <w-card-section class="items-center" horizontal>
                  <w-card-section class="flex-none pe-0">
                    <w-icon name="la:info-circle" size="lg" />
                  </w-card-section>
                  <w-card-section class="text-caption">
                    <div>{{ t('admin.security.uploadsInfo') }}</div>
                  </w-card-section>
                </w-card-section>
              </w-card>
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="upload-to-the-cloud" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.maxUploadSize`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.security.maxUploadSizeHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section style="flex: 0 0 200px">
              <w-input
                v-model.number="state.humanUploadMaxFileSize"
                dense
                :aria-label="t(`admin.security.maxUploadSize`)" />
            </w-item-section>
          </w-item>
          <w-separator class="my-2" inset />
          <w-item tag="label">
            <blueprint-icon icon="scan-stock" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.scanSVG`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.security.scanSVGHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.uploadScanSVG"
                :loading="state.loading > 0"
                :aria-label="t(`admin.security.scanSVG`)" />
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- CORS -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.security.cors') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="firewall" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.corsMode`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.security.corsModeHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-select
                v-model="state.config.corsMode"
                :options="corsModes"
                option-value="value"
                option-label="text"
                emit-value
                map-options
                dense
                :aria-label="t(`admin.security.corsMode`)" />
            </w-item-section>
          </w-item>
          <template v-if="state.config.corsMode === `HOSTNAMES`">
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="todo-list" key="corsHostnames" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.corsHostnames`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.security.corsHostnamesHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section>
                <w-input
                  v-model="state.config.corsConfig"
                  dense
                  type="textarea"
                  :aria-label="t(`admin.security.corsHostnames`)" />
              </w-item-section>
            </w-item>
          </template>
          <template v-else-if="state.config.corsMode === `REGEX`">
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="validation" key="corsRegex" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.corsRegex`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.security.corsRegexHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section>
                <w-input
                  v-model="state.config.corsConfig"
                  dense
                  :aria-label="t(`admin.security.corsRegex`)" />
              </w-item-section>
            </w-item>
          </template>
        </w-card>
        <!-- ----------------------- -->
        <!-- CSP -->
        <!-- ----------------------- -->
        <w-card class="pb-2 mt-4">
          <w-card-header>{{ t('admin.security.csp') }}</w-card-header>
          <w-item tag="label">
            <blueprint-icon icon="data-protection" />
            <w-item-section>
              <w-item-label>{{ t(`admin.security.enforceCsp`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.security.enforceCspHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section avatar>
              <w-toggle
                v-model="state.config.enforceCsp"
                :loading="state.loading > 0"
                :aria-label="t(`admin.security.enforceCsp`)" />
            </w-item-section>
          </w-item>
          <template v-if="state.config.enforceCsp">
            <w-separator class="my-2" inset />
            <w-item>
              <blueprint-icon icon="code-file" key="cspDirectives" />
              <w-item-section>
                <w-item-label>{{ t(`admin.security.cspDirectives`) }}</w-item-label>
                <w-item-label caption>{{ t(`admin.security.cspDirectivesHint`) }}</w-item-label>
              </w-item-section>
              <w-item-section>
                <w-input
                  v-model="state.config.cspDirectives"
                  dense
                  type="textarea"
                  :placeholder="t(`admin.security.cspDirectivesPlaceholder`)"
                  :aria-label="t(`admin.security.cspDirectives`)" />
              </w-item-section>
            </w-item>
          </template>
        </w-card>
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
