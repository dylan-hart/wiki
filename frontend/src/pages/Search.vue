<template>
  <w-layout>
    <w-header><header-nav /></w-header>
    <w-page-container class="layout-search">
      <div class="layout-search-card">
        <!--
          Below 900px the sort and filter panel is a disclosure rather than a column: 300px of it
          beside a 390px screen leaves the results a 210px strip, and a column of form fields cannot
          be narrowed to its content. Closed to start with -- a reader arriving here wants results.
        -->
        <w-btn
          v-if="isFiltersCollapsed"
          class="layout-search-filterbtn"
          flat
          data-testid="search-filters-toggle"
          :label="filtersButtonLabel"
          :aria-expanded="state.filtersOpen"
          @click="toggleFilters">
          <w-icon
            class="layout-search-filterchevron"
            :class="{ 'is-open': state.filtersOpen }"
            name="tabler:chevron-down" />
        </w-btn>
        <!--
          Filter rows are shown in both modes: every row type is part of the semantic route's
          contract too. Sort By is the one control hidden in Semantic mode -- that route
          takes no `orderBy` (results are implicitly ordered by similarity), so it would offer a
          control that silently does nothing.
        -->
        <div class="layout-search-sd" v-show="!isFiltersCollapsed || state.filtersOpen">
          <template v-if="!isSemanticMode">
            <div class="section-header">{{ t('search.sortBy') }}</div>
            <w-list dense padding>
              <w-item
                v-for="item of orderByOptions"
                :key="item.value"
                clickable
                :active="item.value === state.params.orderBy"
                @click="setOrderBy(item.value)">
                <!-- `accent`, not `primary`: the active row is accent red, not the link blue. -->
                <w-item-section side>
                  <w-icon
                    :name="item.icon"
                    :color="item.value === state.params.orderBy ? `accent` : ``" />
                </w-item-section>
                <w-item-section
                  ><w-item-label>{{ item.label }}</w-item-label></w-item-section
                >
                <w-item-section v-if="item.value === state.params.orderBy" side>
                  <w-icon
                    :name="
                      state.params.orderByDirection === `desc`
                        ? `tabler:arrow-bar-down`
                        : `tabler:arrow-bar-up`
                    "
                    size="sm"
                    color="accent" />
                </w-item-section>
              </w-item>
            </w-list>
          </template>
          <div class="section-header">
            <span>{{ t('search.filters') }}</span>
            <w-space />
            <w-btn
              data-testid="search-filter-add"
              flat
              round
              dense
              size="sm"
              icon="la:plus"
              :aria-label="t('search.addFilter')"
              :disabled="state.filters.length >= SEARCH_FILTERS_MAX_ROWS"
              @click="addFilter" />
          </div>
          <div class="layout-search-filterlist">
            <div
              v-for="row of state.filters"
              :key="row.id"
              class="layout-search-filterrow"
              data-testid="search-filter-row">
              <div class="layout-search-filterline">
                <w-select
                  class="layout-search-filtermode"
                  data-testid="search-filter-mode"
                  :model-value="row.mode"
                  emit-value
                  map-options
                  dense
                  options-dense
                  :aria-label="t('search.filterMode')"
                  :options="modeOptions"
                  @update:model-value="(v) => setFilterMode(row, v)" />
                <w-select
                  class="layout-search-filtertype"
                  data-testid="search-filter-type"
                  :model-value="row.type"
                  emit-value
                  map-options
                  dense
                  options-dense
                  :aria-label="t('search.filterType')"
                  :options="typeOptions"
                  @update:model-value="(v) => setFilterType(row, v)" />
                <w-btn
                  data-testid="search-filter-remove"
                  flat
                  round
                  dense
                  size="sm"
                  icon="la:trash"
                  :aria-label="t('search.removeFilter')"
                  @click="removeFilter(row)" />
              </div>
              <w-input
                v-if="isFreeTextFilterType(row.type)"
                data-testid="search-filter-value"
                dense
                :model-value="row.value"
                :maxlength="SEARCH_FILTER_VALUE_MAX_LENGTH"
                :prefix="row.type === `path` ? `/` : `#`"
                :aria-label="t('search.filterValue')"
                :placeholder="row.type === `path` ? t('search.filterPath') : t('search.filterTag')"
                @update:model-value="(v) => setFilterValue(row, v)" />
              <w-select
                v-else
                data-testid="search-filter-value"
                :model-value="row.value"
                emit-value
                map-options
                dense
                options-dense
                :aria-label="t('search.filterValue')"
                :options="valueOptionsFor(row.type)"
                @update:model-value="(v) => setFilterValue(row, v)" />
            </div>
          </div>
        </div>
        <w-page>
          <div class="section-header">
            <span>{{ t('search.results') }}</span>
            <w-btn-toggle
              v-if="siteStore.features.semanticSearch"
              class="layout-search-modetoggle ms-3"
              :model-value="state.mode"
              :aria-label="t('search.modeToggleLabel')"
              :options="searchModeOptions"
              @update:model-value="setSearchMode" />
            <w-space />
            <transition name="slide-up" mode="out-in">
              <i18n-t
                class="layout-search-count"
                v-if="!siteStore.searchIsLoading"
                :keypath="
                  state.totalApproximate ? `search.totalResultsApprox` : `search.totalResults`
                "
                tag="span"
                :plural="state.total">
                <strong>{{ state.total }}</strong>
              </i18n-t>
            </transition>
          </div>
          <div class="p-6" v-if="state.results.length < 1">
            <i18n-t
              keypath="search.noResults"
              tag="span"
              v-if="siteStore.search && siteStore.searchLastQuery">
              <strong>{{ siteStore.searchLastQuery }}</strong>
            </i18n-t>
            <span v-else class="layout-search-empty-prompt"
              ><em>{{ t('search.emptyQuery') }}</em></span
            >
          </div>
          <!--
            Plain markup rather than `w-list`/`w-item`: `WItemSection` drives its own leading-column,
            padding and avatar metrics, while every measurement in this row is the design's own --
            through the shared component each of them would have to be overridden from the outside.
          -->
          <div class="layout-search-results">
            <router-link
              v-for="item of formattedResults"
              :key="`${item.locale}:${item.path}`"
              class="layout-search-row"
              :to="localizedPagePath(item.path, item.locale, siteStore.localeRouting)">
              <div class="layout-search-plate">
                <w-icon :name="item.icon || defaultPageIcon" size="18px" />
              </div>
              <div class="layout-search-rowbody">
                <div class="layout-search-rowtitle">
                  {{ item.title }}
                  <search-result-hop-badge :hop="item.hop" />
                </div>
                <div v-if="item.description" class="layout-search-rowdesc">
                  {{ item.description }}
                </div>
                <div class="layout-search-rowpath">/{{ item.path }}</div>
                <div class="layout-search-rowexcerpt text-highlight" v-if="item.highlight">
                  <span v-html="item.highlight" />
                </div>
                <div class="layout-search-rowexcerpt" v-else-if="item.chunkText">
                  <span>{{ item.chunkText }}</span>
                </div>
              </div>
              <div class="layout-search-rowmeta">
                <!--
                  The match percentage replaces the date rather than sitting beside it: a semantic
                  row carries no `updatedAt` at all.
                -->
                <div class="layout-search-rowdate">
                  <search-result-similarity-badge
                    v-if="item.distance !== null && item.distance !== undefined"
                    :distance="item.distance" />
                  <template v-else>{{ item.updatedAtFormatted }}</template>
                </div>
                <!--
                  Only when there is something to draw: an empty wrapper would still take the
                  column's gap and lift the date off the row's baseline on every untagged page.
                -->
                <div v-if="item.tags?.length > 0" class="layout-search-rowtags">
                  <w-chip
                    v-for="tag of item.tags"
                    :key="`tag-` + tag"
                    icon="tabler:hash"
                    size="sm"
                    >{{ tag }}</w-chip
                  >
                </div>
              </div>
            </router-link>
          </div>
          <div class="flex justify-center p-4" v-if="state.results.length < state.total">
            <w-btn
              flat
              color="primary"
              :label="t('search.loadMore')"
              :loading="state.loading > 0"
              @click="loadMore" />
          </div>
          <div v-if="showAssetsSection" class="layout-search-assets" data-testid="search-assets">
            <div class="section-header">
              <span>{{ t('search.assetsHeading') }}</span>
              <w-btn-toggle
                class="layout-search-modetoggle ms-3"
                data-testid="search-asset-kind"
                :model-value="state.assets.kind"
                :aria-label="t('search.assetKindLabel')"
                :options="assetKindOptions"
                @update:model-value="setAssetKind" />
              <w-space />
              <i18n-t
                class="layout-search-count"
                :keypath="
                  state.assets.totalApproximate
                    ? `search.totalResultsApprox`
                    : `search.totalResults`
                "
                tag="span"
                :plural="state.assets.total">
                <strong>{{ state.assets.total }}</strong>
              </i18n-t>
            </div>
            <div v-if="state.assets.results.length < 1" class="p-6">
              <i18n-t keypath="search.assetsNoMatches" tag="span">
                <strong>{{ state.assets.query }}</strong>
              </i18n-t>
            </div>
            <div class="layout-search-results">
              <a
                v-for="item of state.assets.results"
                :key="item.id"
                class="layout-search-row"
                data-testid="search-asset-row"
                :href="assetUrl(item.folderPath, item.fileName)"
                target="_blank"
                rel="noopener">
                <div class="layout-search-plate">
                  <w-icon :name="assetKindIcons[item.kind] || assetKindIcons.other" size="18px" />
                </div>
                <div class="layout-search-rowbody">
                  <div class="layout-search-rowtitle">{{ item.fileName }}</div>
                  <div class="layout-search-rowpath">
                    {{ assetPath(item.folderPath, item.fileName) }}
                  </div>
                  <div class="layout-search-rowexcerpt text-highlight" v-if="item.highlight">
                    <span v-html="item.highlight" />
                  </div>
                </div>
                <div class="layout-search-rowmeta">
                  <div class="layout-search-rowdate">{{ formatFileSize(item.fileSize) }}</div>
                </div>
              </a>
            </div>
            <div
              class="flex justify-center p-4"
              v-if="state.assets.results.length < state.assets.total">
              <w-btn
                flat
                color="primary"
                data-testid="search-asset-load-more"
                :label="t('search.loadMore')"
                :loading="state.assets.loading"
                @click="loadMoreAssets" />
            </div>
          </div>
        </w-page>
        <w-inner-loading :showing="state.loading > 0" />
      </div>
      <w-footer><footer-nav /></w-footer>
    </w-page-container>
    <main-overlay-dialog />
  </w-layout>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onMounted, onUnmounted, reactive, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'
import { useMinWidth } from '@/composables/screen'

import { localizedPagePath } from '@/helpers/pagePaths'

import { useFlagsStore } from '@/stores/flags'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import { DEFAULT_PAGE_ICON } from '@/stores/page'

import { debounce } from 'es-toolkit/function'
import HeaderNav from '@/components/HeaderNav.vue'
import FooterNav from '@/components/FooterNav.vue'
import MainOverlayDialog from '@/components/MainOverlayDialog.vue'
import SearchResultHopBadge from '@/components/SearchResultHopBadge.vue'
import SearchResultSimilarityBadge from '@/components/SearchResultSimilarityBadge.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { assetPath, assetUrl } from '@/helpers/assets'
import { formatFileSize } from '@/helpers/fileSize'
import { log } from '@/helpers/log'
import {
  SEARCH_FILTER_VALUE_MAX_LENGTH,
  SEARCH_FILTERS_MAX_ROWS,
  appliedFilters,
  defaultFilterValue,
  filtersToSearchParams,
  hasIncludeFilter,
  isFreeTextFilterType,
  newFilterRow,
  restoreFilters,
  toSavedFilters
} from '@/helpers/searchFilters'
import { extractTags, MAX_QUERY_LENGTH } from './searchTags.js'

/** The API caps a single request at 100. */
const RESULTS_LIMIT = 100

const ASSET_RESULTS_LIMIT = 10

const assetKindIcons = {
  document: 'tabler:file-text',
  image: 'tabler:photo',
  other: 'tabler:file'
}

const flagsStore = useFlagsStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const router = useRouter()
const route = useRoute()

const { t } = useI18n()

/* Both halves: `/_search` is mounted on its own, with no layout above it to supply either. */
useMeta(() => {
  const siteTitle = siteStore.title
  return {
    title: t('search.results'),
    titleTemplate: (title) => `${title} - ${siteTitle}`
  }
})

const state = reactive({
  loading: 0,
  /** Not persisted: a fresh visit to `/_search` always starts on Keyword. */
  mode: 'keyword',
  /** Only consulted below 900px, where the sort/filter panel is a disclosure. */
  filtersOpen: false,
  params: {
    orderBy: 'relevancy',
    orderByDirection: 'desc'
  },
  filters: [],
  filtersLoaded: !userStore.authenticated,
  results: [],
  total: 0,
  /**
   * `true` when `total` is a floor rather than an exact count: this reader's page rules dropped
   * rows the search engine itself matched. Only the count can undercount -- the list is never
   * wrong, since everything shown is something this reader may actually open.
   */
  totalApproximate: false,
  offset: 0,
  /**
   * A separate list from the page results: own endpoint and paging, and neither saved filter rows
   * nor `orderBy` apply. `kind` outlives a query so a chosen type keeps narrowing the next search.
   */
  assets: {
    kind: 'all',
    query: '',
    results: [],
    total: 0,
    totalApproximate: false,
    offset: 0,
    loading: false
  }
})

let assetRequestId = 0

/**
 * This layout's own breakpoint rather than one of the app's, and the same one `ProfileOverlay`
 * uses: the two screens are the same shape -- a card with a 300px sidebar -- so they run out of
 * room at the same width. The stylesheet's `899.98px` is the same boundary from the other side.
 */
const isAtLeast900 = useMinWidth(900)
const isFiltersCollapsed = computed(() => !isAtLeast900.value)

const isSemanticMode = computed(() => state.mode === 'semantic')

const searchModeOptions = computed(() => [
  { label: t('search.modeKeyword'), value: 'keyword', icon: 'tabler:file-search' },
  { label: t('search.modeSemantic'), value: 'semantic', icon: 'tabler:wand' }
])

const assetKindOptions = computed(() => [
  { label: t('search.assetKindAll'), value: 'all' },
  { label: t('search.assetKindDocument'), value: 'document' },
  { label: t('search.assetKindImage'), value: 'image' },
  { label: t('search.assetKindOther'), value: 'other' }
])

/**
 * A kind that narrows to nothing keeps the section up: hiding it would strand the reader on that
 * kind.
 */
const showAssetsSection = computed(
  () =>
    !isSemanticMode.value &&
    (state.assets.results.length > 0 ||
      (state.assets.kind !== 'all' && state.assets.query.length > 0))
)

const orderByOptions = computed(() => {
  return [
    { label: t('search.sortByRelevance'), value: 'relevancy', icon: 'tabler:timeline' },
    { label: t('search.sortByTitle'), value: 'title', icon: 'tabler:heading' },
    { label: t('search.sortByLastUpdated'), value: 'updatedAt', icon: 'tabler:calendar' }
  ]
})

const modeOptions = computed(() => [
  { label: t('search.filterModeInclude'), value: 'include' },
  { label: t('search.filterModeExclude'), value: 'exclude' }
])

const typeOptions = computed(() => [
  { label: t('search.filterTypePath'), value: 'path' },
  { label: t('search.filterTypeTag'), value: 'tag' },
  { label: t('search.filterTypeLocale'), value: 'locale' },
  { label: t('search.filterTypeEditor'), value: 'editor' },
  { label: t('search.filterTypePublishState'), value: 'publishState' }
])

const editorOptions = computed(() => [
  { label: 'AsciiDoc', value: 'asciidoc' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'Visual Editor', value: 'wysiwyg' }
])

const publishStateOptions = computed(() => [
  { label: t('search.publishStateDraft'), value: 'draft' },
  { label: t('search.publishStatePublished'), value: 'published' },
  { label: t('search.publishStateScheduled'), value: 'scheduled' }
])

const localeOptions = computed(() =>
  siteStore.locales.active.map((locale) => ({ label: locale.name, value: locale.code }))
)

const localeCodes = computed(() => siteStore.locales.active.map((locale) => locale.code))

const activeFilterCount = computed(() => appliedFilters(state.filters).length)

const filtersButtonLabel = computed(() =>
  activeFilterCount.value > 0
    ? t('search.filtersActive', { count: activeFilterCount.value })
    : t('search.filters')
)

function valueOptionsFor(type) {
  if (type === 'locale') {
    return localeOptions.value
  }
  return type === 'editor' ? editorOptions.value : publishStateOptions.value
}

const defaultPageIcon = DEFAULT_PAGE_ICON

/**
 * Formatted once per result-set change rather than once per render of a list that can hold up to
 * `RESULTS_LIMIT` rows. A row carrying a `distance` is a semantic result: it has no `updatedAt`
 * field at all and draws a match-percentage badge in this field's place, so the `'---'` no-date
 * fallback would be a placeholder nothing ever reads.
 */
const formattedResults = computed(() =>
  state.results.map((r) => ({
    ...r,
    updatedAtFormatted:
      r.distance === null || r.distance === undefined
        ? userStore.formatRecent(t, r.updatedAt) || '---'
        : null
  }))
)

watch(
  () => route.query,
  async (newQueryObj) => {
    if (newQueryObj.q) {
      siteStore.search = newQueryObj.q.trim().slice(0, MAX_QUERY_LENGTH)
      // -> `HeaderSearch.vue` carries its pending mode here, so a semantic search started from the
      //    header lands already in Semantic mode. A stray `mode=semantic` is not honoured where the
      //    feature is unavailable, and no `mode` param at all leaves whatever mode was already
      //    selected untouched.
      if (newQueryObj.mode === 'semantic' && siteStore.features.semanticSearch) {
        state.mode = 'semantic'
      } else if (newQueryObj.mode === 'keyword') {
        state.mode = 'keyword'
      }
      performSearch()
    }
  },
  { immediate: true }
)

let nextFilterId = 0
let restoringFilters = false
let savedFiltersSnapshot = '[]'

const queueSearch = debounce(() => performSearch(), 500)
const queueSaveFilters = debounce(() => saveFilters(), 500)

const filtersSignature = computed(() => JSON.stringify(appliedFilters(state.filters)))

watch(() => state.params, queueSearch, { deep: true })

watch(filtersSignature, () => {
  if (!restoringFilters) {
    queueSearch()
  }
})

function addFilter() {
  if (state.filters.length >= SEARCH_FILTERS_MAX_ROWS) {
    return
  }
  state.filters.push({ id: ++nextFilterId, ...newFilterRow(localeCodes.value) })
}

function removeFilter(row) {
  state.filters = state.filters.filter((r) => r.id !== row.id)
  queueSaveFilters()
}

function setFilterMode(row, mode) {
  row.mode = mode
  queueSaveFilters()
}

function setFilterType(row, type) {
  if (type === row.type) {
    return
  }
  const keepsText = isFreeTextFilterType(row.type) && isFreeTextFilterType(type)
  row.type = type
  row.value = keepsText ? row.value : defaultFilterValue(type, localeCodes.value)
  queueSaveFilters()
}

function setFilterValue(row, value) {
  row.value = value ?? ''
  queueSaveFilters()
}

async function loadSavedFilters() {
  if (!userStore.authenticated) {
    return
  }
  try {
    state.loading++
    const resp = await API_CLIENT.get('users/profile').json()
    const saved = restoreFilters(resp?.searchFilters)
    savedFiltersSnapshot = JSON.stringify(saved)
    if (state.filters.length < 1) {
      restoringFilters = true
      state.filters = saved.map((row) => ({ id: ++nextFilterId, ...row }))
      await nextTick()
      restoringFilters = false
    }
  } catch (err) {
    log.warn('search', 'could not load the saved search filters', err)
  } finally {
    state.loading--
    state.filtersLoaded = true
  }
  performSearch()
}

async function saveFilters() {
  if (!userStore.authenticated) {
    return
  }
  const payload = toSavedFilters(state.filters)
  const snapshot = JSON.stringify(payload)
  if (snapshot === savedFiltersSnapshot) {
    return
  }
  try {
    await API_CLIENT.put('users/profile', { json: { searchFilters: payload } }).json()
    savedFiltersSnapshot = snapshot
  } catch (err) {
    log.warn('search', 'could not save the search filters', err)
    notify({
      type: 'negative',
      message: t('search.filtersSaveFailed'),
      caption: apiErrorMessage(err)
    })
  }
}

function toggleFilters() {
  state.filtersOpen = !state.filtersOpen
}

function setOrderBy(val) {
  if (val === state.params.orderBy) {
    state.params.orderByDirection = state.params.orderByDirection === 'desc' ? 'asc' : 'desc'
  } else {
    state.params.orderBy = val
    state.params.orderByDirection = val === 'title' ? 'asc' : 'desc'
  }
}

function resetResults() {
  state.results = []
  state.total = 0
  state.totalApproximate = false
  state.offset = 0
  siteStore.searchLastQuery = siteStore.search
  siteStore.searchIsLoading = false
}

async function runSearchRequest(endpoint, searchParams, append) {
  const offset = append ? state.offset : 0

  state.loading++
  siteStore.searchIsLoading = true
  try {
    const resp = await API_CLIENT.get(endpoint, {
      searchParams: [...searchParams, ['offset', offset], ['limit', RESULTS_LIMIT]]
    }).json()
    const results = (resp?.results ?? []).map((r) => ({ ...r, tags: [...(r.tags ?? [])].sort() }))
    state.results = append ? [...state.results, ...results] : results
    state.total = resp?.totalHits ?? 0
    state.totalApproximate = resp?.totalHitsApproximate ?? false
    state.offset = offset + results.length
    siteStore.searchLastQuery = siteStore.search
  } catch (err) {
    if (!append) {
      state.results = []
      state.total = 0
      state.totalApproximate = false
      state.offset = 0
    }
    notify({
      type: 'negative',
      message: t('search.failed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.loading--
    siteStore.searchIsLoading = false
  }
}

function resetAssets() {
  assetRequestId++
  state.assets.query = ''
  state.assets.results = []
  state.assets.total = 0
  state.assets.totalApproximate = false
  state.assets.offset = 0
  state.assets.loading = false
}

async function performAssetSearch(q, append = false) {
  const requestId = ++assetRequestId
  const offset = append ? state.assets.offset : 0

  state.assets.query = q
  state.assets.loading = true
  try {
    const resp = await API_CLIENT.get(`sites/${siteStore.id}/assets/search`, {
      searchParams: [
        ['query', q],
        ...(state.assets.kind === 'all' ? [] : [['kind', state.assets.kind]]),
        ['offset', offset],
        ['limit', ASSET_RESULTS_LIMIT]
      ]
    }).json()
    // -> A newer search or kind change started while this one was in flight; its answer wins.
    if (requestId !== assetRequestId) {
      return
    }
    const results = resp?.results ?? []
    state.assets.results = append ? [...state.assets.results, ...results] : results
    state.assets.total = resp?.totalHits ?? 0
    state.assets.totalApproximate = resp?.totalHitsApproximate ?? false
    state.assets.offset = offset + results.length
  } catch (err) {
    if (requestId !== assetRequestId) {
      return
    }
    log.warn('search', 'could not search asset contents', err)
    if (!append) {
      state.assets.results = []
      state.assets.total = 0
      state.assets.totalApproximate = false
      state.assets.offset = 0
    }
    notify({
      type: 'negative',
      message: t('search.failed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    if (requestId === assetRequestId) {
      state.assets.loading = false
    }
  }
}

function setAssetKind(kind) {
  if (kind === state.assets.kind) {
    return
  }
  state.assets.kind = kind
  if (state.assets.query) {
    performAssetSearch(state.assets.query)
  }
}

function loadMoreAssets() {
  return performAssetSearch(state.assets.query, true)
}

/**
 * Unlike the keyword path this sends the reader's query text through untouched. Tag filters are the
 * `#tag` tokens in the query plus any Tag rows, sent as repeated `tags` pairs. No `orderBy` is sent
 * either: results stay implicitly ordered by similarity.
 */
function performSemanticSearch(append) {
  const q = (siteStore.search ?? '').trim().replaceAll(/\s\s+/g, ' ')

  if (!q) {
    resetResults()
    return undefined
  }

  return runSearchRequest(
    `sites/${siteStore.id}/pages/search/semantic`,
    [
      ['query', q],
      ...filtersToSearchParams(state.filters, { queryTags: extractTags(siteStore.search) })
    ],
    append
  )
}

/** `append` is `loadMore()`'s alone: every other caller starts over at offset 0. */
async function performSearch(append = false) {
  if (!state.filtersLoaded) {
    return undefined
  }
  if (isSemanticMode.value) {
    // -> The semantic route reads pages only; no asset search runs in Semantic mode.
    resetAssets()
    return performSemanticSearch(append)
  }

  let q = siteStore.search ?? ''

  const queryTags = extractTags(q)
  for (const tag of queryTags) {
    q = q.replaceAll(`#${tag}`, '')
  }
  q = q.trim().replaceAll(/\s\s+/g, ' ')

  // -> Asking the server with nothing to go on answers with the most recently updated pages, which
  //    is not what an empty search box means. Exclude rows alone do not count: they narrow rather
  //    than select.
  if (!q && queryTags.length < 1 && !hasIncludeFilter(state.filters)) {
    resetResults()
    resetAssets()
    return undefined
  }

  // -> Asset text is matched against the words alone: tags and filter rows describe pages.
  const pagesRequest = runSearchRequest(
    `sites/${siteStore.id}/pages/search`,
    [
      ...(q ? [['query', q]] : []),
      ...filtersToSearchParams(state.filters, { queryTags }),
      ['orderBy', state.params.orderBy],
      ['orderByDirection', state.params.orderByDirection]
    ],
    append
  )

  if (append) {
    return pagesRequest
  }
  if (!q) {
    resetAssets()
    return pagesRequest
  }
  return Promise.all([pagesRequest, performAssetSearch(q)])
}

function setSearchMode(mode) {
  if (mode === state.mode) {
    return
  }
  state.mode = mode
  performSearch()
}

function loadMore() {
  return performSearch(true)
}

onMounted(async () => {
  if (!siteStore.search) {
    siteStore.searchIsLoading = false
  }
  await loadSavedFilters()
})

onUnmounted(() => {
  queueSearch.cancel()
  queueSaveFilters.flush()
  siteStore.search = ''
  siteStore.searchLastQuery = ''
  siteStore.searchIsLoading = false
})
</script>

<style>
/* Flat, not nested: a `&-suffix` selector is a Sass string-concatenation idiom that native CSS
   nesting silently drops -- such a rule never matches. */
@charset "UTF-8";
.layout-search {
  /* Plain ground: no band or gradient behind the card, which a hairline holds instead. */
}
.body--light .layout-search {
  background-color: var(--color-paper);
}
.body--dark .layout-search {
  background-color: var(--color-dark-6);
}
.layout-search-card {
  position: relative;
  width: 90%;
  max-width: 1400px;
  margin: 50px auto;
  display: flex;
  align-items: stretch;
  /*
    No height of its own: the scrolling page container grows this into the height left over beside
    its margins, and lets content take it past that. A `height` would overflow the box by exactly
    those margins and, not being a minimum, spill a long result list past the card's bottom edge.
  */
  /*
    A foreground as well as a background, because this card is a plain div rather than a WCard and a
    WCard is what declares BOTH halves of a surface. With only the background set, everything inside
    inherits the document's black, which is invisible on the dark one.
  */
}
.body--light .layout-search-card {
  background-color: var(--color-white);
  border: 1px solid var(--color-hairline);
  color: var(--color-text-body);
}
.body--dark .layout-search-card {
  background-color: var(--color-dark-3);
  border: 1px solid var(--color-hairline-dark);
  color: var(--color-text-dark);
}
.layout-search-card {
  /*
    Cobalt draws this card's edge through `--shadow-card` alone, not the `border` above: under
    Ledger both tokens are `0`/`none`, so that border stays the only visible edge there. No dark
    override is needed -- `--shadow-card` already carries its own Cobalt-dark value.
  */
}
body.body--cobalt .layout-search-card {
  border: 0;
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}
.layout-search-sd {
  flex: 0 0 300px;
  overflow: hidden;
}
.layout-search-filterlist {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px;
}
.layout-search-filterlist:empty {
  display: none;
}
.layout-search-filterrow {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.layout-search-filterline {
  display: flex;
  align-items: center;
  gap: 6px;
}
.layout-search-filtermode {
  flex: 0 0 104px;
  min-width: 0;
}
.layout-search-filtertype {
  flex: 1 1 0;
  min-width: 0;
}
.body--light .layout-search-sd {
  background-color: var(--color-tint);
  border-inline-end: 1px solid var(--color-hairline);
}
.body--dark .layout-search-sd {
  background-color: var(--color-dark-4);
  border-inline-end: 1px solid var(--color-hairline-dark);
}
.layout-search {
  /*
    A header strip (Sort by, Filters, Results) is PINNED to a fixed height with `line-height: 1`.
    The Results strip carries the result count, whose length is not known in advance; left to size
    itself the strip would follow its tallest line box and stop lining up with the Sort by strip
    that starts the column beside it, which the two are meant to read as one ruled line with.
  */
}
.layout-search .section-header {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 37px;
  padding: 0 16px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.body--light .layout-search .section-header {
  color: var(--color-accent-strong);
  background-color: var(--color-tint-alt);
  border-bottom: 1px solid var(--color-hairline);
}
.body--dark .layout-search .section-header {
  color: var(--color-accent-dark);
  background-color: var(--color-dark-2);
  border-bottom: 1px solid var(--color-hairline-dark);
}
.layout-search {
  /* -> A strip that follows content is ruled off from it as well as from what comes after */
}
.body--light .layout-search .layout-search-sd .section-header:not(:first-child) {
  border-top: 1px solid var(--color-hairline);
}
.body--dark .layout-search .layout-search-sd .section-header:not(:first-child) {
  border-top: 1px solid var(--color-hairline-dark);
}
.layout-search {
  /* `line-height: 1` for the same reason the strip is: this number changes length, and nothing
     about it may drive the bar's height. */
}
.layout-search-count {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 400;
  line-height: 1;
  letter-spacing: 0;
  text-transform: none;
}
.body--light .layout-search-count {
  color: var(--color-text-caption);
}
.body--dark .layout-search-count {
  color: var(--color-text-caption-dark);
}
.layout-search {
  /*
    `w-btn-toggle`'s segments set their own font-size but not family/text-transform/letter-spacing,
    so without this reset the labels inherit the `.section-header` strip's kicker styling instead of
    reading as ordinary control labels.
  */
}
.layout-search-modetoggle {
  font-family: var(--font-sans);
  text-transform: none;
  letter-spacing: normal;
}
.layout-search {
  /* -> `.text-highlight` (the matched-term `<b>` treatment) lives in `css/tailwind.css`'s */
  /*    `@layer components`, shared with `HeaderSearch.vue`'s preview panel. */
  /*
    The empty-query prompt is what the results pane shows before any search has run at all,
    distinct from `search.noResults` (a query WAS run and matched nothing).
  */
}
.layout-search-empty-prompt {
  font-size: 14.5px;
  line-height: 1.6;
}
.body--light .layout-search-empty-prompt {
  color: var(--color-text-secondary);
}
.body--dark .layout-search-empty-prompt {
  color: var(--color-text-secondary-dark);
}
.layout-search .w-page {
  flex: 1 1;
  min-width: 0;
}
.layout-search {
  /* --- A result row --- */
}
.layout-search-row {
  display: flex;
  gap: 14px;
  padding: 14px 16px;
  text-decoration: none;
  color: inherit;
}
.body--light .layout-search-row {
  border-bottom: 1px solid var(--color-hairline);
}
.body--dark .layout-search-row {
  border-bottom: 1px solid var(--color-hairline-dark);
}
.body--light .layout-search-row:hover {
  background-color: var(--color-paper);
}
.body--dark .layout-search-row:hover {
  background-color: var(--color-dark-2);
}
.layout-search {
  /*
    `var(--color-accent)`, not `var(--color-primary)`: the dark half uses `var(--color-accent-dark)`
    for the identical role, and the Cobalt icon plate glyph is the accent red, not the link blue.
    The two are numerically equal under Ledger, so only Cobalt shows the difference.
  */
}
.layout-search-plate {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
}
.body--light .layout-search-plate {
  border: 1px solid var(--color-hairline);
  background-color: var(--color-white);
  color: var(--color-accent);
}
.body--dark .layout-search-plate {
  border: 1px solid var(--color-hairline-dark);
  background-color: var(--color-dark-4);
  color: var(--color-accent-dark);
}
.layout-search-plate {
  /* Same shadowed-plate treatment as the card above. */
}
body.body--cobalt .layout-search-plate {
  border: 0;
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}
.layout-search {
  /*
    A ZERO basis, not `auto`, with `min-width: 0` beside it. Both are load-bearing below 600px where
    the row wraps: wrapping is decided from each item's hypothetical main size, so a body sized by
    its own content would not fit beside the plate and would drop onto its own line. From zero it
    stays on the plate's line and shrinks.
  */
}
.layout-search-rowbody {
  flex: 1 1 0;
  min-width: 0;
}
.layout-search-rowtitle {
  font-size: 15px;
  font-weight: 500;
}
.body--light .layout-search-rowtitle {
  color: var(--color-ink);
}
.body--dark .layout-search-rowtitle {
  color: var(--color-text-dark);
}
.layout-search-rowdesc {
  padding-top: 1px;
  font-size: 13px;
  line-height: 1.5;
}
.body--light .layout-search-rowdesc {
  color: var(--color-text-secondary);
}
.body--dark .layout-search-rowdesc {
  color: var(--color-text-secondary-dark);
}
.layout-search-rowpath {
  padding-top: 3px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
.body--light .layout-search-rowpath {
  color: var(--color-text-caption);
}
.body--dark .layout-search-rowpath {
  color: var(--color-text-caption-dark);
}
.layout-search-rowexcerpt {
  padding-top: 5px;
  font-size: 12.5px;
  line-height: 1.55;
}
.body--light .layout-search-rowexcerpt {
  color: var(--color-text-body);
}
.body--dark .layout-search-rowexcerpt {
  color: var(--color-text-dark);
}
/* Fixed rather than content-sized, so every row's title ends on the same edge down the list: a
   column that sized itself would step in and out as the dates and tag counts varied. */
.layout-search-rowmeta {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  width: 150px;
}
.layout-search-rowdate {
  font-family: var(--font-mono);
  font-size: 11.5px;
  text-align: end;
}
.body--light .layout-search-rowdate {
  color: var(--color-text-caption);
}
.body--dark .layout-search-rowdate {
  color: var(--color-text-caption-dark);
}
.layout-search-rowtags {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.layout-search {
  /*
    THREE NARROWER LAYOUTS

    Same thresholds as `components/ProfileOverlay.vue`, the app's other card-beside-a-sidebar screen,
    because the two run out of room together:

      below 1200px   the card's gutters halve. The sidebar keeps its 300px, unlike the profile's
                     nav: that one is a list of labels, this a column of form fields
      below 900px    the sidebar becomes a disclosure above the results
      below 600px    the card becomes the screen, and a result row stacks

    Ordered narrowest-last, so each block overrides the one above it. `899.98px` is the stylesheet's
    half of the 900px `useMinWidth`, which decides whether the disclosure button renders at all.
  */
  /* --- Below 1200px --- */
}
@media (max-width: 1199.98px) {
  .layout-search {
    /*
      Not bracketed to a band: below 900px the gutters would otherwise jump back to the wider pair
      as the window narrowed.
    */
  }
  .layout-search-card {
    width: 95%;
    margin: 25px auto;
  }
}
.layout-search {
  /* --- Below 900px --- */
}
@media (max-width: 899.98px) {
  .layout-search-card {
    flex-direction: column;
  }
  .layout-search {
    /* Full width, so the disclosure reads as a strip of the card rather than a button sitting on
       it, with its chevron at the far end from the label. */
  }
  .layout-search-filterbtn {
    justify-content: space-between;
  }
  .body--light .layout-search-filterbtn {
    background-color: var(--color-tint-alt);
    border-bottom: 1px solid var(--color-hairline);
  }
  .body--dark .layout-search-filterbtn {
    background-color: var(--color-dark-2);
    border-bottom: 1px solid var(--color-hairline-dark);
  }
  .layout-search {
    /* -> The button's content is one flex row, so the chevron needs pushing to its end */
  }
  .layout-search-filterbtn > span {
    flex: 1;
    justify-content: space-between;
  }
  .layout-search-filterchevron {
    transition: transform 0.2s var(--ease-standard);
  }
  .layout-search-filterchevron.is-open {
    transform: rotate(180deg);
  }
  .layout-search {
    /*
      The seam that divided the two columns moves from the panel's inline end to its bottom. Stated
      per theme because that is where the rules it replaces are declared -- at three classes each,
      which a plain override here would lose to.
    */
  }
  .layout-search-sd {
    flex: none;
    width: 100%;
  }
  .body--light .layout-search-sd {
    border-inline-end: 0;
    border-bottom: 1px solid var(--color-hairline);
  }
  .body--dark .layout-search-sd {
    border-inline-end: 0;
    border-bottom: 1px solid var(--color-hairline-dark);
  }
}
.layout-search {
  /* --- Below 600px --- */
}
@media (max-width: 599.98px) {
  .layout-search-card {
    width: 100%;
    margin: 0;
  }
  .body--light .layout-search-card {
    border-inline: 0;
  }
  .body--dark .layout-search-card {
    border-inline: 0;
  }
  .layout-search {
    /*
      A result stacks instead of reserving a column for its date and tags: that column is a fixed
      150px, and what is left of a 390px screen after a plate and a date is a few words of title.
    */
  }
  .layout-search-row {
    flex-wrap: wrap;
  }
  .layout-search {
    /* Centring suits a row two lines tall; on a stacked one the plate is stranded halfway down. */
  }
  .layout-search-plate {
    align-self: flex-start;
  }
  .layout-search {
    /*
      Lined up under the title rather than under the plate: 48px is the plate (34px) plus the row's
      gutter (14px), so changing either means changing this too.
    */
  }
  .layout-search-rowmeta {
    width: 100%;
    align-items: flex-start;
    margin-top: 0.25rem;
    padding-inline-start: 48px;
  }
  .layout-search-rowdate {
    text-align: start;
  }
  .layout-search-rowtags {
    justify-content: flex-start;
  }
}

body.body--dark {
  background-color: var(--color-dark-6);
}
</style>
