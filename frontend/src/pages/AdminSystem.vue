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
        <w-settings-card title="Wiki.js">
          <w-settings-row
            icon="tabler:alert-triangle"
            :label="t('admin.system.currentVersion')"
            :hint="t('admin.system.currentVersionHint')">
            <div class="dark-value text-caption">{{ state.info.currentVersion }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:cloud-check"
            :label="t('admin.system.latestVersion')"
            :hint="t('admin.system.latestVersionHint')">
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
          </w-settings-row>
          <w-settings-row
            icon="tabler:heart"
            :indicator="state.info.isSchedulerHealthy ? 'positive' : 'negative'"
            :indicator-text="
              state.info.isSchedulerHealthy
                ? t('admin.system.schedulerHealthy')
                : t('admin.system.schedulerUnhealthy')
            "
            :label="t('admin.system.schedulerHealth')"
            :hint="t('admin.system.schedulerHealthHint')">
            <div class="dark-value text-caption">
              {{
                state.info.isSchedulerHealthy
                  ? t('admin.system.schedulerHealthy')
                  : t('admin.system.schedulerUnhealthy')
              }}
            </div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:automatic-gearbox"
            :label="t('admin.system.upgradeCapable')"
            :hint="t('admin.system.upgradeCapableHint')">
            <div class="dark-value text-caption">
              {{
                state.info.upgradeCapable
                  ? t('admin.system.upgradeCapableYes')
                  : t('admin.system.upgradeCapableNo')
              }}
            </div>
          </w-settings-row>
        </w-settings-card>
        <!-- ----------------------- -->
        <!-- CLIENT -->
        <!-- ----------------------- -->
        <w-settings-card class="mt-4" :title="t('admin.system.client')">
          <w-settings-row
            icon="tabler:layout-navbar"
            :label="t('admin.system.browser')"
            :hint="t('admin.system.browserHint')">
            <div class="dark-value text-caption">{{ clientBrowser }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:device-desktop"
            :label="t('admin.system.clientPlatform')"
            :hint="t('admin.system.clientPlatformHint')">
            <div class="dark-value text-caption">{{ clientPlatform }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:language"
            :label="t('admin.system.clientLanguage')"
            :hint="t('admin.system.clientLanguageHint')">
            <div class="dark-value text-caption">{{ clientLanguage }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:cookie"
            :label="t('admin.system.clientCookies')"
            :hint="t('admin.system.clientCookiesHint')">
            <div class="dark-value text-caption">{{ clientCookies }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:aspect-ratio"
            :label="t('admin.system.clientViewport')"
            :hint="t('admin.system.clientViewportHint')">
            <div class="dark-value text-caption">{{ clientViewport }}</div>
          </w-settings-row>
        </w-settings-card>
      </div>
      <div class="col-span-12 lg:col-span-6">
        <!-- ----------------------- -->
        <!-- ENGINES -->
        <!-- ----------------------- -->
        <w-settings-card :title="t('admin.system.engines')">
          <w-settings-row icon="tabler:brand-nodejs" :hint="t('admin.system.nodejsHint')">
            <template #label> Node.js </template>

            <div class="dark-value text-caption">{{ state.info.nodeVersion }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:database"
            :label="t('admin.system.database')"
            :hint="t('admin.system.databaseHint')">
            <div class="dark-value text-caption">PostgreSQL {{ dbVersion }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:database"
            :label="t('admin.system.databaseHost')"
            :hint="t('admin.system.databaseHostHint')">
            <div class="dark-value text-caption">{{ state.info.dbHost }}</div>
          </w-settings-row>
        </w-settings-card>
        <!-- ----------------------- -->
        <!-- HOST INFORMATION -->
        <!-- ----------------------- -->
        <w-settings-card class="mt-4" :title="t('admin.system.hostInfo')">
          <w-settings-row
            :icon="platformLogo"
            :label="t('admin.system.os')"
            :hint="t('admin.system.osHint')">
            <div class="dark-value text-caption">
              {{
                state.info.platform === 'docker'
                  ? 'Docker Container (Linux)'
                  : state.info.operatingSystem
              }}
            </div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:server"
            :label="t('admin.system.hostname')"
            :hint="t('admin.system.hostnameHint')">
            <div class="dark-value text-caption">{{ state.info.hostname }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:cpu"
            :label="t('admin.system.cpuCores')"
            :hint="t('admin.system.cpuCoresHint')">
            <div class="dark-value text-caption">{{ state.info.cpuCores }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:device-sd-card"
            :label="t('admin.system.totalRAM')"
            :hint="t('admin.system.totalRAMHint')">
            <div class="dark-value text-caption">{{ state.info.ramTotal }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:app-window"
            :label="t('admin.system.workingDirectory')"
            :hint="t('admin.system.workingDirectoryHint')">
            <div class="dark-value text-caption">{{ state.info.workingDirectory }}</div>
          </w-settings-row>
          <w-settings-row
            icon="tabler:automatic-gearbox"
            :label="t('admin.system.configFile')"
            :hint="t('admin.system.configFileHint')">
            <div class="dark-value text-caption">{{ state.info.configFile }}</div>
          </w-settings-row>
        </w-settings-card>
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
