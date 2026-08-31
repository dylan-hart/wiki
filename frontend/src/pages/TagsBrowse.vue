<template>
  <w-page padding class="tags-browse">
    <div class="w-section-header">{{ t('tags.title') }}</div>

    <div class="tags-browse-body">
      <div class="tags-browse-sidebar">
        <template v-if="state.selectedTags.length > 0">
          <div class="tags-browse-subheader flex items-center justify-between">
            <span>{{ t('tags.currentSelection') }}</span>
            <w-btn flat dense no-caps :label="t('tags.clearSelection')" @click="clearSelection" />
          </div>
          <div class="flex flex-wrap items-center gap-1 p-2">
            <w-chip
              v-for="tag of state.selectedTags"
              :key="`selected-${tag}`"
              square
              color="primary"
              text-color="white"
              dense
              removable
              @remove="toggleTag(tag)">
              <w-icon class="mr-1" name="la:hashtag" size="14px" />
              <span class="text-caption">{{ tag }}</span>
            </w-chip>
          </div>
        </template>

        <div class="tags-browse-subheader">{{ t('editor.props.tags') }}</div>
        <div class="flex flex-wrap items-center gap-1 p-2">
          <w-chip
            v-for="entry of availableTags"
            :key="`available-${entry.tag}`"
            square
            color="secondary"
            text-color="white"
            dense
            clickable
            @click="toggleTag(entry.tag)">
            <w-icon class="mr-1" name="la:hashtag" size="14px" />
            <span class="text-caption">{{ entry.tag }} ({{ entry.usageCount }})</span>
          </w-chip>
          <span
            v-if="availableTags.length < 1 && state.loadingTags < 1"
            class="text-caption text-grey p-2">
            {{ t('tags.selectOneMoreTagsHint') }}
          </span>
        </div>

        <div class="tags-browse-subheader">{{ t('tags.locale') }}</div>
        <div class="p-2">
          <w-select
            outlined
            dense
            options-dense
            emit-value
            map-options
            :aria-label="t(`tags.locale`)"
            :model-value="state.filterLocale"
            :options="localeOptions"
            @update:model-value="setLocale">
            <template #prepend><w-icon name="la:language" size="xs" /></template>
          </w-select>
        </div>

        <div class="tags-browse-subheader">{{ t('tags.orderBy') }}</div>
        <div class="p-2">
          <w-select
            outlined
            dense
            options-dense
            emit-value
            map-options
            :aria-label="t(`tags.orderBy`)"
            v-model="state.orderBy"
            :options="orderByOptions">
            <template #prepend><w-icon name="la:sort-amount-down" size="xs" /></template>
          </w-select>
        </div>
      </div>

      <div class="tags-browse-results">
        <div
          class="tags-browse-subheader flex items-center justify-between"
          v-if="state.selectedTags.length > 0">
          <span>{{ t('search.results') }}</span>
          <i18n-t
            class="text-caption"
            v-if="state.loading < 1"
            keypath="search.totalResults"
            tag="span"
            :plural="state.total">
            <strong>{{ state.total }}</strong>
          </i18n-t>
        </div>
        <div class="p-2">
          <w-input
            outlined
            dense
            clearable
            v-model="state.filterQuery"
            :placeholder="t(`tags.searchWithinResultsPlaceholder`)"
            :disable="state.selectedTags.length < 1">
            <template #prepend><w-icon name="la:search" size="xs" /></template>
          </w-input>
        </div>

        <div class="p-4" v-if="state.selectedTags.length < 1">
          <div class="text-subtitle1">{{ t('tags.selectOneMoreTags') }}</div>
          <div class="text-caption text-grey">{{ t('tags.selectOneMoreTagsHint') }}</div>
        </div>
        <div class="p-4" v-else-if="state.loading > 0">
          <em>{{ t('tags.retrievingResultsLoading') }}</em>
        </div>
        <div class="p-4" v-else-if="state.results.length < 1">
          <em>{{ hasResultFilters ? t('tags.noResultsWithFilter') : t('tags.noResults') }}</em>
        </div>
        <w-list v-else separator>
          <w-item
            v-for="item of state.results"
            :key="item.id"
            clickable
            :to="localizedPagePath(item.path, item.locale, siteStore.localeRouting)">
            <w-item-section avatar>
              <w-avatar color="primary" text-color="white" rounded>
                <w-icon :name="item.icon || defaultPageIcon" size="24px" />
              </w-avatar>
            </w-item-section>
            <w-item-section>
              <w-item-label>{{ item.title }}</w-item-label>
              <w-item-label v-if="item.description" caption>{{ item.description }}</w-item-label>
              <w-item-label class="text-grey" caption>/{{ item.path }}</w-item-label>
              <w-item-label caption>{{
                t('tags.pageLastUpdated', { date: humanizeDate(t, item.updatedAt) })
              }}</w-item-label>
            </w-item-section>
            <w-item-section side>
              <div class="flex flex-wrap items-center justify-end gap-1">
                <w-chip
                  v-for="tag of item.tags"
                  :key="`${item.id}-${tag}`"
                  square
                  color="secondary"
                  text-color="white"
                  icon="la:hashtag"
                  size="sm"
                  >{{ tag }}</w-chip
                >
              </div>
            </w-item-section>
          </w-item>
        </w-list>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { computed, onMounted, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import { debounce } from 'es-toolkit/function'

import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'

import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { localizedPagePath } from '@/helpers/pagePaths'

import { DEFAULT_PAGE_ICON } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

/** How many results one browse returns. The API caps this at 100, and there is no pager yet. */
const RESULTS_LIMIT = 100

// ROUTER

const route = useRoute()
const router = useRouter()

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// META

useMeta(() => {
  const siteTitle = siteStore.title
  return {
    title: t('tags.title'),
    titleTemplate: (title) => `${title} - ${siteTitle}`
  }
})

// DATA

const state = reactive({
  loadingTags: 0,
  loading: 0,
  /**
   * The one piece of this screen's state that lives in the URL -- everything a tag chip in
   * `PageTags.vue` or a shared link needs to reopen the same intersection. `filterLocale`,
   * `filterQuery` and `orderBy` stay local: refining an already-open browse, not something worth a
   * history entry or a link of its own.
   */
  selectedTags: [],
  filterLocale: '',
  filterQuery: '',
  orderBy: 'title',
  results: [],
  total: 0
})

const defaultPageIcon = DEFAULT_PAGE_ICON

const availableTags = computed(() =>
  siteStore.tags.filter((entry) => !state.selectedTags.includes(entry.tag))
)

const localeOptions = computed(() => [
  { label: t('tags.localeAny'), value: '' },
  ...siteStore.locales.active.map((l) => ({ label: l.name, value: l.code }))
])

const orderByOptions = computed(() => [
  { label: t('tags.orderByField.title'), value: 'title' },
  { label: t('tags.orderByField.lastModified'), value: 'updatedAt' }
])

const hasResultFilters = computed(() => Boolean(state.filterQuery || state.filterLocale))

/*
 * `title` reads naturally A-Z; every other field (currently just `updatedAt`) reads naturally
 * newest-first, same per-field default `Search.vue` uses for its own order-by. There is no
 * direction toggle here -- unlike `Search.vue`, this screen has no control for it -- so getting the
 * one direction each field gets is what stands between "Last Modified" and always showing the
 * oldest-updated page first.
 */
const orderByDirection = computed(() => (state.orderBy === 'title' ? 'asc' : 'desc'))

// WATCHERS

/*
 * The URL is the source of truth for WHICH tags are selected, same shape `Search.vue` uses for its
 * own `q` -- a route change (a `PageTags.vue` chip, the back button, a pasted link) is what drives
 * `state.selectedTags` here, never the other way around. Toggling a tag pushes a new route instead of
 * writing `state.selectedTags` directly, and this watcher is what turns that back into a fetch.
 */
watch(
  () => route.query.tags,
  (newValue) => {
    state.selectedTags = splitTags(newValue)
    performSearch()
  },
  { immediate: true }
)

watch(() => [state.filterLocale, state.filterQuery, state.orderBy], debounce(performSearch, 400))

// METHODS

function splitTags(raw) {
  return (raw ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

/**
 * Adds or removes one tag from the selection, AND-narrowing what is shown -- see the spec decision
 * this feature shipped under (OpenProject #987): selecting more tags only ever narrows the results.
 *
 * A push, not a replace: each tag toggled is a deliberate step through the facets, and the back
 * button retracing them is the expected way to back out of a browse -- unlike `Search.vue`'s `q`,
 * which replaces on every keystroke so typing doesn't spam history.
 */
function toggleTag(tag) {
  const next = state.selectedTags.includes(tag)
    ? state.selectedTags.filter((t) => t !== tag)
    : [...state.selectedTags, tag]
  router.push({ path: '/_tags', query: next.length > 0 ? { tags: next.join(',') } : {} })
}

function clearSelection() {
  router.push({ path: '/_tags', query: {} })
}

function setLocale(value) {
  state.filterLocale = value ?? ''
}

async function performSearch() {
  if (state.selectedTags.length < 1) {
    state.results = []
    state.total = 0
    return
  }
  state.loading++
  try {
    const resp = await API_CLIENT.get(`sites/${siteStore.id}/pages/search`, {
      searchParams: {
        tags: state.selectedTags.join(','),
        ...(state.filterQuery ? { query: state.filterQuery } : {}),
        ...(state.filterLocale ? { locales: state.filterLocale } : {}),
        orderBy: state.orderBy,
        orderByDirection: orderByDirection.value,
        limit: RESULTS_LIMIT
      }
    }).json()
    state.results = (resp?.results ?? []).map((r) => ({ ...r, tags: [...(r.tags ?? [])].sort() }))
    state.total = resp?.totalHits ?? 0
  } catch (err) {
    state.results = []
    state.total = 0
    notify({
      type: 'negative',
      message: t('search.failed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.loading--
  }
}

// MOUNTED

onMounted(async () => {
  state.loadingTags++
  try {
    // -> Force a refresh rather than reusing whatever siteStore.tags already held: a tag created (or
    //    just applied) elsewhere in this session leaves the store's cache stale, and this screen's
    //    whole purpose is showing the current tag list to browse by (OpenProject #1121).
    await siteStore.fetchTags(true)
  } catch (err) {
    notify({
      type: 'warning',
      message: t('editor.props.tagsFailed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.loadingTags--
  }
})
</script>

<style lang="scss">
.tags-browse {
  &-body {
    display: flex;
    align-items: flex-start;
    gap: 1.5rem;
  }

  &-sidebar {
    flex: 0 0 280px;
  }

  &-results {
    flex: 1 1 auto;
    min-width: 0;
  }

  &-subheader {
    padding: 0.5rem 0.5rem 0;
    font-weight: 500;
    color: $primary;

    @at-root .body--dark & {
      color: var(--color-primary-light);
    }
  }

  @media (max-width: $breakpoint-sm-max) {
    &-body {
      flex-direction: column;
    }

    &-sidebar {
      flex: none;
      width: 100%;
    }
  }
}
</style>
