<!--
  OpenProject #1081: the drill-down `AdminClassification.vue`'s coverage report opens when an admin
  clicks a level's count -- "everything currently classified as X", instance-wide (`GET
  /pages/classification-report/:levelId`), paginated newest-updated first.
-->
<template>
  <w-dialog
    v-model="dialogVisible"
    :aria-label="t('admin.classification.reportTitle', { level: props.levelName })"
    @hide="onDialogHide">
    <w-card style="min-width: 550px; max-width: 700px">
      <w-card-section class="card-header">
        <w-icon name="la:list" size="sm" class="me-2" />
        <span>{{ t('admin.classification.reportTitle', { level: props.levelName }) }}</span>
      </w-card-section>
      <w-card-section>
        <w-banner
          v-if="!state.isLoading && state.entries.length < 1"
          :class="dark.isActive ? `bg-dark-4 text-white` : `bg-grey-4 text-grey-9`">
          {{ t('admin.classification.reportEmpty') }}
        </w-banner>
        <w-list v-else class="rounded bg-white dark:bg-black/20" separator bordered>
          <w-item v-for="entry of state.entries" :key="entry.id">
            <w-item-section>
              <w-item-label>{{ entry.title }}</w-item-label>
              <w-item-label caption>/{{ entry.path }} ({{ entry.locale }})</w-item-label>
            </w-item-section>
          </w-item>
        </w-list>
      </w-card-section>
      <w-card-section class="flex items-center justify-center" v-if="totalPages > 1">
        <w-pagination
          v-model="state.page"
          :max="totalPages"
          :max-pages="7"
          @update:model-value="load" />
      </w-card-section>
      <w-card-actions class="card-actions">
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
import { computed, onMounted, reactive } from 'vue'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { useDark } from '@/composables/dark'

// PROPS

const props = defineProps({
  levelId: {
    type: String,
    required: true
  },
  levelName: {
    type: String,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK } = useDialogComponent()

// COMPOSABLES

const dark = useDark()

// I18N

const { t } = useI18n()

// DATA

const PAGE_SIZE = 20

const state = reactive({
  entries: [],
  total: 0,
  page: 1,
  isLoading: false
})

// COMPUTED

const totalPages = computed(() => Math.max(1, Math.ceil(state.total / PAGE_SIZE)))

// METHODS

async function load() {
  state.isLoading = true
  try {
    const resp = await API_CLIENT.get(`pages/classification-report/${props.levelId}`, {
      searchParams: { limit: PAGE_SIZE, offset: (state.page - 1) * PAGE_SIZE }
    }).json()
    state.entries = resp?.entries ?? []
    state.total = resp?.total ?? 0
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.classification.reportLoadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}

// MOUNTED

onMounted(() => {
  load()
})
</script>
