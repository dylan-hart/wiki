<template>
  <w-page>
    <div class="flex flex-wrap items-center p-4">
      <div class="flex-none">
        <w-icon
          name="img:/_assets/icons/fluent-find-and-replace-animated.svg"
          size="64px"
          class="admin-icon animated fadeInLeft" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <h1 class="admin-page-title animated fadeInLeft">{{ t('admin.glossary.title') }}</h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.glossary.subtitle') }}
        </div>
      </div>
      <div class="flex flex-none flex-wrap items-center">
        <w-btn
          class="acrylic-btn me-2"
          icon="la:history"
          flat
          color="indigo"
          @click="openVersionHistory">
          <w-tooltip labels>{{ t('admin.glossary.versionHistory') }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn me-2"
          icon="la:file-export"
          flat
          color="indigo"
          @click="exportGlossary">
          <w-tooltip labels>{{ t('common.actions.export') }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn me-2"
          icon="la:file-import"
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
          icon="la:plus"
          :label="t(`admin.glossary.newTerm`)"
          color="primary"
          @click="createTerm" />
      </div>
    </div>
    <w-separator inset />
    <div class="p-4">
      <w-banner
        v-if="state.terms.length < 1 && state.loading < 1"
        :class="dark.isActive ? `bg-dark-3 text-grey-4` : `bg-grey-2 text-grey-8`">
        {{ t('admin.glossary.noTerms') }}
      </w-banner>
      <w-card v-else>
        <w-list separator>
          <w-item v-for="term of state.terms" :key="term._key">
            <blueprint-icon icon="quote-left" />
            <w-item-section>
              <w-item-label>
                <strong>{{ term.term }}</strong>
                <w-chip
                  v-if="term.isAcronym"
                  dense
                  size="sm"
                  class="ms-2"
                  icon="mdi:alpha-a-box-outline">
                  {{ t('admin.glossary.isAcronym') }}
                </w-chip>
              </w-item-label>
              <div v-if="term.aliases?.length" class="flex flex-wrap gap-1 mt-1">
                <w-chip
                  v-for="alias of term.aliases"
                  :key="alias.value"
                  dense
                  :icon="alias.isAcronym ? 'mdi:alpha-a-box-outline' : null">
                  {{ alias.value }}
                </w-chip>
              </div>
              <w-item-label v-if="term.path" caption>
                <w-icon name="la:link" size="12px" class="me-1" />
                /{{ term.path }}
              </w-item-label>
            </w-item-section>
            <w-item-section>
              <span class="text-caption text-grey">{{ term.definition }}</span>
            </w-item-section>
            <w-separator class="ms-4" vertical />
            <w-item-section side style="flex-direction: row; align-items: center">
              <w-btn
                class="acrylic-btn me-2"
                flat
                @click="editTerm(term)"
                icon="la:pen"
                :color="dark.isActive ? `indigo-4` : `indigo`"
                :label="t(`common.actions.edit`)" />
              <w-btn
                class="acrylic-btn"
                flat
                icon="la:trash"
                color="negative"
                @click="deleteTerm(term)"
                :aria-label="t(`common.actions.delete`)" />
            </w-item-section>
          </w-item>
        </w-list>
      </w-card>
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

import GlossaryImportDialog from '@/components/GlossaryImportDialog.vue'
import GlossaryTermDialog from '@/components/GlossaryTermDialog.vue'
import GlossaryVersionHistoryDialog from '@/components/GlossaryVersionHistoryDialog.vue'
import { apiErrorMessage } from '@/helpers/apiError'

/*
  No `useSiteAdminAccess()` here: that composable exists for the nine surfaces
  `composables/siteAdminAccess.js`'s `GLOBAL_FALLBACKS` names, none of which is this one. Glossary is
  gated the same way `AdminComments.vue` / `AdminAnalytics.vue` are -- the sidebar entry checks
  `manage:glossary` (see `AdminLayout.vue`), and every `api/glossary.ts` admin route enforces the same
  permission server-side (OpenProject #1116 -- a dedicated permission rather than piggybacking on
  `manage:sites`, which also grants site creation/deletion/config editing); there is no client-side
  redirect to add on top for a page that carries no additional site-admin delegation of its own.

  EDITING IS A STAGED WORKFLOW (OpenProject #1113): `state.terms` is a local working copy -- add/
  edit/remove buttons only ever touch it, never the API -- and nothing reaches the server until
  "Save Glossary" is clicked, which atomically replaces the whole live glossary and records a version
  snapshot. Each entry is `{ term, definition, isAcronym, aliases, path }` (`aliases` each
  `{ value, isAcronym }` -- OpenProject #2575) (a client-only `_key` added for
  `v-for`/editing, stripped back off before anything is sent) -- the exact JSON shape
  `GET .../glossary/export` already returns and `POST .../glossary/{save,import}` both accept
  (OpenProject #1114), so loading, saving, exporting and importing all speak the same shape.
*/

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.glossary.title')
}))

// DATA

const { state, load } = useAdminSettings({
  i18nPrefix: 'admin.glossary',
  // -> A staged-edit list, not a settings form: reading the terms has never raised the full-screen
  //    overlay, and "Save Glossary" drives its own `state.saving` button instead.
  overlay: false,
  extraState: {
    saving: false,
    terms: [],
    /** The last-loaded-or-saved state, for the dirty check below -- `stripKeys(state.terms)`. */
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

// COMPUTED

const isDirty = computed(() => JSON.stringify(stripKeys(state.terms)) !== state.baseline)

// METHODS

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
    // -> The save response is DB rows (`pageId`, not `path`) -- reloading from `export` right after
    //    is what gets the displayed list (and the new baseline) each entry's resolved `path` back,
    //    rather than the response's shape leaking into what this screen otherwise only ever works
    //    with.
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
