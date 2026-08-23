<template>
  <w-page class="admin-classification">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <w-icon
          class="admin-icon animated fadeInLeft"
          name="la:layer-group"
          size="48px"
          color="primary" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 text-primary animated fadeInLeft">
          {{ t('admin.classification.title') }}
        </div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.classification.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:question-circle"
          flat
          color="grey"
          :aria-label="t(`common.actions.viewDocs`)"
          :href="siteStore.docsBase + `/admin/classification`"
          target="_blank">
          <w-tooltip>{{ t(`common.actions.viewDocs`) }}</w-tooltip>
        </w-btn>
        <w-btn
          class="acrylic-btn mr-2"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.isLoading"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          unelevated
          icon="la:plus"
          :label="t(`admin.classification.new`)"
          color="primary"
          @click="createLevel" />
      </div>
    </div>
    <w-separator inset />
    <div class="grid grid-cols-12 p-4 gap-4">
      <div class="col-span-12 lg:col-span-8">
        <w-card>
          <w-list separator>
            <w-item v-for="(level, idx) of state.levels" :key="level.id">
              <w-item-section side>
                <div class="flex flex-col">
                  <w-btn
                    dense
                    flat
                    round
                    size="sm"
                    icon="la:arrow-up"
                    :disable="idx === 0"
                    :aria-label="t(`admin.classification.moveUp`)"
                    @click="move(idx, -1)" />
                  <w-btn
                    dense
                    flat
                    round
                    size="sm"
                    icon="la:arrow-down"
                    :disable="idx === state.levels.length - 1"
                    :aria-label="t(`admin.classification.moveDown`)"
                    @click="move(idx, 1)" />
                </div>
              </w-item-section>
              <w-item-section>
                <w-input
                  v-if="state.editingId === level.id"
                  v-model="state.editingName"
                  dense
                  outlined
                  autofocus
                  @keyup.enter="commitRename(level)"
                  @blur="commitRename(level)" />
                <template v-else>
                  <w-item-label
                    ><strong>{{ level.name }}</strong></w-item-label
                  >
                  <w-item-label caption>{{
                    idx === 0
                      ? t('admin.classification.mostOpen')
                      : t('admin.classification.sortOrderCaption', { n: idx })
                  }}</w-item-label>
                </template>
              </w-item-section>
              <w-item-section side style="flex-direction: row; align-items: center">
                <w-btn
                  class="acrylic-btn mr-2"
                  color="indigo"
                  icon="la:pen"
                  flat
                  :aria-label="t(`common.actions.rename`)"
                  @click="startRename(level)" />
                <w-btn
                  class="acrylic-btn"
                  color="red"
                  icon="la:trash"
                  flat
                  :disable="state.levels.length <= 1"
                  :aria-label="t(`common.actions.delete`)"
                  @click="deleteLevel(level)" />
              </w-item-section>
            </w-item>
          </w-list>
        </w-card>
      </div>
      <div class="col-span-12 lg:col-span-4">
        <w-banner
          class="mb-4"
          rounded
          :class="dark.isActive ? `bg-dark-4 text-white` : `bg-blue-1 text-dark`">
          {{ t('admin.classification.hint') }}
        </w-banner>
        <!--
          OpenProject #1081: "everything currently classified as X" -- the auditability half of the
          epic, alongside the classificationChanged events now feeding the audit log
          (`AdminAuditLog.vue`). Every level shown even at zero, matching the report endpoint's own
          reasoning: a level nothing is classified as is itself worth seeing.
        -->
        <w-card>
          <w-card-header>{{ t('admin.classification.coverageTitle') }}</w-card-header>
          <w-list separator>
            <w-item
              v-for="row of state.report"
              :key="row.levelId"
              clickable
              :disable="row.count === 0"
              @click="openReport(row)">
              <w-item-section>
                <w-item-label>{{ row.name }}</w-item-label>
              </w-item-section>
              <w-item-section side>
                <w-chip
                  dense
                  square
                  :color="row.count > 0 ? `primary` : `grey-5`"
                  text-color="white">
                  {{ row.count }}
                </w-chip>
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
import { defineAsyncComponent, onMounted, reactive } from 'vue'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm, dialog } from '@/composables/dialog'
import { apiErrorMessage } from '@/helpers/apiError'

import { useSiteStore } from '@/stores/site'

// COMPOSABLES

const dark = useDark()

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.classification.title')
}))

// DATA

const state = reactive({
  levels: [],
  report: [],
  isLoading: false,
  editingId: null,
  editingName: ''
})

// METHODS

async function load() {
  state.isLoading = true
  try {
    const [levels, report] = await Promise.all([
      API_CLIENT.get('classification-levels').json(),
      API_CLIENT.get('pages/classification-report').json()
    ])
    state.levels = levels ?? []
    state.report = report ?? []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.classification.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.isLoading = false
}

function openReport(row) {
  dialog({
    component: defineAsyncComponent(
      () => import('../components/ClassificationReportDrillDialog.vue')
    ),
    componentProps: {
      levelId: row.levelId,
      levelName: row.name
    }
  })
}

async function createLevel() {
  try {
    await API_CLIENT.post('classification-levels', {
      json: { name: t('admin.classification.newDefaultName'), sortOrder: state.levels.length }
    }).json()
    await load()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.classification.createFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

function startRename(level) {
  state.editingId = level.id
  state.editingName = level.name
}

async function commitRename(level) {
  if (state.editingId !== level.id) {
    return
  }
  const name = state.editingName.trim()
  state.editingId = null
  if (!name || name === level.name) {
    return
  }
  try {
    await API_CLIENT.patch(`classification-levels/${level.id}`, { json: { name } }).json()
    level.name = name
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.classification.renameFailed'),
      caption: apiErrorMessage(err)
    })
    await load()
  }
}

/** Swaps `idx` with its neighbor `dir` (-1 up / +1 down) and persists the whole new order. */
async function move(idx, dir) {
  const target = idx + dir
  if (target < 0 || target >= state.levels.length) {
    return
  }
  const reordered = [...state.levels]
  ;[reordered[idx], reordered[target]] = [reordered[target], reordered[idx]]
  state.levels = reordered
  try {
    await API_CLIENT.post('classification-levels/reorder', {
      json: { ids: reordered.map((l) => l.id) }
    }).json()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.classification.reorderFailed'),
      caption: apiErrorMessage(err)
    })
    await load()
  }
}

function deleteLevel(level) {
  confirm({
    title: t('admin.classification.deleteTitle'),
    message: t('admin.classification.deleteConfirm', { name: level.name })
  }).onOk(async () => {
    try {
      await API_CLIENT.delete(`classification-levels/${level.id}`).json()
      await load()
    } catch (err) {
      notify({
        type: 'negative',
        message: t('admin.classification.deleteFailed'),
        caption: apiErrorMessage(err)
      })
    }
  })
}

// MOUNTED

onMounted(() => {
  load()
})
</script>

<style lang="scss"></style>
