<template>
  <w-page class="admin-extensions">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:puzzle" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">
          {{ t('admin.extensions.title') }}
        </h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.extensions.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:help-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/system/extensions`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn"
          icon="tabler:refresh"
          flat
          color="slate"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12">
        <w-card>
          <w-list separator>
            <w-item v-for="ext of state.extensions" :key="`ext-` + ext.key">
              <blueprint-icon icon="tabler:puzzle" />
              <w-item-section>
                <w-item-label class="flex items-center gap-2">
                  {{ ext.title }}
                  <w-badge v-if="ext.needsRestart" color="warning" text-color="black" rounded>
                    <w-icon name="tabler:alert-triangle" size="12px" />
                    <w-tooltip anchor="center left" self="center right">{{
                      t('admin.extensions.needsRestart')
                    }}</w-tooltip>
                  </w-badge>
                </w-item-label>
                <w-item-label caption>{{ ext.description }}</w-item-label>
                <w-item-label caption v-if="ext.website">
                  <a class="text-primary" :href="ext.website" target="_blank" rel="noopener">{{
                    ext.website
                  }}</a>
                </w-item-label>
              </w-item-section>
              <w-item-section side>
                <div class="flex flex-wrap items-center">
                  <div
                    v-if="state.installing[ext.key]"
                    class="flex items-center gap-2 text-caption text-grey"
                    role="status"
                    aria-live="polite">
                    <w-spinner size="16px" />
                    <div>
                      <div>{{ t('admin.extensions.installing') }}</div>
                      <div>{{ t('admin.extensions.installingHint') }}</div>
                      <!-- aria-hidden: the aria-live message above already announces the install;
                           re-announcing the elapsed time every second adds nothing actionable -->
                      <div aria-hidden="true">
                        {{
                          t('admin.extensions.installElapsed', {
                            time: formatElapsed(state.installing[ext.key].elapsedSeconds)
                          })
                        }}
                      </div>
                    </div>
                  </div>
                  <w-btn-group v-else>
                    <w-btn
                      icon="tabler:check"
                      size="sm"
                      color="positive"
                      padding="xs sm"
                      v-if="ext.isInstalled">
                      <w-tooltip labels anchor="center left" self="center right">{{
                        t('admin.extensions.installed')
                      }}</w-tooltip>
                    </w-btn>
                    <w-btn
                      :label="t(`admin.extensions.install`)"
                      color="blue-7"
                      v-if="ext.isCompatible && !ext.isInstalled && ext.isInstallable"
                      @click="install(ext)" />
                    <w-btn
                      v-else-if="ext.isCompatible && ext.isInstalled && ext.isInstallable"
                      :label="t(`admin.extensions.reinstall`)"
                      color="blue-7"
                      @click="install(ext)" />
                    <w-btn
                      v-else-if="ext.isCompatible && ext.isInstalled && !ext.isInstallable"
                      :label="t(`admin.extensions.installed`)"
                      color="positive" />
                    <w-btn
                      v-else-if="ext.isCompatible"
                      :label="t(`admin.extensions.instructions`)"
                      icon="tabler:info-circle"
                      color="indigo"
                      outline
                      :href="siteStore.docsBase + `/system/extensions#` + ext.key"
                      target="_blank">
                      <w-tooltip anchor="center left" self="center right">{{
                        t('admin.extensions.instructionsHint')
                      }}</w-tooltip>
                    </w-btn>
                    <w-btn
                      v-else
                      color="negative"
                      outline
                      :label="t(`admin.extensions.incompatible`)">
                      <w-tooltip
                        v-if="ext.incompatibleReason"
                        anchor="center left"
                        self="center right"
                        >{{ ext.incompatibleReason }}</w-tooltip
                      >
                    </w-btn>
                  </w-btn-group>
                </div>
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted, onUnmounted, reactive } from 'vue'
import { isTimeoutError } from 'ky'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'

import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.extensions.title')
}))

const state = reactive({
  loading: 0,
  extensions: [],
  /**
   * Page-local rather than the global `loading` overlay: a full-screen block for up to 20 minutes
   * is poor UX, and the overlay cannot carry a per-row message.
   * @type {Record<string, { startedAt: number, elapsedSeconds: number }>}
   */
  installing: {}
})

/** npm reports no percentage, so elapsed time is the only install progress signal available. */
function formatElapsed(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

let elapsedTicker = null

function ensureElapsedTicker() {
  if (elapsedTicker !== null) {
    return
  }
  elapsedTicker = setInterval(() => {
    const now = Date.now()
    for (const entry of Object.values(state.installing)) {
      entry.elapsedSeconds = Math.floor((now - entry.startedAt) / 1000)
    }
  }, 1000)
}

function stopElapsedTickerIfIdle() {
  if (elapsedTicker !== null && Object.keys(state.installing).length === 0) {
    clearInterval(elapsedTicker)
    elapsedTicker = null
  }
}

/**
 * The client's own default is ten seconds, which no npm install finishes inside: the request would
 * be abandoned while npm kept running server-side, reporting a failure for work about to succeed.
 * Matches the server's own ceiling on the same work.
 */
const INSTALL_TIMEOUT = 20 * 60 * 1000

async function load() {
  state.loading++
  loading.show()
  try {
    state.extensions = (await API_CLIENT.get('system/extensions').json()) ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.extensions.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
  state.loading--
}

async function install(ext) {
  state.installing[ext.key] = { startedAt: Date.now(), elapsedSeconds: 0 }
  ensureElapsedTicker()
  try {
    const resp = await API_CLIENT.post(`system/extensions/${ext.key}/install`, {
      timeout: INSTALL_TIMEOUT
    }).json()
    // -> A reinstall repairs the files on disk, but a server that already failed to load the module
    //    keeps failing until it restarts — so that answer is a warning, not a success
    notify({
      type: resp.restartRequired ? 'warning' : 'positive',
      message: resp.restartRequired
        ? t('admin.extensions.installRestartRequired')
        : t('admin.extensions.installSuccess'),
      timeout: resp.restartRequired ? 10000 : undefined
    })
    // -> Re-detect rather than assume: the install is only done once the server can see the tool
    await load()
  } catch (err) {
    // -> INSTALL_TIMEOUT firing while npm is still working server-side is indistinguishable from a
    //    real failure, and reporting it as one sends the administrator off to retry an install
    //    already in flight.
    if (isTimeoutError(err)) {
      notify({
        type: 'negative',
        message: t('admin.extensions.installTimedOut'),
        caption: t('admin.extensions.installTimedOutHint'),
        timeout: 0
      })
    } else {
      notify({
        type: 'negative',
        message: t('admin.extensions.installFailed'),
        caption: apiErrorMessage(err)
      })
    }
  }
  delete state.installing[ext.key]
  stopElapsedTickerIfIdle()
}

onMounted(() => {
  load()
})

onUnmounted(() => {
  if (elapsedTicker !== null) {
    clearInterval(elapsedTicker)
    elapsedTicker = null
  }
})
</script>
