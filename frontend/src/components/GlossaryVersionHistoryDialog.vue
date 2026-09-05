<template>
  <w-dialog
    v-model="dialogVisible"
    :aria-label="t('admin.glossary.versionHistory')"
    @hide="onDialogHide">
    <w-card class="relative" style="min-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="la:history" size="sm" class="me-2" />
        <span>{{ t('admin.glossary.versionHistory') }}</span>
      </w-card-section>
      <w-separator />

      <w-card-section style="max-height: 60vh; overflow-y: auto">
        <div v-if="!state.isLoading && state.versions.length < 1" class="text-center py-6">
          <w-icon name="la:info-circle" size="sm" class="me-1" />
          <span class="text-caption">{{ t('admin.glossary.versionHistoryNone') }}</span>
        </div>
        <w-list v-else separator>
          <template v-for="version of state.versions" :key="version.id">
            <w-item clickable @click="toggleExpanded(version)">
              <w-item-section side>
                <w-icon name="la:box" size="sm" color="grey" />
              </w-item-section>
              <w-item-section>
                <w-item-label>{{
                  version.actorName || t('admin.glossary.versionUnknownActor')
                }}</w-item-label>
                <w-item-label caption>{{ relativeDate(version.createdAt) }}</w-item-label>
              </w-item-section>
              <w-item-section side>
                <span class="text-caption text-grey">
                  {{ t('admin.glossary.versionTermCount', { count: version.termCount }) }}
                </span>
              </w-item-section>
              <w-item-section side style="flex-direction: row; align-items: center">
                <w-btn
                  flat
                  dense
                  round
                  color="grey"
                  icon="la:download"
                  :loading="state.downloadingId === version.id"
                  :aria-label="t('common.actions.download')"
                  @click.stop="download(version)">
                  <w-tooltip>{{ t('common.actions.download') }}</w-tooltip>
                </w-btn>
                <w-btn
                  flat
                  dense
                  round
                  color="primary"
                  icon="la:history"
                  :loading="state.restoringId === version.id"
                  :aria-label="t('common.actions.restore')"
                  @click.stop="restore(version)">
                  <w-tooltip>{{ t('common.actions.restore') }}</w-tooltip>
                </w-btn>
              </w-item-section>
            </w-item>
            <w-item v-if="state.expandedId === version.id">
              <w-item-section>
                <w-inner-loading :showing="state.isLoadingDiff" size="24px" />
                <template v-if="state.diff">
                  <div
                    v-if="
                      !state.diff.added.length &&
                      !state.diff.removed.length &&
                      !state.diff.changed.length
                    "
                    class="text-caption text-grey">
                    {{ t('admin.glossary.versionNoDifference') }}
                  </div>
                  <template v-else>
                    <div v-if="state.diff.added.length" class="mb-2">
                      <div class="text-caption text-positive font-bold mb-1">
                        {{ t('admin.glossary.versionDiffAdded') }}
                      </div>
                      <div v-for="t2 of state.diff.added" :key="t2.term" class="text-caption">
                        + {{ t2.term }}
                      </div>
                    </div>
                    <div v-if="state.diff.removed.length" class="mb-2">
                      <div class="text-caption text-negative font-bold mb-1">
                        {{ t('admin.glossary.versionDiffRemoved') }}
                      </div>
                      <div v-for="t2 of state.diff.removed" :key="t2.term" class="text-caption">
                        - {{ t2.term }}
                      </div>
                    </div>
                    <div v-if="state.diff.changed.length">
                      <div class="text-caption text-warning font-bold mb-1">
                        {{ t('admin.glossary.versionDiffChanged') }}
                      </div>
                      <div
                        v-for="entry of state.diff.changed"
                        :key="entry.term"
                        class="text-caption">
                        ~ {{ entry.term }}
                      </div>
                    </div>
                  </template>
                </template>
              </w-item-section>
            </w-item>
          </template>
        </w-list>
      </w-card-section>

      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.close`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
      </w-card-actions>

      <w-inner-loading :showing="state.isLoading" size="38px" spinner-class="text-accent" />
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { onMounted, reactive } from 'vue'
import { fileSave } from 'browser-fs-access'

import { confirm, dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { relativeDate } from '@/helpers/datetime'

/**
 * Whole-glossary version history (OpenProject #1113): browse saved snapshots, expand one to see how
 * it differs from the admin screen's CURRENT working copy (`props.currentTerms`, passed by the parent
 * rather than re-fetched here, since it already has it loaded), and restore one as the new live state.
 * `currentTerms` is `AdminGlossary.vue`'s staged edits, not necessarily the live saved glossary -- if
 * there are unsaved changes, the diff shows what a restore would change relative to THOSE, which is
 * what the admin is looking at right now. A restore itself creates a new version rather than rewriting
 * history -- see `models/glossary.ts`'s own `restoreVersion` comment -- so the list only ever grows.
 */

// PROPS

const props = defineProps({
  siteId: {
    type: String,
    required: true
  },
  /** The admin screen's current working copy -- `{ term, definition, isAcronym, aliases, path }[]`,
   *  `aliases` each `{ value, isAcronym }` (OpenProject #2575) -- what an
   *  expanded version's snapshot is diffed against. May include unsaved staged edits; this is NOT
   *  guaranteed to match the live, already-saved glossary. */
  currentTerms: {
    type: Array,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  isLoading: false,
  versions: [],
  expandedId: null,
  isLoadingDiff: false,
  diff: null,
  restoringId: null,
  downloadingId: null
})

// METHODS

async function load() {
  state.isLoading = true
  try {
    state.versions = await API_CLIENT.get(`sites/${props.siteId}/glossary/versions`).json()
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}

/** A term's aliases (`{ value, isAcronym }[]`), reduced to a comparable, order-independent key --
 *  sorted by `value` so two lists differing only in insertion order still compare equal, but a
 *  different `isAcronym` flag on the same alias still counts as a change (OpenProject #2575). */
function aliasesKey(aliases) {
  return JSON.stringify(
    [...(aliases ?? [])]
      .map((a) => ({ value: a.value, isAcronym: !!a.isAcronym }))
      .sort((a, b) => a.value.localeCompare(b.value))
  )
}

function diffAgainstCurrent(versionTerms) {
  const currentByTerm = new Map(props.currentTerms.map((t2) => [t2.term.toLowerCase(), t2]))
  const versionByTerm = new Map(versionTerms.map((t2) => [t2.term.toLowerCase(), t2]))

  const added = []
  const changed = []
  for (const [key, vt] of versionByTerm) {
    const ct = currentByTerm.get(key)
    if (!ct) {
      added.push(vt)
      continue
    }
    const sameAliases = aliasesKey(ct.aliases) === aliasesKey(vt.aliases)
    if (
      ct.definition !== vt.definition ||
      !sameAliases ||
      ct.path !== vt.path ||
      !!ct.isAcronym !== !!vt.isAcronym
    ) {
      changed.push({ term: vt.term })
    }
  }
  const removed = []
  for (const [key, ct] of currentByTerm) {
    if (!versionByTerm.has(key)) {
      removed.push(ct)
    }
  }
  return { added, removed, changed }
}

async function toggleExpanded(version) {
  if (state.expandedId === version.id) {
    state.expandedId = null
    state.diff = null
    return
  }
  state.expandedId = version.id
  state.diff = null
  state.isLoadingDiff = true
  try {
    const full = await API_CLIENT.get(
      `sites/${props.siteId}/glossary/versions/${version.id}`
    ).json()
    state.diff = diffAgainstCurrent(full.snapshot.terms)
  } catch (err) {
    notify({
      type: 'negative',
      message: apiErrorMessage(err)
    })
    state.expandedId = null
  }
  state.isLoadingDiff = false
}

/**
 * Downloads this version's snapshot as a standalone JSON file -- `full.snapshot` already matches the
 * `GlossaryExport` shape (`{ formatVersion, terms }`), the same one `GET .../glossary/export` and
 * `POST .../glossary/import` both speak, so nothing needs reshaping before it goes into the Blob.
 * Mirrors `PageHistoryOverlay.vue`'s `downloadVersion()`: build a Blob, hand it to `fileSave()`, and
 * silently ignore a cancelled save picker (`AbortError`) rather than surfacing it as a failure.
 */
async function download(version) {
  state.downloadingId = version.id
  try {
    const full = await API_CLIENT.get(
      `sites/${props.siteId}/glossary/versions/${version.id}`
    ).json()
    const stamp = version.createdAt.slice(0, 19).replace(/[:T]/g, '-')
    await fileSave(
      new Blob([JSON.stringify(full.snapshot, null, 2)], { type: 'application/json' }),
      { fileName: `glossary-${version.id}-${stamp}.json`, extensions: ['.json'] }
    )
  } catch (err) {
    if (err.name !== 'AbortError') {
      notify({
        type: 'negative',
        message: t('admin.glossary.versionDownloadFailed'),
        caption: apiErrorMessage(err)
      })
    }
  }
  state.downloadingId = null
}

function restore(version) {
  confirm({
    title: t('admin.glossary.versionRestoreTitle'),
    message: t('admin.glossary.versionRestoreConfirm'),
    cancel: true,
    color: 'primary',
    okLabel: t('common.actions.restore')
  }).onOk(async () => {
    state.restoringId = version.id
    try {
      await API_CLIENT.post(`sites/${props.siteId}/glossary/versions/${version.id}/restore`).json()
      notify({
        type: 'positive',
        message: t('admin.glossary.versionRestoreSuccess')
      })
      onDialogOK()
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.glossary.versionRestoreFailed'),
        caption: apiErrorMessage(err)
      })
    }
    state.restoringId = null
  })
}

// MOUNTED

onMounted(load)
</script>
