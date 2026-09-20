<template>
  <w-page>
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:list-search" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.glossary.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.glossary.subtitle') }}
        </div>
      </div>
      <div class="flex flex-none flex-wrap items-center">
        <!-- -> `pdfExportAvailable` is the Puppeteer-availability signal: without it a rerender
                would only 503, so the button is hidden rather than shown and refused. -->
        <w-btn
          v-if="siteStore.pdfExportAvailable"
          class="acrylic-btn me-2"
          icon="tabler:wand"
          flat
          color="indigo"
          @click="rerenderAllPages">
          <w-tooltip labels>{{ t('admin.glossary.rerenderAllPagesHint') }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:history"
          flat
          color="indigo"
          @click="openVersionHistory">
          <w-tooltip labels>{{ t('admin.glossary.versionHistory') }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:file-export"
          flat
          color="indigo"
          @click="exportGlossary">
          <w-tooltip labels>{{ t('common.actions.export') }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:file-import"
          flat
          color="indigo"
          @click="openImportDialog">
          <w-tooltip labels>{{ t('common.actions.import') }}</w-tooltip>
        </w-btn>
        <w-btn
          v-if="isDirty"
          class="acrylic-btn me-2"
          :label="t(`common.actions.discard`)"
          flat
          color="grey"
          @click="discardChanges" />
        <w-btn
          class="acrylic-btn me-2"
          :label="t('admin.glossary.saveGlossary')"
          color="positive"
          :disabled="!isDirty"
          :loading="state.saving"
          @click="saveGlossary" />
        <w-btn
          icon="tabler:plus"
          :label="t(`admin.glossary.newTerm`)"
          color="primary"
          @click="createTerm" />
      </div>
    </div>
    <div class="p-4">
      <w-banner
        v-if="state.terms.length < 1 && state.loading < 1"
        :class="dark.isActive ? `bg-dark-3 text-grey-4` : `bg-grey-2 text-grey-8`">
        {{ t('admin.glossary.noTerms') }}
      </w-banner>
      <w-settings-card v-else :title="t('admin.glossary.title')">
        <w-settings-row
          v-for="term of state.terms"
          :key="term._key"
          control-width="auto"
          icon="tabler:quote">
          <template #label>
            <strong>{{ term.term }}</strong>
            <w-chip
              v-if="term.isAcronym"
              dense
              size="sm"
              class="ms-2"
              icon="tabler:square-letter-a">
              {{ t('admin.glossary.isAcronym') }}
            </w-chip>
          </template>
          <template #hint>
            <div>{{ term.definition }}</div>
            <div v-if="term.aliases?.length" class="flex flex-wrap gap-1 mt-1">
              <w-chip
                v-for="alias of term.aliases"
                :key="alias.value"
                dense
                :icon="alias.isAcronym ? 'tabler:square-letter-a' : null">
                {{ alias.value }}
              </w-chip>
            </div>
            <div v-if="term.path">
              <w-icon name="tabler:link" size="12px" class="me-1" />
              /{{ term.path }}
            </div>
          </template>
          <div class="flex items-center gap-2">
            <w-btn
              class="acrylic-btn"
              flat
              @click="editTerm(term)"
              icon="tabler:pencil"
              :color="dark.isActive ? `indigo-4` : `indigo`"
              :label="t(`common.actions.edit`)" />
            <w-btn
              class="acrylic-btn"
              flat
              icon="tabler:trash"
              color="negative"
              @click="deleteTerm(term)"
              :aria-label="t(`common.actions.delete`)" />
          </div>
        </w-settings-row>
      </w-settings-card>
    </div>
    <w-inner-loading :showing="state.loading > 0" />
  </w-page>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { fileSave } from 'browser-fs-access'

import { useAdminSettings } from '@/composables/adminSettings'
import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm, dialog } from '@/composables/dialog'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'

import GlossaryImportDialog from '@/components/GlossaryImportDialog.vue'
import GlossaryTermDialog from '@/components/GlossaryTermDialog.vue'
import GlossaryVersionHistoryDialog from '@/components/GlossaryVersionHistoryDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

/*
  No `useSiteAdminAccess()` here: this page carries no site-admin delegation of its own. It is gated
  on `manage:glossary` — by the sidebar entry in `AdminLayout.vue`, and by every `api/glossary.ts`
  route server-side.

  Editing is staged: `state.terms` is a local working copy that the add/edit/remove buttons touch,
  and nothing reaches the server until "Save Glossary", which atomically replaces the whole live
  glossary and records a version snapshot. An entry is the same JSON shape
  `GET .../glossary/export` returns and `POST .../glossary/{save,import}` accept, so load, save,
  export and import all speak one shape; `_key` is client-only and stripped before sending.
*/

const dark = useDark()

const adminStore = useAdminStore()
const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.glossary.title')
}))

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.glossary',
  // -> A staged-edit list, not a settings form: "Save Glossary" drives its own `state.saving`
  //    button, so the full-screen overlay would only get in the way.
  overlay: false,
  extraState: {
    saving: false,
    terms: [],
    /** Serialised `stripKeys(state.terms)` as of the last load or save; `isDirty` diffs against it. */
    baseline: '[]'
  },
  fetch: (siteId) => API_CLIENT.get(`sites/${siteId}/glossary/export`).json(),
  onLoaded: (exported) => {
    const terms = (exported?.terms ?? []).map((entry) => ({ ...entry, _key: newKey() }))
    state.terms = terms
    state.baseline = JSON.stringify(stripKeys(terms))
  }
})

let nextKey = 0
function newKey() {
  nextKey += 1
  return `t${nextKey}`
}

const isDirty = computed(() => JSON.stringify(stripKeys(state.terms)) !== state.baseline)

function stripKeys(terms) {
  return terms.map(({ term, definition, isAcronym, aliases, path }) => ({
    term,
    definition,
    isAcronym,
    aliases,
    path
  }))
}

function createTerm() {
  dialog({
    component: GlossaryTermDialog,
    componentProps: {
      siteId: adminStore.currentSiteId
    }
  }).onOk((entry) => {
    state.terms.push({ ...entry, _key: newKey() })
  })
}

function editTerm(term) {
  dialog({
    component: GlossaryTermDialog,
    componentProps: {
      siteId: adminStore.currentSiteId,
      term
    }
  }).onOk((entry) => {
    const idx = state.terms.findIndex((t2) => t2._key === term._key)
    if (idx >= 0) {
      state.terms[idx] = { ...entry, _key: term._key }
    }
  })
}

function deleteTerm(term) {
  confirm({
    title: t('admin.glossary.deleteTerm'),
    message: t('admin.glossary.deleteTermConfirm', { term: term.term }),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(() => {
    state.terms = state.terms.filter((t2) => t2._key !== term._key)
  })
}

function discardChanges() {
  confirm({
    title: t('common.actions.discard'),
    message: t('admin.glossary.discardConfirm'),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.discard')
  }).onOk(load)
}

async function saveGlossary() {
  state.saving = true
  try {
    await API_CLIENT.post(`sites/${adminStore.currentSiteId}/glossary/save`, {
      json: { terms: stripKeys(state.terms) }
    }).json()
    notify({
      type: 'positive',
      message: t('admin.glossary.saveSuccess')
    })
    // -> The save response is DB rows (`pageId`, not `path`), so reload from `export` rather than
    //    let that second shape into the displayed list and the new baseline.
    await load()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.glossary.saveFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.saving = false
}

/**
 * A term change only reaches a page when that page is re-rendered, which otherwise waits on its
 * next save. Confirmed first because this queues EVERY page on the site, not just the ones that
 * mention a term, and can take a while on a large one.
 */
function rerenderAllPages() {
  confirm({
    title: t('admin.glossary.rerenderAllPagesTitle'),
    message: t('admin.glossary.rerenderAllPagesConfirm'),
    cancel: true,
    persistent: true,
    okLabel: t('admin.glossary.rerenderAllPages')
  }).onOk(async () => {
    try {
      const result = await API_CLIENT.post(
        `sites/${adminStore.currentSiteId}/glossary/rerender-all-pages`
      ).json()
      notify({
        type: 'positive',
        message: t('admin.glossary.rerenderAllPagesQueued', { count: result.queued })
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.glossary.rerenderAllPagesFailed'),
        caption: apiErrorMessage(err)
      })
    }
  })
}

function openVersionHistory() {
  dialog({
    component: GlossaryVersionHistoryDialog,
    componentProps: {
      siteId: adminStore.currentSiteId,
      currentTerms: stripKeys(state.terms)
    }
  }).onOk(load)
}

async function exportGlossary() {
  if (state.terms.length < 1) {
    return notify({
      type: 'negative',
      message: t('admin.glossary.exportEmptyError')
    })
  }
  try {
    const exported = await API_CLIENT.get(
      `sites/${adminStore.currentSiteId}/glossary/export`
    ).json()
    await fileSave(
      new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json;charset=UTF-8' }),
      { fileName: 'glossary.json', extensions: ['.json'] }
    )
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.glossary.exportFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

function openImportDialog() {
  dialog({
    component: GlossaryImportDialog,
    componentProps: {
      siteId: adminStore.currentSiteId
    }
  }).onOk(load)
}
</script>
