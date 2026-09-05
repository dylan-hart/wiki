<!--
  OpenProject #1080: raising a page's own classification does not silently cascade to its
  descendants. `PageHeader.vue`'s `saveChangesCommit` opens this whenever a save's response carries
  `classificationConflicts` -- the descendants left below the page's new floor -- so an admin resolves
  them explicitly rather than the gap going unnoticed. Each row is bumped individually (its own
  write:pages check) or all at once, both against `POST …/pages/classification-conflicts/resolve`.
-->
<template>
  <w-dialog
    v-model="dialogVisible"
    persistent
    :aria-label="t('editor.classification.conflictsTitle')"
    @hide="onDialogHide">
    <w-card style="min-width: 500px; max-width: 650px">
      <w-card-section class="card-header">
        <w-icon name="tabler:alert-triangle" size="sm" class="me-2" />
        <span>{{ t('editor.classification.conflictsTitle') }}</span>
      </w-card-section>
      <w-card-section class="pb-0">
        <div class="text-body2">
          {{ t('editor.classification.conflictsHint') }}
        </div>
      </w-card-section>
      <w-card-section>
        <w-list class="rounded bg-white dark:bg-black/20" separator bordered>
          <w-item v-for="item of state.items" :key="item.id">
            <w-item-section>
              <w-item-label
                ><strong>{{ item.title }}</strong></w-item-label
              >
              <w-item-label caption>/{{ item.path }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <w-btn
                v-if="!item.resolved"
                dense
                color="primary"
                :label="t('editor.classification.bumpOne')"
                :loading="item.isLoading"
                @click="bumpOne(item)" />
              <w-chip v-else dense color="positive" text-color="white">
                {{ t('editor.classification.bumped') }}
              </w-chip>
            </w-item-section>
          </w-item>
        </w-list>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-btn
          class="acrylic-btn"
          flat
          :label="t('editor.classification.bumpAll')"
          color="primary"
          padding="xs md"
          :disabled="state.items.every((i) => i.resolved)"
          :loading="state.isBumpingAll"
          @click="bumpAll" />
        <w-space />
        <w-btn
          :label="t('common.actions.close')"
          color="primary"
          padding="xs md"
          @click="onDialogOK" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { reactive } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { useSiteStore } from '@/stores/site'

// PROPS

const props = defineProps({
  conflicts: {
    type: Array,
    required: true
  },
  /** The level the raising save just set the parent page to -- what "bump" targets by default. */
  floorClassification: {
    type: String,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK } = useDialogComponent()

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  items: props.conflicts.map((c) => ({ ...c, isLoading: false, resolved: false })),
  isBumpingAll: false
})

// METHODS

async function resolvePages(ids) {
  await API_CLIENT.post(`sites/${siteStore.id}/pages/classification-conflicts/resolve`, {
    json: { pageIds: ids, classification: props.floorClassification }
  }).json()
}

async function bumpOne(item) {
  item.isLoading = true
  try {
    await resolvePages([item.id])
    item.resolved = true
  } catch (err) {
    notify({
      type: 'negative',
      message: t('editor.classification.bumpFailed'),
      caption: apiErrorMessage(err)
    })
  }
  item.isLoading = false
}

async function bumpAll() {
  const pending = state.items.filter((i) => !i.resolved)
  if (pending.length < 1) {
    return
  }
  state.isBumpingAll = true
  try {
    await resolvePages(pending.map((i) => i.id))
    for (const item of pending) {
      item.resolved = true
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t('editor.classification.bumpFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.isBumpingAll = false
}
</script>
