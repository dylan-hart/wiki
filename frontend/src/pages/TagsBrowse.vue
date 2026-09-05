<template>
  <w-page padding class="tags-browse">
    <div class="w-section-header">{{ t('tags.title') }}</div>

    <div class="tags-browse-body">
      <div class="tags-browse-sidebar">
        <template v-if="state.selectedTags.length > 0">
          <div class="tags-browse-subheader flex items-center justify-between">
            <span>{{ t('tags.currentSelection') }}</span>
            <w-btn flat dense :label="t('tags.clearSelection')" @click="clearSelection" />
          </div>
          <div class="flex flex-wrap items-center gap-1 p-2">
            <w-chip
              v-for="tag of state.selectedTags"
              :key="`selected-${tag}`"
              color="primary"
              text-color="white"
              dense
              removable
              @remove="toggleTag(tag)">
              <w-icon class="me-1" name="tabler:hash" size="14px" />
              <span class="text-caption">{{ tag }}</span>
            </w-chip>
          </div>
        </template>

        <div class="tags-browse-subheader flex items-center justify-between">
          <span>{{ state.managementMode ? t('tags.manageTags') : t('editor.props.tags') }}</span>
          <w-btn
            v-if="canManageTags"
            flat
            dense
            round
            :icon="state.managementMode ? 'tabler:x' : 'tabler:settings'"
            :aria-label="state.managementMode ? t('common.actions.exit') : t('tags.manageTags')"
            @click="toggleManagementMode" />
        </div>

        <div v-if="state.managementMode" class="flex flex-col gap-1 p-2">
          <div
            v-for="entry of siteStore.tags"
            :key="`manage-${entry.tag}`"
            class="tag-manage-row flex items-center gap-1">
            <template v-if="state.renamingTag === entry.tag">
              <w-input
                ref="iptRename"
                dense
                class="flex-1"
                v-model="state.renameValue"
                :aria-label="t('tags.renameTagLabel')"
                @keyup:enter="confirmRename(entry)" />
              <w-btn
                flat
                dense
                round
                icon="tabler:check"
                :aria-label="t('common.actions.confirm')"
                @click="confirmRename(entry)" />
              <w-btn
                flat
                dense
                round
                icon="tabler:x"
                :aria-label="t('common.actions.cancel')"
                @click="cancelRename" />
            </template>
            <template v-else>
              <span class="flex flex-1 items-center text-caption">
                <w-icon class="me-1" name="tabler:hash" size="14px" />
                {{ entry.tag }} ({{ entry.usageCount }})
              </span>
              <w-btn
                flat
                dense
                round
                icon="tabler:edit"
                :aria-label="t('common.actions.rename')"
                @click="startRename(entry)" />
              <w-btn
                flat
                dense
                round
                icon="tabler:trash"
                color="negative"
                :aria-label="t('common.actions.delete')"
                @click="deleteTag(entry)" />
            </template>
          </div>
          <span
            v-if="siteStore.tags.length < 1 && state.loadingTags < 1"
            class="text-caption text-grey p-2">
            {{ t('tags.selectOneMoreTagsHint') }}
          </span>
        </div>
        <div v-else class="flex flex-wrap items-center gap-1 p-2">
          <w-chip
            v-for="entry of availableTags"
            :key="`available-${entry.tag}`"
            color="slate"
            text-color="white"
            dense
            clickable
            @click="toggleTag(entry.tag)">
            <w-icon class="me-1" name="tabler:hash" size="14px" />
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
            dense
            options-dense
            emit-value
            map-options
            :aria-label="t(`tags.locale`)"
            :model-value="state.filterLocale"
            :options="localeOptions"
            @update:model-value="setLocale">
            <template #prepend><w-icon name="tabler:language" size="xs" /></template>
          </w-select>
        </div>

        <div class="tags-browse-subheader">{{ t('tags.orderBy') }}</div>
        <div class="p-2">
          <w-select
            dense
            options-dense
            emit-value
            map-options
            :aria-label="t(`tags.orderBy`)"
            v-model="state.orderBy"
            :options="orderByOptions">
            <template #prepend><w-icon name="tabler:sort-descending" size="xs" /></template>
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
            dense
            clearable
            v-model="state.filterQuery"
            :placeholder="t(`tags.searchWithinResultsPlaceholder`)"
            :disabled="state.selectedTags.length < 1">
            <template #prepend><w-icon name="tabler:search" size="xs" /></template>
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
                  color="slate"
                  text-color="white"
                  icon="tabler:hash"
                  size="sm"
                  >{{ tag }}</w-chip
                >
              </div>
            </w-item-section>
          </w-item>
        </w-list>
        <div
          class="flex justify-center p-4"
          v-if="state.results.length > 0 && state.results.length < state.total">
          <w-btn
            flat
            color="primary"
            :label="t('search.loadMore')"
            :loading="state.loading > 0"
            @click="loadMore" />
        </div>
      </div>
    </div>
  </w-page>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import { debounce } from 'es-toolkit/function'

import { confirm } from '@/composables/dialog'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'

import { apiErrorMessage } from '@/helpers/apiError'
import { humanizeDate } from '@/helpers/datetime'
import { localizedPagePath } from '@/helpers/pagePaths'

import { DEFAULT_PAGE_ICON } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/** How many results one page of a browse holds. The API caps a single request at 100. */
const RESULTS_LIMIT = 100

// ROUTER

const route = useRoute()
const router = useRouter()

// STORES

const siteStore = useSiteStore()
const userStore = useUserStore()

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
  total: 0,
  offset: 0,
  // -> Tag management (OpenProject #1877): mutating a tag is a page-rule-permission action, so it is
  //    off by default and hidden entirely from anyone without `manage:pages` -- see `canManageTags`.
  managementMode: false,
  renamingTag: null,
  renameValue: '',
  mutatingTags: 0
})

const defaultPageIcon = DEFAULT_PAGE_ICON
const iptRename = ref(null)

const availableTags = computed(() =>
  siteStore.tags.filter((entry) => !state.selectedTags.includes(entry.tag))
)

/*
 * A page-rule permission cannot be checked with `userStore.can()` (the global-permission list) --
 * `pagePermissions` is what the session holds for the CURRENT route path, which is what the
 * PATCH/DELETE endpoint behind this control actually checks too (per affected page, server-side).
 * This is a visibility gate only: a reader who fails it never sees the controls at all, but the real
 * enforcement -- and which of the tag's pages actually get touched -- happens per page on the server.
 */
const canManageTags = computed(() => userStore.pagePermissions.includes('manage:pages'))

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

/**
 * Runs a search. `append` distinguishes the two callers: a fresh search (a tag toggled, the query,
 * locale or order changed) starts over at offset 0 and replaces `state.results`, while `loadMore()`
 * asks for the next page at the current offset and appends onto what is already shown.
 */
async function performSearch(append = false) {
  if (state.selectedTags.length < 1) {
    state.results = []
    state.total = 0
    state.offset = 0
    return
  }
  const offset = append ? state.offset : 0
  state.loading++
  try {
    const resp = await API_CLIENT.get(`sites/${siteStore.id}/pages/search`, {
      searchParams: {
        tags: state.selectedTags.join(','),
        ...(state.filterQuery ? { query: state.filterQuery } : {}),
        ...(state.filterLocale ? { locales: state.filterLocale } : {}),
        orderBy: state.orderBy,
        orderByDirection: orderByDirection.value,
        offset,
        limit: RESULTS_LIMIT
      }
    }).json()
    const results = (resp?.results ?? []).map((r) => ({ ...r, tags: [...(r.tags ?? [])].sort() }))
    state.results = append ? [...state.results, ...results] : results
    state.total = resp?.totalHits ?? 0
    state.offset = offset + results.length
  } catch (err) {
    if (!append) {
      state.results = []
      state.total = 0
      state.offset = 0
    }
    notify({
      type: 'negative',
      message: t('search.failed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.loading--
  }
}

function loadMore() {
  return performSearch(true)
}

/**
 * Toggles the management mode sidebar view. Never called unless `canManageTags` already gated the
 * button that triggers it, so no permission check happens here.
 */
function toggleManagementMode() {
  state.managementMode = !state.managementMode
  cancelRename()
}

function startRename(entry) {
  state.renamingTag = entry.tag
  state.renameValue = entry.tag
  nextTick(() => iptRename.value?.[0]?.focus?.())
}

function cancelRename() {
  state.renamingTag = null
  state.renameValue = ''
}

/**
 * Confirms and performs a rename -- renaming onto a value that is already another tag's name IS the
 * merge (OpenProject #1868/#1873): same route, same handler, distinguished only by which title/message
 * the confirmation shows.
 */
function confirmRename(entry) {
  const newTag = state.renameValue.trim()
  if (!newTag || newTag === entry.tag) {
    cancelRename()
    return
  }
  const merging = siteStore.tags.some((t) => t.tag === newTag)
  confirm({
    title: merging ? t('tags.mergeTagTitle') : t('tags.renameTagTitle'),
    message: merging
      ? t('tags.mergeTagConfirm', { from: entry.tag, to: newTag, count: entry.usageCount })
      : t('tags.renameTagConfirm', { from: entry.tag, to: newTag, count: entry.usageCount }),
    caption: t('tags.manageUnauthorizedCaption'),
    cancel: true,
    color: 'primary',
    okLabel: t('common.actions.rename')
  }).onOk(() => performRename(entry.tag, newTag))
}

async function performRename(oldTag, newTag) {
  state.mutatingTags++
  try {
    const resp = await API_CLIENT.patch(
      `sites/${siteStore.id}/tags/${encodeURIComponent(oldTag)}`,
      {
        json: { newTag }
      }
    ).json()
    notify({
      type: 'positive',
      message: t('tags.renameTagSuccess', { count: resp?.affected ?? 0 })
    })
    cancelRename()
    await refreshAfterMutation()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('tags.renameTagFailed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.mutatingTags--
  }
}

function deleteTag(entry) {
  confirm({
    title: t('tags.deleteTagTitle'),
    message: t('tags.deleteTagConfirm', { tag: entry.tag, count: entry.usageCount }),
    caption: t('tags.manageUnauthorizedCaption'),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.delete')
  }).onOk(() => performDelete(entry.tag))
}

async function performDelete(tagValue) {
  state.mutatingTags++
  try {
    const resp = await API_CLIENT.delete(
      `sites/${siteStore.id}/tags/${encodeURIComponent(tagValue)}`
    ).json()
    notify({
      type: 'positive',
      message: t('tags.deleteTagSuccess', { count: resp?.affected ?? 0 })
    })
    await refreshAfterMutation()
  } catch (err) {
    notify({
      type: 'negative',
      message: t('tags.deleteTagFailed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.mutatingTags--
  }
}

/** Refreshes the tag list and re-runs the current search, so a rename/delete is visible at once. */
async function refreshAfterMutation() {
  await siteStore.fetchTags(true)
  state.selectedTags = state.selectedTags.filter((tag) =>
    siteStore.tags.some((entry) => entry.tag === tag)
  )
  await performSearch()
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
