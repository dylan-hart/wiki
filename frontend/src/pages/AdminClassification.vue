<template>
  <w-page class="admin-classification">
    <div class="admin-page-header flex flex-wrap items-center">
      <div class="admin-page-icon flex-none animated fadeInLeft">
        <w-icon name="tabler:stack-2" size="34px" class="admin-icon" />
        <i class="admin-page-icon__marks" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1 ps-4">
        <admin-page-eyebrow />
        <h1 class="admin-page-title animated fadeInLeft">
          {{ t('admin.classification.title') }}
        </h1>
        <div class="admin-page-subtitle animated fadeInLeft wait-p2s">
          {{ t('admin.classification.subtitle') }}
        </div>
      </div>
      <div class="flex-none">
        <w-btn
          class="acrylic-btn me-2"
          icon="tabler:refresh"
          flat
          color="slate"
          :loading="state.isLoading"
          :aria-label="t(`common.actions.refresh`)"
          @click="load">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
        <w-btn
          icon="tabler:plus"
          :label="t(`admin.classification.new`)"
          color="primary"
          :loading="state.isLoading"
          @click="createLevel" />
      </div>
    </div>
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
                    icon="tabler:arrow-up"
                    :disabled="idx === 0"
                    :aria-label="t(`admin.classification.moveUp`)"
                    @click="move(idx, -1)" />
                  <w-btn
                    dense
                    flat
                    round
                    size="sm"
                    icon="tabler:arrow-down"
                    :disabled="idx === state.levels.length - 1"
                    :aria-label="t(`admin.classification.moveDown`)"
                    @click="move(idx, 1)" />
                </div>
              </w-item-section>
              <w-item-section>
                <w-input
                  v-if="state.editingId === level.id"
                  :ref="(el) => (renameInput = el)"
                  v-model="state.editingName"
                  dense
                  :aria-label="t('common.field.name')"
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
                  class="acrylic-btn me-2"
                  color="indigo"
                  icon="tabler:pencil"
                  flat
                  :aria-label="t(`common.actions.rename`)"
                  @click="startRename(level)" />
                <w-btn
                  class="acrylic-btn"
                  color="red"
                  icon="tabler:trash"
                  flat
                  :disabled="state.levels.length <= 1"
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
          :class="dark.isActive ? `bg-dark-4 text-white` : `bg-blue-1 text-dark`">
          {{ t('admin.classification.hint') }}
        </w-banner>
        <!-- Every level listed even at zero: a level nothing is classified as is worth seeing. -->
        <w-card>
          <w-card-header>{{ t('admin.classification.coverageTitle') }}</w-card-header>
          <w-list separator>
            <w-item
              v-for="row of state.report"
              :key="row.levelId"
              clickable
              :disabled="row.count === 0"
              @click="openReport(row)">
              <w-item-section>
                <w-item-label>{{ row.name }}</w-item-label>
              </w-item-section>
              <w-item-section side>
                <w-chip dense :color="row.count > 0 ? `primary` : `grey-5`" text-color="white">
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
import { defineAsyncComponent, nextTick, onMounted, reactive } from 'vue'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm, dialog } from '@/composables/dialog'
import { apiErrorMessage } from '@/helpers/apiError'
import AdminPageEyebrow from '@/components/AdminPageEyebrow.vue'

const dark = useDark()

const { t } = useI18n()

useMeta(() => ({
  title: t('admin.classification.title')
}))

const state = reactive({
  levels: [],
  report: [],
  isLoading: false,
  editingId: null,
  editingName: ''
})

/**
 * At most one rename field is open at a time (`state.editingId` is a single id), so a plain variable
 * beats a ref-per-row map. Not a `ref()`: nothing reads it reactively, it is only `.focus()`-ed.
 */
let renameInput = null

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
  if (row.count === 0) {
    return
  }
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
  if (state.isLoading) {
    return
  }
  state.isLoading = true
  try {
    await API_CLIENT.post('classification-levels', {
      json: { name: t('admin.classification.newDefaultName') }
    }).json()
    await load()
  } catch (err) {
    state.isLoading = false
    notify({
      type: 'negative',
      message: t('admin.classification.createFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

/*
  Focusing scrolls nobody out from under themselves: the field swaps in where the rename button the
  reader just clicked already sits, so there is nowhere new to scroll to.
*/
function startRename(level) {
  state.editingId = level.id
  state.editingName = level.name
  nextTick(() => {
    renameInput?.focus()
  })
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
    message: t('admin.classification.deleteConfirm', { name: level.name }),
    persistent: true,
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
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

onMounted(() => {
  load()
})
</script>

<style></style>
