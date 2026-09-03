<template>
  <w-page class="admin-pages">
    <div class="flex flex-wrap p-4 items-center">
      <div class="flex-none">
        <img
          class="admin-icon animated fadeInLeft"
          src="/_assets/icons/fluent-document-in-folder.svg" />
      </div>
      <div class="min-w-0 flex-1 pl-4">
        <div class="text-h5 text-primary animated fadeInLeft">{{ t('admin.pages.title') }}</div>
        <div class="text-subtitle1 text-grey animated fadeInLeft wait-p2s">
          {{ t('admin.pages.subtitle') }}
        </div>
      </div>
      <div class="flex-none flex">
        <w-btn
          class="mr-2 acrylic-btn"
          icon="la:redo-alt"
          flat
          color="secondary"
          :loading="state.loading > 0"
          :aria-label="t(`common.actions.refresh`)"
          @click="() => load()">
          <w-tooltip>{{ t(`common.actions.refresh`) }}</w-tooltip>
        </w-btn>
      </div>
    </div>
    <w-separator inset />
    <div class="p-4">
      <w-card class="rounded mb-4" flat :class="dark.isActive ? `bg-dark-5` : `bg-grey-2`">
        <w-card-section class="flex flex-wrap gap-3 items-end">
          <div style="min-width: 220px">
            <div class="text-caption text-grey mb-1">{{ t('search.filterPath') }}</div>
            <w-input outlined dense v-model="state.filters.path" />
          </div>
          <div style="min-width: 220px">
            <div class="text-caption text-grey mb-1">{{ t('search.filterLocale') }}</div>
            <w-select
              outlined
              dense
              options-dense
              emit-value
              map-options
              multiple
              v-model="state.filters.locales"
              :options="localeOptions" />
          </div>
          <div style="min-width: 180px">
            <div class="text-caption text-grey mb-1">{{ t('search.filterTags') }}</div>
            <w-input outlined dense v-model="state.filters.tags" />
          </div>
          <div style="min-width: 180px">
            <div class="text-caption text-grey mb-1">{{ t('search.filterEditor') }}</div>
            <w-select
              outlined
              dense
              options-dense
              emit-value
              map-options
              v-model="state.filters.editor"
              :options="editorOptions" />
          </div>
          <div style="min-width: 180px">
            <div class="text-caption text-grey mb-1">{{ t('search.filterPublishState') }}</div>
            <w-select
              outlined
              dense
              options-dense
              emit-value
              map-options
              v-model="state.filters.publishState"
              :options="publishStateOptions" />
          </div>
          <w-btn
            class="acrylic-btn"
            flat
            color="primary"
            :label="t('common.actions.apply')"
            :loading="state.loading > 0"
            @click="applyFilters" />
          <w-btn
            class="acrylic-btn"
            flat
            color="grey"
            :label="t('admin.pages.resetFilters')"
            @click="resetFilters" />
        </w-card-section>
      </w-card>

      <!-- SELECTION / BULK ACTION TOOLBAR -->
      <div v-if="state.rows.length > 0" class="flex flex-wrap items-center gap-3 mb-2 min-h-[36px]">
        <w-checkbox
          :model-value="allOnPageSelected"
          :indeterminate="someOnPageSelected && !allOnPageSelected"
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

      <w-card v-if="state.rows.length < 1" flat :class="dark.isActive ? `bg-dark-5` : `bg-grey-3`">
        <w-card-section class="items-center" horizontal>
          <w-card-section class="flex-none pr-0">
            <w-icon name="la:info-circle" size="sm" />
          </w-card-section>
          <w-card-section class="text-caption">{{ t('admin.pages.none') }}</w-card-section>
        </w-card-section>
      </w-card>
      <w-card v-else flat>
        <w-table
          :rows="state.rows"
          :columns="headers"
          row-key="id"
          flat
          :loading="state.loading > 0">
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
              <strong>{{ props.row.title }}</strong>
              <div class="text-caption text-grey font-robotomono">/{{ props.row.path }}</div>
            </w-td>
          </template>
          <template #body-cell-locale="props">
            <w-td :props="props">
              <w-badge outline color="grey-6" :label="props.value" />
            </w-td>
          </template>
          <template #body-cell-translations="props">
            <w-td :props="props">
              <div class="flex flex-wrap gap-1">
                <w-badge
                  v-for="entry of props.row.localeStatus"
                  :key="`translation-` + entry.locale"
                  :outline="entry.state === 'primary' || entry.state === 'current'"
                  :color="translationStatusColor(entry.state)"
                  :label="entry.locale"
                  :title="translationStatusTitle(entry)" />
              </div>
            </w-td>
          </template>
          <template #body-cell-tags="props">
            <w-td :props="props">
              <div class="flex flex-wrap gap-1">
                <w-chip
                  v-for="tag of props.row.tags"
                  :key="`tag-` + tag"
                  square
                  color="secondary"
                  text-color="white"
                  icon="la:hashtag"
                  size="sm"
                  >{{ tag }}</w-chip
                >
              </div>
            </w-td>
          </template>
          <template #body-cell-updatedAt="props">
            <w-td :props="props">
              <div>{{ formattedDate(props.value) }}</div>
              <div class="text-caption text-grey">{{ relativeDate(props.value) }}</div>
            </w-td>
          </template>
          <template #body-cell-actions="props">
            <w-td :props="props">
              <w-btn
                class="acrylic-btn"
                flat
                no-caps
                icon="la:eye"
                :color="dark.isActive ? `indigo-4` : `indigo`"
                :label="t(`common.actions.view`)"
                :to="pageLink(props.row)" />
            </w-td>
          </template>
        </w-table>
      </w-card>

      <div class="flex items-center mt-2">
        <div class="text-caption text-grey flex-1">
          <i18n-t keypath="search.totalResults" tag="span" :plural="state.total">
            <strong>{{ state.total }}</strong>
          </i18n-t>
        </div>
        <w-pagination
          v-if="totalPages > 1"
          v-model="state.currentPage"
          :max="totalPages"
          :max-pages="9"
          boundary-numbers
          direction-links />
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { computed, onMounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useDark } from '@/composables/dark'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { confirm } from '@/composables/dialog'

import { useAdminStore } from '@/stores/admin'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { relativeDate } from '@/helpers/datetime'
import { apiErrorMessage } from '@/helpers/apiError'
import { localizedPagePath } from '@/helpers/pagePaths'

/**
 * OpenProject #1880: a real, server-paged inventory of a site's pages -- the substitute
 * `AdminPages.vue`/`AdminPagesEdit.vue`/`AdminPagesVisualize.vue`/`AdminTags.vue`'s deletion
 * (commit 377915c6) left nothing behind for, since `/_search` caps out at 100 rows with no per-row
 * action. Built entirely on `GET sites/:siteId/pages/search` -- the same paginating,
 * filter-by-path/locale/tag/editor/publishState route `Search.vue` already uses -- rather than a
 * new backend endpoint.
 *
 * The row shape that route answers with has no `editor` or `publishState` field, even though both
 * are valid filters on it (every search-engine module's SELECT list was checked, not just the
 * default db one) -- so those two narrow the result set without being shown as their own column.
 *
 * OpenProject #1882 layers row selection and bulk delete/re-render/retag on top: selection is
 * scoped to the CURRENT PAGE of results only ("select-all-on-page", not a select-everything-
 * matching-the-filter across every page of the pager) -- `state.selectedIds` is cleared on every
 * reload (a filter change, a page change, or after a bulk action lands), so it never silently
 * carries a stale id from a row that has since scrolled out of view.
 *
 * The bulk endpoint (`POST .../pages/bulk`) reports a status per page rather than failing outright
 * on the first one the caller may not act on -- `applyBulkResult` below is what turns that into a
 * notification summarizing how many landed versus were skipped/not found/errored.
 *
 * OpenProject #2476 adds the Translations column: `includeLocaleStatus=true` on the same search
 * call asks for each row's per-active-locale staleness/missing status
 * (`docs/decisions/locale-translation-linking.md`'s `translation.updatedAt < primary.updatedAt`
 * join), rendered as one badge per locale. Opt-in on the request so this view's own query is the
 * only one that pays for the extra join -- `Search.vue`/`HeaderSearch.vue`/the link picker never do.
 */

// COMPOSABLES

const dark = useDark()

// STORES

const adminStore = useAdminStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => ({
  title: t('admin.pages.title')
}))

// DATA

/** Rows per fetched page. The search route caps `limit` at 100 server-side. */
const PAGE_SIZE = 50

const state = reactive({
  loading: 0,
  bulkLoading: false,
  rows: [],
  total: 0,
  currentPage: 1,
  /** This site's currently active locale codes, for the locale filter -- fetched alongside the rows. */
  activeLocales: [],
  filters: {
    path: '',
    locales: [],
    tags: '',
    editor: '',
    publishState: ''
  },
  selectedIds: [],
  retagOpen: false,
  retagAdd: '',
  retagRemove: ''
})

const headers = [
  {
    label: '',
    align: 'center',
    field: 'id',
    name: 'select',
    style: 'width: 40px'
  },
  {
    label: t('admin.pages.colTitle'),
    align: 'left',
    field: 'title',
    name: 'title'
  },
  {
    label: t('admin.pages.colLocale'),
    align: 'left',
    field: 'locale',
    name: 'locale',
    style: 'width: 90px'
  },
  {
    label: t('admin.pages.colTranslations'),
    align: 'left',
    field: 'localeStatus',
    name: 'translations'
  },
  {
    label: t('admin.pages.colTags'),
    align: 'left',
    field: 'tags',
    name: 'tags'
  },
  {
    label: t('admin.pages.colUpdated'),
    align: 'left',
    field: 'updatedAt',
    name: 'updatedAt',
    style: 'width: 220px'
  },
  {
    label: '',
    align: 'right',
    field: 'actions',
    name: 'actions',
    style: 'width: 140px'
  }
]

const editorOptions = computed(() => [
  { label: t('search.editorAny'), value: '' },
  { label: 'AsciiDoc', value: 'asciidoc' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'Visual Editor', value: 'wysiwyg' }
])

const publishStateOptions = computed(() => [
  { label: t('search.publishStateAny'), value: '' },
  { label: t('search.publishStateDraft'), value: 'draft' },
  { label: t('search.publishStatePublished'), value: 'published' },
  { label: t('search.publishStateScheduled'), value: 'scheduled' }
])

const localeOptions = computed(() =>
  state.activeLocales.map((code) => {
    const known = adminStore.locales.find((lc) => lc.code === code)
    return { label: known ? `${known.nativeName} (${code})` : code, value: code }
  })
)

const totalPages = computed(() => Math.max(1, Math.ceil(state.total / PAGE_SIZE)))

const allOnPageSelected = computed(
  () => state.rows.length > 0 && state.rows.every((row) => state.selectedIds.includes(row.id))
)
const someOnPageSelected = computed(() => state.selectedIds.length > 0)

/**
 * Set just before `applyFilters()`/`resetFilters()` reset `state.currentPage` to 1, so the
 * `currentPage` watcher below -- which would otherwise treat that reset as an ordinary,
 * pager-driven page change and issue its own, duplicate `load({ page: 1 })` -- skips its own fetch.
 * Same guard as `AdminUsers.vue` carries for the identical race (OpenProject #953).
 */
let resettingPageForFilters = false

// WATCHERS

watch(() => adminStore.currentSiteId, init)
watch(
  () => state.currentPage,
  (newValue) => {
    if (resettingPageForFilters) {
      resettingPageForFilters = false
      return
    }
    load({ page: newValue })
  }
)

// METHODS

function formattedDate(val) {
  return userStore.formatDateTime(t, val)
}

function pageLink(row) {
  return localizedPagePath(row.path, row.locale, siteStore.localeRouting)
}

/**
 * Badge color for one locale's translation status (OpenProject #2476) -- `primary`/`current` are
 * calm/neutral (nothing needs the reader's attention), `stale`/`missing` use the same
 * warning/negative colors the rest of the admin area reserves for something that does.
 */
function translationStatusColor(state) {
  switch (state) {
    case 'primary':
      return 'grey-6'
    case 'stale':
      return 'warning'
    case 'missing':
      return 'negative'
    default:
      return 'positive'
  }
}

function translationStatusTitle(entry) {
  return t(`admin.pages.translationStatus${entry.state[0].toUpperCase()}${entry.state.slice(1)}`, {
    locale: entry.locale
  })
}

function buildSearchParams(offset) {
  const searchParams = new URLSearchParams()
  if (state.filters.path) {
    searchParams.set('path', state.filters.path)
  }
  if (state.filters.locales.length > 0) {
    searchParams.set('locales', state.filters.locales.join(','))
  }
  const tags = state.filters.tags
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  if (tags.length > 0) {
    searchParams.set('tags', tags.join(','))
  }
  if (state.filters.editor) {
    searchParams.set('editor', state.filters.editor)
  }
  if (state.filters.publishState) {
    searchParams.set('publishState', state.filters.publishState)
  }
  searchParams.set('orderBy', 'updatedAt')
  searchParams.set('orderByDirection', 'desc')
  searchParams.set('limit', PAGE_SIZE)
  searchParams.set('offset', offset)
  // -> The per-row Translations column needs each result's cross-locale staleness/missing status
  //    (OpenProject #2476); opt-in on the shared search route so its other callers (reader search,
  //    header search, the link picker) never pay for a join this view is the only one rendering.
  searchParams.set('includeLocaleStatus', 'true')
  return searchParams
}

async function fetchPage(offset) {
  return API_CLIENT.get(`sites/${adminStore.currentSiteId}/pages/search`, {
    searchParams: buildSearchParams(offset)
  }).json()
}

async function load({ page } = {}) {
  if (!adminStore.currentSiteId) {
    return
  }
  const targetPage = page ?? state.currentPage ?? 1
  state.loading++
  try {
    const resp = await fetchPage((targetPage - 1) * PAGE_SIZE)
    state.rows = (resp?.results ?? []).map((r) => ({ ...r, tags: [...(r.tags ?? [])].sort() }))
    state.total = resp?.totalHits ?? 0
    state.currentPage = targetPage
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

function applyFilters() {
  resettingPageForFilters = state.currentPage !== 1
  state.currentPage = 1
  load({ page: 1 })
}

function resetFilters() {
  state.filters.path = ''
  state.filters.locales = []
  state.filters.tags = ''
  state.filters.editor = ''
  state.filters.publishState = ''
  applyFilters()
}

async function loadSite() {
  if (!adminStore.currentSiteId) {
    return
  }
  try {
    // -> The active locale list travels with the site being administered, not with `siteStore` --
    //    which may be a different site entirely. Same lookup `AdminPagesDeleted.vue` makes.
    const site = await API_CLIENT.get(`sites/${adminStore.currentSiteId}?strict=true`).json()
    state.activeLocales = site?.locales?.active ?? []
  } catch {
    // -> Non-fatal: the locale filter just has nothing to offer. The page list itself still loads.
  }
}

async function init() {
  await Promise.all([loadSite(), load({ page: 1 })])
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
    await load({ page: state.currentPage })
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

onMounted(init)
</script>
