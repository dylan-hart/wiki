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
          :label="t(`search.filters`)"
          :aria-expanded="state.filtersOpen"
          @click="toggleFilters">
          <w-icon
            class="layout-search-filterchevron"
            :class="{ 'is-open': state.filtersOpen }"
            name="tabler:chevron-down" />
        </w-btn>
        <!--
          Shown in both modes: Path/Tags/Locale/Editor/Publish State are part of the semantic
          route's contract too. Sort By is the one control hidden in Semantic mode -- that route
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
          <div class="section-header">{{ t('search.filters') }}</div>
          <div class="p-2">
            <w-input
              dense
              :placeholder="t(`search.filterPath`)"
              prefix="/"
              v-model="state.params.filterPath">
              <template #prepend>
                <w-icon name="tabler:square-chevron-right" size="xs" />
              </template>
            </w-input>
            <w-select
              class="mt-2"
              v-model="state.selectedTags"
              :options="tags"
              dense
              options-dense
              use-input
              use-chips
              multiple
              hide-dropdown-icon
              :aria-label="t(`search.filterTags`)"
              @update:model-value="(v) => syncTags(v)"
              :placeholder="state.selectedTags.length < 1 ? t(`search.filterTags`) : ``"
              :loading="state.loading > 0">
              <template #prepend><w-icon name="tabler:hash" size="xs" /></template>
            </w-select>
            <w-select
              class="mt-2"
              v-model="state.params.filterLocale"
              emit-value
              map-options
              dense
              :aria-label="t(`search.filterLocale`)"
              :options="siteStore.locales.active"
              option-value="code"
              option-label="name"
              options-dense
              multiple
              :display-value="
                t(
                  `search.filterLocaleDisplay`,
                  {
                    n:
                      state.params.filterLocale.length > 0
                        ? state.params.filterLocale[0].toUpperCase()
                        : state.params.filterLocale.length
                  },
                  state.params.filterLocale.length
                )
              ">
              <template #prepend><w-icon name="tabler:language" size="xs" /></template>
            </w-select>
            <w-select
              class="mt-2"
              v-model="state.params.filterEditor"
              emit-value
              map-options
              dense
              :aria-label="t(`search.filterEditor`)"
              :options="editors">
              <template #prepend><w-icon name="tabler:ballpen" size="xs" /></template>
            </w-select>
            <w-select
              class="mt-2"
              v-model="state.params.filterPublishState"
              emit-value
              map-options
              dense
              :aria-label="t(`search.filterPublishState`)"
              :options="publishStates">
              <template #prepend><w-icon name="tabler:traffic-lights" size="xs" /></template>
            </w-select>
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
import { computed, onMounted, onUnmounted, reactive, watch } from 'vue'
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
import { difference } from 'es-toolkit/array'
import HeaderNav from '@/components/HeaderNav.vue'
import FooterNav from '@/components/FooterNav.vue'
import MainOverlayDialog from '@/components/MainOverlayDialog.vue'
import SearchResultHopBadge from '@/components/SearchResultHopBadge.vue'
import SearchResultSimilarityBadge from '@/components/SearchResultSimilarityBadge.vue'
import { apiErrorMessage } from '@/helpers/apiError'
import { log } from '@/helpers/log'
import { extractTags, MAX_QUERY_LENGTH } from './searchTags.js'

/** The API caps a single request at 100. */
const RESULTS_LIMIT = 100

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
    filterPath: '',
    filterLocale: [],
    filterEditor: '',
    filterPublishState: '',
    orderBy: 'relevancy',
    orderByDirection: 'desc'
  },
  selectedTags: [],
  results: [],
  total: 0,
  /**
   * `true` when `total` is a floor rather than an exact count: this reader's page rules dropped
   * rows the search engine itself matched. Only the count can undercount -- the list is never
   * wrong, since everything shown is something this reader may actually open.
   */
  totalApproximate: false,
  offset: 0
})

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

const orderByOptions = computed(() => {
  return [
    { label: t('search.sortByRelevance'), value: 'relevancy', icon: 'tabler:timeline' },
    { label: t('search.sortByTitle'), value: 'title', icon: 'tabler:heading' },
    { label: t('search.sortByLastUpdated'), value: 'updatedAt', icon: 'tabler:calendar' }
  ]
})

const editors = computed(() => {
  return [
    { label: t('search.editorAny'), value: '' },
    { label: 'AsciiDoc', value: 'asciidoc' },
    { label: 'Markdown', value: 'markdown' },
    { label: 'Visual Editor', value: 'wysiwyg' }
  ]
})

const publishStates = computed(() => {
  return [
    { label: t('search.publishStateAny'), value: '' },
    { label: t('search.publishStateDraft'), value: 'draft' },
    { label: t('search.publishStatePublished'), value: 'published' },
    { label: t('search.publishStateScheduled'), value: 'scheduled' }
  ]
})

const tags = computed(() => siteStore.tags.map((t) => t.tag).sort((a, b) => a.localeCompare(b)))

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
      syncTags()
      // -> `HeaderSearch.vue` carries its pending mode here, so a semantic search started from the
      //    header lands already in Semantic mode. A stray `mode=semantic` is not honoured where the
      //    feature is unavailable, and no `mode` param at all (e.g. `syncTags`'s own
      //    `router.replace` round trip) leaves whatever mode was already selected untouched.
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

watch(
  () => state.params,
  debounce(() => performSearch(), 500),
  { deep: true }
)

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

function syncTags(newSelection) {
  const queryTags = extractTags(siteStore.search)
  if (!newSelection) {
    state.selectedTags = queryTags
  } else {
    let newQuery = siteStore.search
    for (const tag of newSelection) {
      if (!newQuery.includes(`#${tag}`)) {
        newQuery = `${newQuery} #${tag}`
      }
    }
    for (const tag of difference(queryTags, newSelection)) {
      newQuery = newQuery.replaceAll(`#${tag}`, '')
    }
    newQuery = newQuery.replaceAll('  ', ' ').trim()
    router.replace({ path: '/_search', query: { q: newQuery } })
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
      searchParams: { ...searchParams, offset, limit: RESULTS_LIMIT }
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

/**
 * Unlike the keyword path this sends the reader's query text through untouched -- a semantic query
 * has no `#tag` filter meaning to extract from it -- so the tag filter reads the sidebar's own
 * `state.selectedTags` rather than tags parsed out of the query. No `orderBy` is sent either:
 * results stay implicitly ordered by similarity.
 */
function performSemanticSearch(append) {
  const q = (siteStore.search ?? '').trim().replaceAll(/\s\s+/g, ' ')

  if (!q) {
    resetResults()
    return undefined
  }

  const filters = {
    ...(state.params.filterPath ? { path: state.params.filterPath } : {}),
    ...(state.selectedTags.length > 0 ? { tags: state.selectedTags.join(',') } : {}),
    ...(state.params.filterLocale.length > 0
      ? { locales: state.params.filterLocale.join(',') }
      : {}),
    ...(state.params.filterEditor ? { editor: state.params.filterEditor } : {}),
    ...(state.params.filterPublishState ? { publishState: state.params.filterPublishState } : {})
  }

  return runSearchRequest(
    `sites/${siteStore.id}/pages/search/semantic`,
    {
      query: q,
      ...filters
    },
    append
  )
}

/** `append` is `loadMore()`'s alone: every other caller starts over at offset 0. */
async function performSearch(append = false) {
  if (isSemanticMode.value) {
    return performSemanticSearch(append)
  }

  let q = siteStore.search ?? ''

  const queryTags = extractTags(q)
  for (const tag of queryTags) {
    q = q.replaceAll(`#${tag}`, '')
  }
  q = q.trim().replaceAll(/\s\s+/g, ' ')

  const filters = {
    ...(state.params.filterPath ? { path: state.params.filterPath } : {}),
    ...(queryTags.length > 0 ? { tags: queryTags.join(',') } : {}),
    ...(state.params.filterLocale.length > 0
      ? { locales: state.params.filterLocale.join(',') }
      : {}),
    ...(state.params.filterEditor ? { editor: state.params.filterEditor } : {}),
    ...(state.params.filterPublishState ? { publishState: state.params.filterPublishState } : {})
  }

  // -> Asking the server with nothing to go on answers with the most recently updated pages, which
  //    is not what an empty search box means
  if (!q && Object.keys(filters).length < 1) {
    resetResults()
    return undefined
  }

  return runSearchRequest(
    `sites/${siteStore.id}/pages/search`,
    {
      ...(q ? { query: q } : {}),
      ...filters,
      orderBy: state.params.orderBy,
      orderByDirection: state.params.orderByDirection
    },
    append
  )
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
  // -> Listing tags needs a session. A reader without one still gets to search — they just filter
  //    by typing `#tag` instead of picking from the (then empty) dropdown
  if (userStore.authenticated) {
    try {
      await siteStore.fetchTags()
    } catch (err) {
      log.warn('search', 'could not load the tag filter list', err)
    }
  }
})

onUnmounted(() => {
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
