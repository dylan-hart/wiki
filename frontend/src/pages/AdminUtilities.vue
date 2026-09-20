<template>
  <w-page class="admin-utilities">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:tool" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.utilities.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.utilities.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="me-2"
          icon="tabler:help-circle"
          outline
          color="slate-soft"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/utilities`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <div class="p-4 gap-4">
      <!--
        Each row is a fixed, design-time named action -- a label, a sentence, one trailing control --
        which is the settings row's own shape. No header strip: the page header above already names
        the card.
      -->
      <w-card>
        <w-settings-row
          icon="tabler:plug-connected-x"
          control-width="auto"
          :label="t(`admin.utilities.disconnectWS`)"
          :hint="t(`admin.utilities.disconnectWSHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            @click="disconnectWS"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <w-settings-row
          icon="tabler:database-export"
          control-width="auto"
          :label="t(`admin.utilities.export`)">
          <template #hint>
            <div>{{ t(`admin.utilities.exportHint`) }}</div>
            <div>{{ t(`admin.utilities.exportExclusions`) }}</div>
          </template>
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            :loading="state.isExporting"
            :aria-label="t(`admin.utilities.export`)"
            @click="exportContent"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <w-settings-row
          icon="tabler:stack-2"
          control-width="auto"
          :label="t(`admin.utilities.flushCache`)"
          :hint="t(`admin.utilities.flushCacheHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            @click="flushCache"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <w-settings-row
          icon="tabler:database-import"
          control-width="auto"
          :label="t(`admin.utilities.import`)"
          :hint="t(`admin.utilities.importHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            @click="pickImportFile"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <w-settings-row
          icon="tabler:flame"
          control-width="auto"
          :label="t(`admin.utilities.invalidApiCertificates`)"
          :hint="t(`admin.utilities.invalidApiCertificatesHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            @click="invalidateApiCertificates"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <w-settings-row
          icon="tabler:key"
          control-width="auto"
          :label="t(`admin.utilities.invalidSessionSecret`)"
          :hint="t(`admin.utilities.invalidSessionSecretHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            @click="invalidateSessionSecret"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <w-settings-row
          icon="tabler:fingerprint"
          control-width="auto"
          :label="t(`admin.utilities.rotatePageviewsHashKey`)"
          :hint="t(`admin.utilities.rotatePageviewsHashKeyHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            @click="rotatePageviewsHashKey"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <!--
          `WSettingsRow` has a single trailing slot by design, so the timeframe and the button that
          reads it go into it as one group rather than asking for a second slot.
        -->
        <w-settings-row
          icon="tabler:history"
          control-width="auto"
          :label="t(`admin.utilities.purgeHistory`)"
          :hint="t(`admin.utilities.purgeHistoryHint`)">
          <div class="flex items-center gap-2">
            <w-select
              :label="t(`admin.utilities.purgeHistoryTimeframe`)"
              v-model="state.purgeHistoryTimeframe"
              style="min-width: 175px"
              emit-value
              map-options
              dense
              :options="purgeHistoryTimeframes" />
            <w-separator vertical />
            <w-btn
              class="acrylic-btn"
              flat
              icon="tabler:circle-arrow-right"
              color="primary"
              @click="purgeHistory"
              :label="t(`common.actions.proceed`)" />
          </div>
        </w-settings-row>
        <w-settings-row
          icon="la:trash"
          control-width="auto"
          :label="t(`admin.utilities.purgeRevokedKeys`)"
          :hint="t(`admin.utilities.purgeRevokedKeysHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            @click="purgeRevokedKeys"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <w-settings-row
          icon="la:trash"
          control-width="auto"
          :label="t(`admin.utilities.purgeEmptyFolders`)"
          :hint="t(`admin.utilities.purgeEmptyFoldersHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            :aria-label="t(`admin.utilities.purgeEmptyFolders`)"
            @click="purgeEmptyFolders"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <w-settings-row
          icon="tabler:file-search"
          control-width="auto"
          :label="t(`admin.utilities.scanPageProblems`)"
          :hint="t(`admin.utilities.scanPageProblemsHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            :loading="state.isScanning"
            :aria-label="t(`admin.utilities.scanPageProblems`)"
            @click="scanPageProblems"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <w-settings-row
          icon="tabler:replace"
          control-width="auto"
          :label="t(`admin.utilities.wysiwygConvert`)"
          :hint="t(`admin.utilities.wysiwygConvertHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            :loading="state.isConvertingWysiwyg"
            :aria-label="t(`admin.utilities.wysiwygConvert`)"
            @click="convertWysiwygJson"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
      </w-card>
      <w-card v-if="userStore.can('manage:system')" class="mt-4">
        <w-card-header>{{ t('admin.utilities.sampleContentTitle') }}</w-card-header>
        <w-settings-row
          icon="tabler:seeding"
          control-width="auto"
          :label="t(`admin.utilities.sampleContentGenerate`)"
          :hint="t(`admin.utilities.sampleContentGenerateHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            :aria-label="t(`admin.utilities.sampleContentGenerate`)"
            @click="generateSampleContent"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
        <w-settings-row
          icon="la:trash"
          control-width="auto"
          :label="t(`admin.utilities.sampleContentPurge`)"
          :hint="t(`admin.utilities.sampleContentPurgeHint`)">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:circle-arrow-right"
            color="primary"
            :aria-label="t(`admin.utilities.sampleContentPurge`)"
            @click="purgeSampleContent"
            :label="t(`common.actions.proceed`)" />
        </w-settings-row>
      </w-card>
      <w-card v-if="state.wysiwygConvertReport" class="mt-4">
        <w-card-header>
          {{ t('admin.utilities.wysiwygConvertResults') }}
          <template #hint>{{
            t(
              'admin.utilities.wysiwygConvertConvertedCount',
              state.wysiwygConvertReport.convertedCount,
              {
                count: state.wysiwygConvertReport.convertedCount
              }
            )
          }}</template>
        </w-card-header>
        <div
          v-if="state.wysiwygConvertReport.failed.length === 0"
          class="p-4 text-center text-grey">
          {{ t('admin.utilities.wysiwygConvertNone') }}
        </div>
        <w-list v-else dense separator>
          <w-item v-for="entry of state.wysiwygConvertReport.failed" :key="entry.id">
            <w-item-section>
              <w-item-label class="font-robotomono"
                >/{{ entry.path }} ({{ entry.locale }}) — {{ entry.reason }}</w-item-label
              >
            </w-item-section>
          </w-item>
        </w-list>
      </w-card>
      <!--
        Inline rather than a dialog: a run's value is the list of what it found, read beside the
        button that ran it rather than behind another click. Same for the conversion report above.
      -->
      <w-card v-if="state.scanReport" class="mt-4">
        <w-card-header>
          {{ t('admin.utilities.scanPageProblemsResults') }}
          <template #hint>{{
            t('admin.utilities.scanPageProblemsScannedAt', { date: scanReportScannedAt })
          }}</template>
        </w-card-header>
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
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.utilities.title')
}))

const state = reactive({
  purgeHistoryTimeframe: '1y',
  isScanning: false,
  isExporting: false,
  isConvertingWysiwyg: false,
  scanReport: null,
  wysiwygConvertReport: null
})

const importFileIpt = ref(null)

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

/** Each entry renders as one readable line: a raw dump of every field is harder to scan. */
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

/**
 * Confirmed because it interrupts people who are working: clients reconnect on their own, but an
 * editor is briefly cut off from the others in its room.
 *
 * This and {@link flushCache} reach every instance — the one answering publishes the same
 * instruction to the rest — so the response's `count` covers only this instance's own closures and
 * is not reported.
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
 * Replaces the keypair API keys are signed with, taking back every key ever issued. Nobody is logged
 * out — session cookies are signed with a secret of their own, which is the point of the two being
 * separate — but every integration holding a key stops working until it is given a new one, so the
 * confirmation reports how many are affected rather than asking blind.
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
 * Ends every session including this one, which the confirmation says outright. Nothing is notified
 * on success for that reason — the login screen loads while the notification is still on its way.
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
      // -> A full load rather than a route push: every store still holds the state of somebody who
      //    is no longer signed in.
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
 * Existing `visitorHash` rows are left untouched but stop correlating with anything logged from here
 * on — the point of rotating, and what the confirmation says. Nothing else in the app keys off
 * `pageviews.hashKey`, so nobody is logged out and nothing else stops working.
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
 * Every site, not only the current one. A version discarded here is gone for good, and the versions
 * of a deleted page are all that is left of it — hence the destructive confirmation.
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

/** Nothing loses access: a revoked key already had none. What goes is the record that it existed. */
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

async function purgeEmptyFolders() {
  const url = `sites/${siteStore.id}/tree/folders/purge-empty`
  loading.show()
  let found
  try {
    const dryRun = await API_CLIENT.post(url, { json: { dryRun: true } }).json()
    found = dryRun.count ?? 0
  } catch (err) {
    loading.hide()
    notify({
      type: 'negative',
      message: t('admin.utilities.purgeEmptyFoldersFailed'),
      caption: apiErrorMessage(err)
    })
    return
  }
  loading.hide()

  if (found === 0) {
    notify({ type: 'info', message: t('admin.utilities.purgeEmptyFoldersNone') })
    return
  }

  confirm({
    title: t('admin.utilities.purgeEmptyFolders'),
    message: t('admin.utilities.purgeEmptyFoldersConfirm', found, { count: found }),
    caption: t('admin.utilities.purgeEmptyFoldersConfirmWarn'),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.proceed')
  }).onOk(async () => {
    loading.show()
    try {
      const resp = await API_CLIENT.post(url, { json: { dryRun: false } }).json()
      const count = resp.count ?? 0
      notify({
        type: 'positive',
        message: t('admin.utilities.purgeEmptyFoldersSuccess', count, { count })
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.utilities.purgeEmptyFoldersFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

function generateSampleContent() {
  confirm({
    title: t('admin.utilities.sampleContentGenerate'),
    message: t('admin.utilities.sampleContentGenerateConfirm', { site: siteStore.hostname }),
    cancel: true,
    persistent: true,
    okLabel: t('common.actions.proceed')
  }).onOk(async () => {
    loading.show()
    try {
      const resp = await API_CLIENT.post('system/sampleContent/generate', {
        json: { siteId: siteStore.id }
      }).json()
      const count = resp.count ?? 0
      notify({
        type: 'positive',
        message: t('admin.utilities.sampleContentGenerateSuccess', count, { count })
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.utilities.sampleContentGenerateFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

function purgeSampleContent() {
  confirm({
    title: t('admin.utilities.sampleContentPurge'),
    message: t('admin.utilities.sampleContentPurgeConfirm', { site: siteStore.hostname }),
    caption: t('admin.utilities.sampleContentPurgeConfirmWarn'),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t('common.actions.proceed')
  }).onOk(async () => {
    loading.show()
    try {
      const resp = await API_CLIENT.post('system/sampleContent/purge', {
        json: { siteId: siteStore.id }
      }).json()
      const count = resp.count ?? 0
      notify({
        type: 'positive',
        message: t('admin.utilities.sampleContentPurgeSuccess', count, { count })
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.utilities.sampleContentPurgeFailed'),
        caption: apiErrorMessage(err)
      })
    }
    loading.hide()
  })
}

const EXPORT_POLL_INTERVAL_MS = 1500

/**
 * There is no separate status route for an export job — `GET /export/:jobId/download` itself answers
 * 409 while the job is still running — so the poll and the fetch of the finished archive are the
 * same call.
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

function pickImportFile() {
  importFileIpt.value.click()
}

/**
 * The confirmation names the site by hostname: what the import is about to overwrite is not obvious
 * from the button alone. The body is the raw file, not a multipart form.
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

/** Not confirmed: nothing is lost and nothing stops working, the next request pays for the refill. */
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

const SCAN_POLL_INTERVAL_MS = 1500

/** Not confirmed: the scan only reads. */
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

const WYSIWYG_CONVERT_POLL_INTERVAL_MS = 1500

/**
 * Not confirmed: what changes is how a row is encoded, not what it says, and every row it touches is
 * already labeled as this editor's own content.
 */
async function convertWysiwygJson() {
  state.isConvertingWysiwyg = true
  state.wysiwygConvertReport = null
  try {
    const queued = await API_CLIENT.post('system/wysiwyg/convert').json()
    if (!queued?.id) {
      throw new Error(t('common.error.unexpected'))
    }

    let job
    do {
      await new Promise((resolve) => setTimeout(resolve, WYSIWYG_CONVERT_POLL_INTERVAL_MS))
      job = await API_CLIENT.get(`system/wysiwyg/convert/${queued.id}`).json()
    } while (job.state === 'queued' || job.state === 'active')

    if (job.state !== 'completed' || !job.result) {
      throw new Error(t('admin.utilities.wysiwygConvertFailed'))
    }

    state.wysiwygConvertReport = job.result
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.utilities.wysiwygConvertFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.isConvertingWysiwyg = false
}
</script>

<style></style>
