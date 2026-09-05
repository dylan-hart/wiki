<template>
  <w-page class="admin-system">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:cpu" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.system.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.system.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/system`"
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
          class="acrylic-btn"
          flat
          icon="tabler:clipboard-text"
          :label="t('admin.system.copyInfo')"
          color="primary"
          :disabled="state.loading > 0"
          @click="copySysInfo" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-6">
        <!-- ----------------------- -->
        <!-- WIKI.JS -->
        <!-- ----------------------- -->
        <w-card class="pb-2">
          <w-card-header>Wiki.js</w-card-header>
          <w-item>
            <blueprint-icon icon="tabler:alert-triangle" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.currentVersion') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.currentVersionHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{
                state.info.currentVersion
              }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:cloud-check" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.latestVersion') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.latestVersionHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <div class="flex flex-wrap gap-2">
                <div class="min-w-0 flex-1">
                  <div class="text-caption dark-value">{{ state.info.latestVersion }}</div>
                </div>
                <div class="flex-none">
                  <w-btn
                    class="acrylic-btn"
                    flat
                    :color="dark.isActive ? `purple-3` : `purple`"
                    @click="checkForUpdates"
                    :label="t(`admin.system.checkUpdate`)" />
                </div>
              </div>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon
              icon="tabler:heart"
              :indicator="state.info.isSchedulerHealthy ? 'positive' : 'negative'"
              :indicator-text="
                state.info.isSchedulerHealthy
                  ? t('admin.system.schedulerHealthy')
                  : t('admin.system.schedulerUnhealthy')
              " />
            <w-item-section>
              <w-item-label>{{ t('admin.system.schedulerHealth') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.schedulerHealthHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{
                state.info.isSchedulerHealthy
                  ? t('admin.system.schedulerHealthy')
                  : t('admin.system.schedulerUnhealthy')
              }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:automatic-gearbox" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.upgradeCapable') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.upgradeCapableHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{
                state.info.upgradeCapable
                  ? t('admin.system.upgradeCapableYes')
                  : t('admin.system.upgradeCapableNo')
              }}</w-item-label>
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- CLIENT -->
        <!-- ----------------------- -->
        <w-card class="mt-4 pb-2">
          <w-card-header>{{ t('admin.system.client') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="tabler:layout-navbar" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.browser') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.browserHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ clientBrowser }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:device-desktop" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.clientPlatform') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.clientPlatformHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ clientPlatform }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:language" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.clientLanguage') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.clientLanguageHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ clientLanguage }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:cookie" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.clientCookies') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.clientCookiesHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ clientCookies }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:aspect-ratio" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.clientViewport') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.clientViewportHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ clientViewport }}</w-item-label>
            </w-item-section>
          </w-item>
        </w-card>
      </div>
      <div class="col-span-12 lg:col-span-6">
        <!-- ----------------------- -->
        <!-- ENGINES -->
        <!-- ----------------------- -->
        <w-card class="pb-2">
          <w-card-header>{{ t('admin.system.engines') }}</w-card-header>
          <w-item>
            <blueprint-icon icon="tabler:brand-nodejs" />
            <w-item-section>
              <w-item-label>Node.js</w-item-label>
              <w-item-label caption>{{ t('admin.system.nodejsHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ state.info.nodeVersion }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:database" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.database') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.databaseHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>PostgreSQL {{ dbVersion }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:database" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.databaseHost') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.databaseHostHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ state.info.dbHost }}</w-item-label>
            </w-item-section>
          </w-item>
        </w-card>
        <!-- ----------------------- -->
        <!-- HOST INFORMATION -->
        <!-- ----------------------- -->
        <w-card class="mt-4 pb-2">
          <w-card-header>{{ t('admin.system.hostInfo') }}</w-card-header>
          <w-item>
            <blueprint-icon :icon="platformLogo" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.os') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.osHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{
                state.info.platform === 'docker'
                  ? 'Docker Container (Linux)'
                  : state.info.operatingSystem
              }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:server" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.hostname') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.hostnameHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ state.info.hostname }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:cpu" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.cpuCores') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.cpuCoresHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ state.info.cpuCores }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:device-sd-card" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.totalRAM') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.totalRAMHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ state.info.ramTotal }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:app-window" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.workingDirectory') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.workingDirectoryHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{
                state.info.workingDirectory
              }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-separator inset />
          <w-item>
            <blueprint-icon icon="tabler:automatic-gearbox" />
            <w-item-section>
              <w-item-label>{{ t('admin.system.configFile') }}</w-item-label>
              <w-item-label caption>{{ t('admin.system.configFileHint') }}</w-item-label>
            </w-item-section>
            <w-item-section>
              <w-item-label class="dark-value" caption>{{ state.info.configFile }}</w-item-label>
            </w-item-section>
          </w-item>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { dialog } from '@/composables/dialog'
import { apiErrorMessage } from '@/helpers/apiError'
import { copyToClipboard } from '@/helpers/clipboard'

import { useSiteStore } from '@/stores/site'

import CheckUpdateDialog from '../components/CheckUpdateDialog.vue'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

// COMPOSABLES

const dark = useDark()

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.system.title')
}))

// DATA

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.system',
  // -> One instance's own report, not a site's settings: no site picker, no reload on switching site
  siteScoped: false,
  extraState: {
    isUpgrading: false,
    isUpgradingStarted: false,
    upgradeProgress: 0,
    info: {
      platform: ''
    }
  },
  fetch: () => API_CLIENT.get('system/info').json(),
  onLoaded: (info) => {
    state.info = info
  }
})

// COMPUTED

const dbVersion = computed(() => {
  return state.info?.dbVersion?.replace(/(?:\r\n|\r|\n)/g, ', ')
})
const platformLogo = computed(() => {
  switch (state.info.platform) {
    case 'docker':
      return 'docker-container'
    case 'darwin':
      return 'apple-logo'
    case 'linux':
      if (state.info.operatingSystem.indexOf('Ubuntu') >= 0) {
        return 'ubuntu'
      } else {
        return 'linux'
      }
    case 'win32':
      return 'windows8'
    default:
      return 'washing-machine'
  }
})
const clientBrowser = computed(() => navigator.userAgent)
const clientPlatform = computed(() => navigator.platform)
const clientLanguage = computed(() => navigator.language)
const clientCookies = computed(() => navigator.cookieEnabled)
const clientViewport = computed(
  () => `${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`
)

// METHODS

function checkForUpdates() {
  dialog({
    component: CheckUpdateDialog
  }).onDismiss(() => {
    load()
  })
}

async function copySysInfo() {
  const text = `Wiki.js ${state.info.currentVersion}
Postgres ${dbVersion.value}
Node.js ${state.info.nodeVersion}
OS: ${state.info.operatingSystem}
Platform: ${state.info.platform}
CPU Cores: ${state.info.cpuCores}
Total RAM: ${state.info.ramTotal}`

  try {
    await copyToClipboard(text)
    notify({
      type: 'positive',
      message: t('admin.system.copySuccess'),
      icon: 'tabler:clipboard'
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.system.copyFailed'),
      caption: apiErrorMessage(err)
    })
  }
}
</script>

<style lang="scss">
.admin-system {
  .v-list-item-title,
  .v-list-item__subtitle {
    user-select: text;
  }

  .dark-value {
    background-color: #f8f8f8;
    color: #333;
    padding: 8px 12px;
    font-family: 'Roboto Mono', Consolas, 'Liberation Mono', Courier, monospace;

    @at-root .body--dark & {
      background-color: $dark-4;
      color: #fff;
    }
  }
}
</style>
