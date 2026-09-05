<template>
  <w-page class="admin-utilities">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-swiss-army-knife-animated.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.utilities.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.utilities.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="la:question-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/utilities`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <w-separator inset />
    <div class="p-4 gap-4">
      <w-card>
        <w-list separator>
          <w-item>
            <blueprint-icon icon="disconnected" :hue-rotate="45" />
            <w-item-section>
              <w-item-label>{{ t(`admin.utilities.disconnectWS`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.utilities.disconnectWSHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:arrow-circle-right"
                color="primary"
                @click="disconnectWS"
                :label="t(`common.actions.proceed`)" />
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="database-export" :hue-rotate="45" />
            <w-item-section>
              <w-item-label>{{ t(`admin.utilities.export`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.utilities.exportHint`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.utilities.exportExclusions`) }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:arrow-circle-right"
                color="primary"
                :loading="state.isExporting"
                :aria-label="t(`admin.utilities.export`)"
                @click="exportContent"
                :label="t(`common.actions.proceed`)" />
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="datalake" :hue-rotate="45" />
            <w-item-section>
              <w-item-label>{{ t(`admin.utilities.flushCache`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.utilities.flushCacheHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:arrow-circle-right"
                color="primary"
                @click="flushCache"
                :label="t(`common.actions.proceed`)" />
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="database-restore" :hue-rotate="45" />
            <w-item-section>
              <w-item-label>{{ t(`admin.utilities.import`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.utilities.importHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:arrow-circle-right"
                color="primary"
                @click="pickImportFile"
                :label="t(`common.actions.proceed`)" />
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="matches" :hue-rotate="45" />
            <w-item-section>
              <w-item-label>{{ t(`admin.utilities.invalidApiCertificates`) }}</w-item-label>
              <w-item-label caption>{{
                t(`admin.utilities.invalidApiCertificatesHint`)
              }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:arrow-circle-right"
                color="primary"
                @click="invalidateApiCertificates"
                :label="t(`common.actions.proceed`)" />
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="key" :hue-rotate="45" />
            <w-item-section>
              <w-item-label>{{ t(`admin.utilities.invalidSessionSecret`) }}</w-item-label>
              <w-item-label caption>{{
                t(`admin.utilities.invalidSessionSecretHint`)
              }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:arrow-circle-right"
                color="primary"
                @click="invalidateSessionSecret"
                :label="t(`common.actions.proceed`)" />
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="fingerprint-scan" :hue-rotate="45" />
            <w-item-section>
              <w-item-label>{{ t(`admin.utilities.rotatePageviewsHashKey`) }}</w-item-label>
              <w-item-label caption>{{
                t(`admin.utilities.rotatePageviewsHashKeyHint`)
              }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:arrow-circle-right"
                color="primary"
                @click="rotatePageviewsHashKey"
                :label="t(`common.actions.proceed`)" />
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="historical" :hue-rotate="45" />
            <w-item-section>
              <w-item-label>{{ t(`admin.utilities.purgeHistory`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.utilities.purgeHistoryHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-select
                :label="t(`admin.utilities.purgeHistoryTimeframe`)"
                v-model="state.purgeHistoryTimeframe"
                style="min-width: 175px"
                emit-value
                map-options
                dense
                :options="purgeHistoryTimeframes" />
            </w-item-section>
            <w-separator class="ms-2" vertical />
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:arrow-circle-right"
                color="primary"
                @click="purgeHistory"
                :label="t(`common.actions.proceed`)" />
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="trash" :hue-rotate="45" />
            <w-item-section>
              <w-item-label>{{ t(`admin.utilities.purgeRevokedKeys`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.utilities.purgeRevokedKeysHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:arrow-circle-right"
                color="primary"
                @click="purgeRevokedKeys"
                :label="t(`common.actions.proceed`)" />
            </w-item-section>
          </w-item>
          <w-item>
            <blueprint-icon icon="rescan-document" :hue-rotate="45" />
            <w-item-section>
              <w-item-label>{{ t(`admin.utilities.scanPageProblems`) }}</w-item-label>
              <w-item-label caption>{{ t(`admin.utilities.scanPageProblemsHint`) }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:arrow-circle-right"
                color="primary"
                :loading="state.isScanning"
                :aria-label="t(`admin.utilities.scanPageProblems`)"
                @click="scanPageProblems"
                :label="t(`common.actions.proceed`)" />
            </w-item-section>
          </w-item>
        </w-list>
      </w-card>
      <!--
        Inline rather than a dialog or the scheduler's history view: the value of this scan is the
        list of what it found, and an admin reviewing that wants it beside the button that ran it, not
        behind another click.
      -->
      <w-card v-if="state.scanReport" class="mt-4">
        <w-card-section>
          <div class="text-subtitle1">{{ t('admin.utilities.scanPageProblemsResults') }}</div>
          <div class="text-caption text-grey">
            {{ t('admin.utilities.scanPageProblemsScannedAt', { date: scanReportScannedAt }) }}
          </div>
        </w-card-section>
        <w-separator />
        <div v-if="!scanReportHasProblems" class="p-4 text-center text-grey">
          {{ t('admin.utilities.scanPageProblemsNone') }}
        </div>
        <w-list v-else separator>
          <w-expansion-item
            v-for="check of scanChecks"
            :key="check.key"
            v-show="check.entries.length > 0"
            :label="`${check.label} (${check.entries.length})`">
            <w-list dense separator class="ps-4">
              <w-item v-for="(entry, idx) of check.entries" :key="idx">
                <w-item-section>
                  <w-item-label class="font-robotomono">{{ check.format(entry) }}</w-item-label>
                </w-item-section>
              </w-item>
            </w-list>
          </w-expansion-item>
        </w-list>
      </w-card>
    </div>
    <input
      type="file"
      ref="importFileIpt"
      accept=".gz,.tgz,application/gzip"
      @change="importFileSelected"
      style="display: none" />
  </w-page>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { loading } from '@/composables/loading'
import { confirm } from '@/composables/dialog'
import { apiErrorMessage } from '@/helpers/apiError'
import { fileSave } from 'browser-fs-access'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.utilities.title')
}))

// DATA

const state = reactive({
  purgeHistoryTimeframe: '1y',
  isScanning: false,
  isExporting: false,
  /** The last completed scan's report, or null before one has run. See `scanPageProblems`. */
  scanReport: null
})

const importFileIpt = ref(null)

// COMPUTED

const purgeHistoryTimeframes = computed(() => [
  { value: '24h', label: t('admin.utilities.purgeHistoryToday') },
  { value: '1m', label: t('admin.utilities.purgeHistoryMonth', 1, { count: 1 }) },
  { value: '3m', label: t('admin.utilities.purgeHistoryMonth', 3, { count: 3 }) },
  { value: '6m', label: t('admin.utilities.purgeHistoryMonth', 6, { count: 6 }) },
  { value: '1y', label: t('admin.utilities.purgeHistoryYear', 1, { count: 1 }) },
  { value: '2y', label: t('admin.utilities.purgeHistoryYear', 2, { count: 2 }) }
])

const scanReportScannedAt = computed(() => {
  if (!state.scanReport?.scannedAt) {
    return ''
  }
  return userStore.formatDateTime(t, state.scanReport.scannedAt, { seconds: true })
})

/**
 * The report's five checks, each with its entries rendered as one readable line — a raw dump of
 * every field would be harder to scan than the sentence a human would write about it.
 */
const scanChecks = computed(() => {
  if (!state.scanReport) {
    return []
  }
  return [
    {
      key: 'hashDrift',
      label: t('admin.utilities.scanPageProblemsHashDrift'),
      entries: state.scanReport.hashDrift.entries,
      format: (e) => `/${e.path} — stored ${e.storedHash}, expected ${e.expectedHash}`
    },
    {
      key: 'treeDivergence',
      label: t('admin.utilities.scanPageProblemsTreeDivergence'),
      entries: state.scanReport.treeDivergence.entries,
      format: (e) =>
        e.direction === 'orphanTreeEntry'
          ? t('admin.utilities.scanPageProblemsOrphanTreeEntry', { path: e.path })
          : t('admin.utilities.scanPageProblemsOrphanPageRow', { path: e.path })
    },
    {
      key: 'duplicatePaths',
      label: t('admin.utilities.scanPageProblemsDuplicatePaths'),
      entries: state.scanReport.duplicatePaths.entries,
      format: (e) => `/${e.path} (${e.locale}) — ${e.pageIds.length} pages: ${e.pageIds.join(', ')}`
    },
    {
      key: 'brokenRelations',
      label: t('admin.utilities.scanPageProblemsBrokenRelations'),
      entries: state.scanReport.brokenRelations.entries,
      format: (e) => `/${e.path} → ${e.target}`
    },
    {
      key: 'localeCollisions',
      label: t('admin.utilities.scanPageProblemsLocaleCollisions'),
      entries: state.scanReport.localeCollisions.entries,
      format: (e) =>
        `[${e.table}] /${e.path} (${e.locale}) — starts with locale code "${e.collidingCode}"`
    }
  ]
})

const scanReportHasProblems = computed(() =>
  scanChecks.value.some((check) => check.entries.length > 0)
)

// METHODS

/**
 * Close every websocket the wiki holds — the editors of anyone collaborating on a page, and any open
 * admin terminal. Confirmed first because it interrupts people who are working: their clients
 * reconnect on their own, but an editor is briefly cut off from the others in its room.
 *
 * Both this and {@link flushCache} reach every instance: the one answering the request acts on itself
 * and publishes the same instruction to the others. `count` in the response is therefore only what
 * this one closed, which is why it is not reported.
 */
function disconnectWS() {
  confirm({
    title: t('admin.utilities.disconnectWS'),
    message: t('admin.utilities.disconnectWSConfirm'),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.proceed')
  }).onOk(async () => {
    loading.show()
    try {
      await API_CLIENT.post('system/websockets/disconnect').json()
      notify({
        type: 'positive',
        message: t('admin.utilities.disconnectWSSuccess')
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.utilities.disconnectWSFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

/**
 * Replace the keypair API keys are signed with, taking back every key ever issued.
 *
 * Nobody is logged out by this — session cookies are signed with a secret of their own, which is the
 * point of the two being separate — but every integration holding a key stops working until it is
 * given a new one, so the confirmation says how many are affected rather than asking blind.
 */
function invalidateApiCertificates() {
  confirm({
    title: t('admin.utilities.invalidApiCertificates'),
    message: t('admin.utilities.invalidApiCertificatesConfirm'),
    caption: t('admin.utilities.invalidApiCertificatesConfirmWarn'),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.proceed')
  }).onOk(async () => {
    loading.show()
    try {
      const resp = await API_CLIENT.post('system/certificates').json()
      const count = resp.invalidatedKeys ?? 0
      notify({
        type: 'positive',
        message: t('admin.utilities.invalidApiCertificatesSuccess', count, { count })
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.utilities.invalidApiCertificatesFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

/**
 * Rotate the secret session cookies are signed with, and end every session.
 *
 * Including this one: the admin who clicks it is logged out with everybody else, which the
 * confirmation says outright. Nothing is notified afterwards for that reason — the router lands on
 * the login screen while the notification would still be on its way.
 */
function invalidateSessionSecret() {
  confirm({
    title: t('admin.utilities.invalidSessionSecret'),
    message: t('admin.utilities.invalidSessionSecretConfirm'),
    caption: t('admin.utilities.invalidSessionSecretConfirmWarn'),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.proceed')
  }).onOk(async () => {
    loading.show()
    try {
      await API_CLIENT.post('system/sessions/invalidate').json()
      // -> This session is one of the ones just ended, so there is nowhere to go but back to the
      //    login screen. A full load rather than a route push: every store is holding the state of
      //    somebody who is no longer signed in.
      window.location.assign('/login')
    } catch (err) {
      loading.hide()
      notify({
        type: 'negative',
        message: t('admin.utilities.invalidSessionSecretFailed'),
        caption: apiErrorMessage(err)
      })
    }
  })
}

/**
 * Rotate the key pageview `visitorHash` rows are keyed with (OpenProject #2288).
 *
 * Existing rows are left untouched, but they stop correlating with anything logged from here on —
 * the confirmation says so, since that is the entire point of rotating rather than a side effect to
 * apologize for. Unlike {@link invalidateSessionSecret}, nobody is logged out and nothing else stops
 * working: no other part of the app keys off `pageviews.hashKey`.
 */
function rotatePageviewsHashKey() {
  confirm({
    title: t('admin.utilities.rotatePageviewsHashKey'),
    message: t('admin.utilities.rotatePageviewsHashKeyConfirm'),
    caption: t('admin.utilities.rotatePageviewsHashKeyConfirmWarn'),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.proceed')
  }).onOk(async () => {
    loading.show()
    try {
      const resp = await API_CLIENT.post('system/pageviews/rotate-key').json()
      if (!resp?.ok) {
        throw new Error(resp?.message || t('common.error.unexpected'))
      }
      notify({
        type: 'positive',
        message: t('admin.utilities.rotatePageviewsHashKeySuccess')
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.utilities.rotatePageviewsHashKeyFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

/**
 * Delete every page version older than the selected timeframe, on every site.
 *
 * Confirmed, and named in the confirmation: pages keep what they say now, but a version thrown away
 * here is gone for good — and the versions of a page somebody deleted are all that is left of it.
 */
function purgeHistory() {
  const timeframe = purgeHistoryTimeframes.value.find(
    (tf) => tf.value === state.purgeHistoryTimeframe
  )
  confirm({
    title: t('admin.utilities.purgeHistory'),
    message: t('admin.utilities.purgeHistoryConfirm', { timeframe: timeframe?.label ?? '' }),
    caption: t('admin.utilities.purgeHistoryConfirmWarn'),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.proceed')
  }).onOk(async () => {
    loading.show()
    try {
      const resp = await API_CLIENT.post('system/history/purge', {
        json: { olderThan: state.purgeHistoryTimeframe }
      }).json()
      const count = resp.count ?? 0
      notify({
        type: 'positive',
        message: t('admin.utilities.purgeHistorySuccess', count, { count })
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.utilities.purgeHistoryFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

/**
 * Delete the rows of keys somebody revoked.
 *
 * Confirmed, but not coloured as a destruction: nothing loses access here, since a revoked key
 * already had none. What goes is the record that it existed.
 */
function purgeRevokedKeys() {
  confirm({
    title: t('admin.utilities.purgeRevokedKeys'),
    message: t('admin.utilities.purgeRevokedKeysConfirm'),
    caption: t('admin.utilities.purgeRevokedKeysConfirmWarn'),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.proceed')
  }).onOk(async () => {
    loading.show()
    try {
      const resp = await API_CLIENT.post('system/api-keys/purge').json()
      const count = resp.count ?? 0
      notify({
        type: 'positive',
        message: t('admin.utilities.purgeRevokedKeysSuccess', count, { count })
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.utilities.purgeRevokedKeysFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

/** How long to wait between polls of a running export's download route. */
const EXPORT_POLL_INTERVAL_MS = 1500

/**
 * Queue a content export for the current site, then poll the download route until the job is done
 * and save the resulting tarball.
 *
 * There is no separate status route for an export job — `GET /export/:jobId/download` itself answers
 * 409 while the job is still running, so polling it directly is also the same call that fetches the
 * finished archive, with no extra round-trip once it succeeds.
 */
async function exportContent() {
  state.isExporting = true
  try {
    const queued = await API_CLIENT.post('system/export', {
      json: { siteId: siteStore.id }
    }).json()
    if (!queued?.id) {
      throw new Error(t('common.error.unexpected'))
    }

    let blob
    for (;;) {
      try {
        blob = await API_CLIENT.get(`system/export/${queued.id}/download`).blob()
        break
      } catch (err) {
        if (err?.response?.status !== 409) {
          throw err
        }
      }
      await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_INTERVAL_MS))
    }

    await fileSave(blob, {
      fileName: `export-${queued.id}.tar.gz`,
      extensions: ['.gz']
    })
    notify({
      type: 'positive',
      message: t('admin.utilities.exportSuccess')
    })
  } catch (err) {
    // -> Dismissing the save picker is not a failure
    if (err.name !== 'AbortError') {
      notify({
        type: 'negative',
        message: t('admin.utilities.exportFailed'),
        caption: apiErrorMessage(err)
      })
    }
  }
  state.isExporting = false
}

/**
 * Open the file picker for a content archive to import. The actual upload happens in
 * {@link importFileSelected} once a file has been chosen, so this only ever triggers the native
 * dialog.
 */
function pickImportFile() {
  importFileIpt.value.click()
}

/**
 * Confirm, then upload the picked archive and queue its restore into the current site.
 *
 * Confirmed and coloured as a destruction, matching `purgeHistory`/`invalidApiCertificates`: unlike
 * those, this one names the site by hostname, since what it is about to overwrite is not obvious from
 * the button alone. The body is the raw file (not a multipart form), same pattern `FileManager.vue`
 * uses to upload an asset.
 */
function importFileSelected() {
  const file = importFileIpt.value.files?.[0]
  if (!file) {
    return
  }

  confirm({
    title: t('admin.utilities.import'),
    message: t('admin.utilities.importConfirm', { site: siteStore.hostname }),
    caption: t('admin.utilities.importConfirmWarn'),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.proceed')
  })
    .onOk(async () => {
      loading.show()
      try {
        await API_CLIENT.post('system/import', {
          searchParams: { targetSiteId: siteStore.id },
          headers: {
            'content-type': file.type || 'application/gzip'
          },
          body: file
        }).json()
        notify({
          type: 'positive',
          message: t('admin.utilities.importSuccess')
        })
      } catch (err) {
        notify({
          type: 'negative',
          message: t('admin.utilities.importFailed'),
          caption: apiErrorMessage(err)
        })
      }
      loading.hide()
    })
    .onDismiss(() => {
      importFileIpt.value.value = null
    })
}

/**
 * Throw away everything the wiki has cached off the database — files, icons, and the site, group and
 * locale state read on every request. Not confirmed: nothing is lost and nothing stops working, the
 * next request simply pays for the refill.
 */
async function flushCache() {
  loading.show()
  try {
    await API_CLIENT.post('system/cache/flush').json()
    notify({
      type: 'positive',
      message: t('admin.utilities.flushCacheSuccess')
    })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.utilities.flushCacheFailed'),
      caption: apiErrorMessage(err)
    })
  }
  loading.hide()
}

/** How long to wait between polls of a running scan job. */
const SCAN_POLL_INTERVAL_MS = 1500

/**
 * Queue a page problems scan and poll its job until it finishes, then show the report inline (see the
 * template) rather than just a toast — a scan's whole value is the list of what it found.
 *
 * Not confirmed: this only reads, nothing it does is destructive.
 */
async function scanPageProblems() {
  state.isScanning = true
  state.scanReport = null
  try {
    const queued = await API_CLIENT.post('system/pages/scan').json()
    if (!queued?.id) {
      throw new Error(t('common.error.unexpected'))
    }

    let job
    do {
      await new Promise((resolve) => setTimeout(resolve, SCAN_POLL_INTERVAL_MS))
      job = await API_CLIENT.get(`system/pages/scan/${queued.id}`).json()
    } while (job.state === 'queued' || job.state === 'active')

    if (job.state !== 'completed' || !job.result) {
      throw new Error(t('admin.utilities.scanPageProblemsFailed'))
    }

    state.scanReport = job.result
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.utilities.scanPageProblemsFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.isScanning = false
}
</script>

<style lang="scss"></style>
