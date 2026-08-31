<template>
  <w-page class="admin-pages">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <img
          class="admin-icon animated fadeInLeft"
          src="/_assets/icons/fluent-document-in-folder.svg"
          alt="" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <h1 class="text-h5 text-primary animated fadeInLeft">{{ t('admin.pages.title') }}</h1>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.pages.subtitle') }}
        </div>
      </div>
      <div class="flex flex-none">
        <w-btn
          class="acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="load()">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <w-separator inset />
    <div class="p-4">
      <!-- FILTERS -->
      <div class="grid grid-cols-12 gap-2 mb-4">
        <w-input
          class="col-span-12 sm:col-span-4"
          outlined
          dense
          prefix="/"
          :placeholder="t('admin.pages.filterPathPlaceholder')"
          v-model="filters.path" />
        <w-select
          class="col-span-6 sm:col-span-2"
          outlined
          dense
          emit-value
          map-options
          v-model="filters.locale"
          :options="localeOptions"
          :aria-label="t('admin.pages.filterLocale')" />
        <w-select
          class="col-span-6 sm:col-span-2"
          outlined
          dense
          emit-value
          map-options
          v-model="filters.publishState"
          :options="publishStateOptions"
          :aria-label="t('admin.pages.filterPublishState')" />
        <w-select
          class="col-span-6 sm:col-span-2"
          outlined
          dense
          emit-value
          map-options
          v-model="filters.editor"
          :options="editorOptions"
          :aria-label="t('admin.pages.filterEditor')" />
        <w-input
          class="col-span-6 sm:col-span-2"
          outlined
          dense
          :placeholder="t('admin.pages.filterTagsPlaceholder')"
          v-model="filters.tags" />
      </div>

      <!-- SELECTION / BULK ACTION TOOLBAR -->
      <div class="flex flex-wrap items-center gap-3 mb-2 min-h-[36px]">
        <w-checkbox
          :model-value="allOnPageSelected"
          :indeterminate="someOnPageSelected && !allOnPageSelected"
          :disable="state.rows.length < 1"
          :label="t('admin.pages.selectAllOnPage')"
          @update:model-value="toggleSelectAllOnPage" />
        <template v-if="state.selectedIds.length > 0">
          <span class="text-caption text-grey">{{
            t('admin.pages.selectedCount', { count: state.selectedIds.length })
          }}</span>
          <w-btn
            flat
            dense
            no-caps
            :label="t('admin.pages.clearSelection')"
            @click="clearSelection" />
          <w-space />
          <w-btn
            unelevated
            no-caps
            color="negative"
            icon="la:trash"
            :disable="state.bulkLoading"
            :label="t('admin.pages.bulkDelete')"
            @click="confirmBulkDelete" />
          <w-btn
            unelevated
            no-caps
            color="secondary"
            icon="la:redo-alt"
            :disable="state.bulkLoading"
            :label="t('admin.pages.bulkRender')"
            @click="confirmBulkRender" />
          <w-btn
            unelevated
            no-caps
            color="primary"
            icon="la:hashtag"
            :disable="state.bulkLoading"
            :label="t('admin.pages.bulkRetag')"
            @click="state.retagOpen = !state.retagOpen" />
        </template>
      </div>

      <!-- RETAG PANEL -->
      <w-card v-if="state.retagOpen" flat bordered class="mb-4 p-3">
        <div class="grid grid-cols-12 gap-2 items-end">
          <w-input
            class="col-span-12 sm:col-span-5"
            outlined
            dense
            :label="t('admin.pages.retagAddLabel')"
            v-model="state.retagAdd" />
          <w-input
            class="col-span-12 sm:col-span-5"
            outlined
            dense
            :label="t('admin.pages.retagRemoveLabel')"
            v-model="state.retagRemove" />
          <div class="col-span-12 sm:col-span-2 flex gap-2 justify-end">
            <w-btn
              flat
              no-caps
              :disable="state.bulkLoading"
              :label="t('common.actions.cancel')"
              @click="state.retagOpen = false" />
            <w-btn
              unelevated
              no-caps
              color="primary"
              :loading="state.bulkLoading"
              :label="t('admin.pages.retagApply')"
              @click="submitBulkRetag" />
          </div>
        </div>
      </w-card>

      <w-card>
        <w-table
          :rows="state.rows"
          :columns="headers"
          row-key="id"
          flat
          :loading="state.loading > 0">
          <template #no-data>
            <w-banner
              rounded
              :class="dark.isActive ? `bg-dark-3 text-grey-4` : `bg-grey-2 text-grey-8`">
              {{ t('admin.pages.none') }}
            </w-banner>
          </template>
          <template #body-cell-select="props">
            <w-td :props="props">
              <w-checkbox
                v-model="state.selectedIds"
                :val="props.row.id"
                :aria-label="t('admin.pages.selectRowAria', { title: props.row.title })" />
            </w-td>
          </template>
          <template #body-cell-title="props">
            <w-td :props="props">
              <strong>{{ props.value || props.row.path }}</strong>
              <div class="text-caption text-grey font-robotomono">/{{ props.row.path }}</div>
            </w-td>
          </template>
          <template #body-cell-locale="props">
            <w-td :props="props">
              <w-badge outline color="grey-6" :label="props.value" />
            </w-td>
          </template>
          <template #body-cell-tags="props">
            <w-td :props="props">
              <div class="flex flex-wrap gap-1">
                <w-chip
                  v-for="tag of props.value"
                  :key="`tag-${tag}`"
                  square
                  color="secondary"
                  text-color="white"
                  icon="la:hashtag"
                  size="sm">
                  {{ tag }}
                </w-chip>
              </div>
            </w-td>
          </template>
          <template #body-cell-updatedAt="props">
            <w-td :props="props">
              <div>{{ formattedDate(props.value) }}</div>
              <div class="text-caption text-grey">{{ relativeDate(props.value) }}</div>
            </w-td>
          </template>
        </w-table>
      </w-card>

      <div class="flex items-center justify-center mt-6" v-if="state.totalPages > 1">
        <w-pagination v-model="state.currentPage" :max="state.totalPages" direction-links />
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { computed, onMounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { debounce } from 'es-toolkit/function'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm } from '@/composables/dialog'

import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'

import { relativeDate } from '@/helpers/datetime'
import { apiErrorMessage } from '@/helpers/apiError'

/**
 * The admin page inventory (OpenProject #1880/#1882): every page on the current site, server-side
 * paged and filtered, with row selection and bulk delete/re-render/retag.
 *
 * Selection is scoped to the CURRENT PAGE of results only ("select-all-on-page", not a
 * select-everything-matching-the-filter across every page of the pager) — `state.selectedIds`
 * is cleared on every reload (a filter change, a page change, or after a bulk action lands), so it
 * never silently carries a stale id from a row that has since scrolled out of view.
 *
 * The bulk endpoint (`POST .../pages/bulk`) reports a status per page rather than failing outright
 * on the first one the caller may not act on — `applyBulkResult` below is what turns that into a
 * notification summarizing how many landed versus were skipped/not found/errored.
 */

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.pages.title')
}))

// DATA

const PAGE_SIZE = 25

const state = reactive({
  loading: 0,
  bulkLoading: false,
  rows: [],
  currentPage: 1,
  totalPages: 1,
  activeLocales: [],
  selectedIds: [],
  retagOpen: false,
  retagAdd: '',
  retagRemove: ''
})

const filters = reactive({
  path: '',
  locale: '',
  publishState: '',
  editor: '',
  tags: ''
})

const headers = computed(() => [
  {
    label: '',
    align: 'center',
    field: 'id',
    name: 'select',
    sortable: false,
    style: 'width: 40px'
  },
  {
    label: t('admin.pages.colTitle'),
    align: 'left',
    field: 'title',
    name: 'title',
    sortable: false
  },
  {
    label: t('admin.pages.colLocale'),
    align: 'left',
    field: 'locale',
    name: 'locale',
    sortable: false,
    style: 'width: 90px'
  },
  {
    label: t('admin.pages.colTags'),
    align: 'left',
    field: 'tags',
    name: 'tags',
    sortable: false
  },
  {
    label: t('admin.pages.colUpdatedAt'),
    align: 'left',
    field: 'updatedAt',
    name: 'updatedAt',
    sortable: false,
    style: 'width: 200px'
  }
])

const localeOptions = computed(() => [
  { label: t('admin.pages.filterLocaleAll'), value: '' },
  ...state.activeLocales.map((code) => {
    const known = adminStore.locales.find((lc) => lc.code === code)
    return { label: known ? `${known.nativeName} (${code})` : code, value: code }
  })
])

const publishStateOptions = computed(() => [
  { label: t('admin.pages.filterPublishStateAll'), value: '' },
  { label: t('admin.pages.filterPublishStateDraft'), value: 'draft' },
  { label: t('admin.pages.filterPublishStatePublished'), value: 'published' },
  { label: t('admin.pages.filterPublishStateScheduled'), value: 'scheduled' }
])

const editorOptions = computed(() => [
  { label: t('admin.pages.filterEditorAll'), value: '' },
  { label: 'AsciiDoc', value: 'asciidoc' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'Visual Editor', value: 'wysiwyg' }
])

const allOnPageSelected = computed(
  () => state.rows.length > 0 && state.rows.every((row) => state.selectedIds.includes(row.id))
)
const someOnPageSelected = computed(() => state.selectedIds.length > 0)

// WATCHERS

watch(() => adminStore.currentSiteId, resetAndLoad)

const debouncedReload = debounce(() => resetAndLoad(), 400)
watch(() => filters.path, debouncedReload)
watch(() => filters.tags, debouncedReload)
watch([() => filters.locale, () => filters.publishState, () => filters.editor], resetAndLoad)

watch(
  () => state.currentPage,
  () => load()
)

// METHODS

function formattedDate(val) {
  return userStore.formatDateTime(t, val)
}

function resetAndLoad() {
  state.currentPage = 1
  load()
}

function clearSelection() {
  state.selectedIds = []
}

function toggleSelectAllOnPage() {
  if (allOnPageSelected.value) {
    state.selectedIds = state.selectedIds.filter((id) => !state.rows.some((row) => row.id === id))
  } else {
    state.selectedIds = [...new Set([...state.selectedIds, ...state.rows.map((row) => row.id)])]
  }
}

function splitTags(raw) {
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

async function load() {
  if (!adminStore.currentSiteId) {
    return
  }
  state.loading++
  try {
    const filterTags = splitTags(filters.tags)
    const resp = await API_CLIENT.get(`sites/${adminStore.currentSiteId}/pages/search`, {
      searchParams: {
        ...(filters.path ? { path: filters.path } : {}),
        ...(filters.locale ? { locales: filters.locale } : {}),
        ...(filters.publishState ? { publishState: filters.publishState } : {}),
        ...(filters.editor ? { editor: filters.editor } : {}),
        ...(filterTags.length > 0 ? { tags: filterTags.join(',') } : {}),
        orderBy: 'updatedAt',
        orderByDirection: 'desc',
        offset: (state.currentPage - 1) * PAGE_SIZE,
        limit: PAGE_SIZE
      }
    }).json()
    state.rows = resp?.results ?? []
    state.totalPages = Math.max(1, Math.ceil((resp?.totalHits ?? 0) / PAGE_SIZE))
    // -> Selection is scoped to the page of results just replaced -- see the header doc comment.
    state.selectedIds = []
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.pages.loadFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.loading--
}

async function loadSiteLocales() {
  if (!adminStore.currentSiteId) {
    return
  }
  try {
    const site = await API_CLIENT.get(`sites/${adminStore.currentSiteId}?strict=true`).json()
    state.activeLocales = site?.locales?.active ?? []
  } catch {
    state.activeLocales = []
  }
}

/** Turns a `POST .../pages/bulk` response into a summary notification. */
function applyBulkResult(resp) {
  const counts = resp?.counts ?? {}
  const done = counts.done ?? 0
  const total = resp?.results?.length ?? 0
  const problems = [
    counts.skipped ? t('admin.pages.bulkResultSkipped', { count: counts.skipped }) : null,
    counts.notFound ? t('admin.pages.bulkResultNotFound', { count: counts.notFound }) : null,
    counts.error ? t('admin.pages.bulkResultError', { count: counts.error }) : null
  ].filter(Boolean)
  notify({
    type: problems.length > 0 ? 'warning' : 'positive',
    message: t('admin.pages.bulkResultSummary', { done, total }),
    caption: problems.join(' ')
  })
}

async function runBulkAction(action, extra = {}) {
  state.bulkLoading = true
  try {
    const resp = await API_CLIENT.post(`sites/${adminStore.currentSiteId}/pages/bulk`, {
      json: { pageIds: [...state.selectedIds], action, ...extra }
    }).json()
    applyBulkResult(resp)
    state.retagOpen = false
    state.retagAdd = ''
    state.retagRemove = ''
    await load()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('admin.pages.bulkActionFailed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.bulkLoading = false
  }
}

function confirmBulkDelete() {
  const count = state.selectedIds.length
  confirm({
    title: t('admin.pages.bulkDeleteConfirmTitle'),
    message: t('admin.pages.bulkDeleteConfirmText', { count }),
    cancel: true,
    color: 'negative',
    okLabel: t('admin.pages.bulkDelete')
  }).onOk(() => runBulkAction('delete'))
}

function confirmBulkRender() {
  const count = state.selectedIds.length
  confirm({
    title: t('admin.pages.bulkRenderConfirmTitle'),
    message: t('admin.pages.bulkRenderConfirmText', { count }),
    cancel: true,
    okLabel: t('admin.pages.bulkRender')
  }).onOk(() => runBulkAction('render'))
}

function submitBulkRetag() {
  const addTags = splitTags(state.retagAdd)
  const removeTags = splitTags(state.retagRemove)
  if (addTags.length < 1 && removeTags.length < 1) {
    notify({ type: 'negative', message: t('admin.pages.retagNoneProvided') })
    return
  }
  runBulkAction('retag', { addTags, removeTags })
}

// MOUNTED

onMounted(async () => {
  await loadSiteLocales()
  await load()
})
</script>
