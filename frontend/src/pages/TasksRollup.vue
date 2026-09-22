<template>
  <w-page class="tasks-rollup">
    <div class="w-section-header">{{ t('tasks.title') }}</div>

    <div class="tasks-rollup-body">
      <div class="tasks-rollup-filters">
        <div class="tasks-rollup-subheader flex items-center justify-between">
          <span>{{ t('tasks.tags') }}</span>
          <w-btn
            v-if="hasFilters"
            flat
            dense
            size="12px"
            padding="none"
            text-color="text-secondary"
            :label="t('tasks.clearFilters')"
            @click="clearFilters" />
        </div>
        <div class="tasks-rollup-chips flex flex-wrap items-center gap-[5px] p-2">
          <w-chip
            v-for="entry of siteStore.tags"
            :key="`tag-${entry.tag}`"
            :color="state.tags.includes(entry.tag) ? 'accent' : 'slate'"
            text-color="white"
            size="11.5px"
            clickable
            :data-selected="state.tags.includes(entry.tag) ? 'true' : 'false'"
            @click="toggleTag(entry.tag)">
            <span class="tasks-rollup-hash" aria-hidden="true">#</span>{{ entry.tag }}
          </w-chip>
          <span v-if="siteStore.tags.length < 1" class="text-caption text-grey p-2">
            {{ t('tasks.noTags') }}
          </span>
        </div>

        <div class="tasks-rollup-subheader">{{ t('tasks.folder') }}</div>
        <div class="p-2">
          <w-input
            clearable
            v-model="state.folder"
            :aria-label="t('tasks.folder')"
            :placeholder="t('tasks.folderPlaceholder')">
            <template #prepend><w-icon name="tabler:folder" size="14px" /></template>
          </w-input>
        </div>
      </div>

      <div class="tasks-rollup-results">
        <div
          v-if="state.loaded && state.results.length > 0"
          class="tasks-rollup-subheader tasks-rollup-summary text-caption">
          {{ t('tasks.summary', { items: state.totalItems, pages: state.totalHits }) }}
        </div>

        <div class="p-4" v-if="state.loading > 0 && state.results.length < 1">
          <em>{{ t('tasks.loading') }}</em>
        </div>
        <div class="p-4 tasks-rollup-empty" v-else-if="state.loaded && state.results.length < 1">
          <em>{{ hasFilters ? t('tasks.emptyFiltered') : t('tasks.empty') }}</em>
        </div>
        <div v-else class="tasks-rollup-list">
          <section
            v-for="page of state.results"
            :key="page.pageId"
            class="tasks-rollup-group"
            :data-page-id="page.pageId">
            <div class="tasks-rollup-group-head">
              <router-link
                class="tasks-rollup-page-link"
                :to="localizedPagePath(page.path, page.locale, siteStore.localeRouting)">
                {{ page.title }}
              </router-link>
              <span class="tasks-rollup-page-path">/{{ page.path }}</span>
              <span class="tasks-rollup-page-count text-caption">
                {{ t('tasks.pageItemCount', { count: page.items.length }) }}
              </span>
            </div>
            <ul class="tasks-rollup-items">
              <li v-for="item of page.items" :key="`${page.pageId}-${item.index}`">
                <w-icon name="tabler:square" size="16px" />
                <span class="tasks-rollup-item-text">{{ item.text }}</span>
              </li>
            </ul>
          </section>
        </div>

        <div
          class="tasks-rollup-more flex justify-center"
          v-if="state.results.length > 0 && state.results.length < state.totalHits">
          <w-btn
            outline
            color="primary"
            padding="none md"
            class="bg-surface dark:bg-dark-3"
            :label="t('search.loadMore')"
            :loading="state.loading > 0"
            @click="loadMore" />
        </div>
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
import { localizedPagePath } from '@/helpers/pagePaths'

import { useSiteStore } from '@/stores/site'

const PAGE_SIZE = 50

const route = useRoute()
const router = useRouter()

const siteStore = useSiteStore()

const { t } = useI18n()

useMeta(() => {
  const siteTitle = siteStore.title
  return {
    title: t('tasks.title'),
    titleTemplate: (title) => `${title} - ${siteTitle}`
  }
})

const state = reactive({
  loading: 0,
  loaded: false,
  tags: [],
  folder: '',
  results: [],
  totalHits: 0,
  totalItems: 0
})

const hasFilters = computed(() => state.tags.length > 0 || Boolean(state.folder))

function splitTags(raw) {
  return (raw ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function filterQuery(tags, folder) {
  const trimmed = (folder ?? '').trim()
  return {
    ...(tags.length > 0 ? { tag: tags.join(',') } : {}),
    ...(trimmed ? { folder: trimmed } : {})
  }
}

watch(
  () => [route.query.tag, route.query.folder],
  ([tag, folder]) => {
    state.tags = splitTags(tag)
    state.folder = folder ?? ''
    fetchTasks()
  },
  { immediate: true }
)

watch(
  () => state.folder,
  debounce((folder) => {
    if ((folder ?? '').trim() === (route.query.folder ?? '')) {
      return
    }
    router.replace({ path: '/_tasks', query: filterQuery(state.tags, folder) })
  }, 400)
)

function toggleTag(tag) {
  const next = state.tags.includes(tag) ? state.tags.filter((t) => t !== tag) : [...state.tags, tag]
  router.push({ path: '/_tasks', query: filterQuery(next, state.folder) })
}

function clearFilters() {
  router.push({ path: '/_tasks', query: {} })
}

async function fetchTasks(append = false) {
  const offset = append ? state.results.length : 0
  const folder = state.folder.trim()
  state.loading++
  try {
    const resp = await API_CLIENT.get(`sites/${siteStore.id}/tasks`, {
      searchParams: {
        ...(state.tags.length > 0 ? { tag: state.tags.join(',') } : {}),
        ...(folder ? { folder } : {}),
        offset,
        limit: PAGE_SIZE
      }
    }).json()
    const results = resp?.results ?? []
    state.results = append ? [...state.results, ...results] : results
    state.totalHits = resp?.totalHits ?? 0
    state.totalItems = resp?.totalItems ?? 0
  } catch (err) {
    if (!append) {
      state.results = []
      state.totalHits = 0
      state.totalItems = 0
    }
    notify({
      type: 'negative',
      message: t('tasks.loadFailed'),
      caption: apiErrorMessage(err)
    })
  } finally {
    state.loaded = true
    state.loading--
  }
}

function loadMore() {
  return fetchTasks(true)
}

onMounted(async () => {
  try {
    await siteStore.fetchTags()
  } catch (err) {
    notify({
      type: 'warning',
      message: t('editor.props.tagsFailed'),
      caption: apiErrorMessage(err)
    })
  }
})
</script>

<style>
.tasks-rollup-body {
  display: flex;
  align-items: flex-start;
  padding: 2px 20px 16px;
  gap: 1.5rem;
  flex-wrap: wrap;
}
.tasks-rollup-filters {
  flex: 0 0 280px;
  min-width: 260px;
}
.tasks-rollup-results {
  flex: 1 1 auto;
  min-width: 320px;
}
.tasks-rollup-subheader {
  padding: 12px 8px 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-accent);
}
.tasks-rollup-subheader:first-child {
  padding-block-start: 8px;
}
.body--dark .tasks-rollup-subheader {
  color: var(--color-accent-dark);
}
.tasks-rollup-summary {
  color: var(--color-text-secondary);
  font-weight: 400;
}
.body--dark .tasks-rollup-summary {
  color: var(--color-text-secondary-dark);
}
.tasks-rollup-hash {
  margin-inline-end: 4px;
  font-family: var(--font-mono);
  font-size: 0.87em;
  font-weight: 500;
}
.tasks-rollup-chips .w-chip {
  gap: 4px;
  padding: 3px 7px;
}
.tasks-rollup-list {
  margin: 8px 8px 0;
  border: 1px solid var(--color-hairline);
  background-color: var(--color-white);
}
.body--dark .tasks-rollup-list {
  border-color: var(--color-hairline-dark);
  background-color: var(--color-dark-3);
}
body.body--cobalt .tasks-rollup-list {
  border: 0;
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}
.tasks-rollup-group {
  padding: 12px 14px;
}
.tasks-rollup-group + .tasks-rollup-group {
  border-block-start: 1px solid var(--color-tint);
}
.body--dark .tasks-rollup-group + .tasks-rollup-group {
  border-block-start-color: var(--color-hairline-dark);
}
.tasks-rollup-group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
}
.tasks-rollup-page-link {
  font-size: 14.5px;
  font-weight: 500;
  color: var(--color-ink);
  text-decoration: none;
}
.tasks-rollup-page-link:hover {
  text-decoration: underline;
}
.body--dark .tasks-rollup-page-link {
  color: var(--color-text-dark);
}
.tasks-rollup-page-path {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--color-text-caption);
}
.body--dark .tasks-rollup-page-path {
  color: var(--color-text-caption-dark);
}
.tasks-rollup-page-count {
  margin-inline-start: auto;
}
.tasks-rollup-items {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.tasks-rollup-items li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 0;
  font-size: 13.5px;
}
.tasks-rollup-items .w-icon {
  flex: none;
  margin-block-start: 2px;
}
.tasks-rollup-item-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.tasks-rollup-more {
  padding: 16px 8px 0;
}
@media (max-width: 1023.98px) {
  .tasks-rollup-body {
    flex-direction: column;
    padding-inline: 16px;
  }
  .tasks-rollup-filters,
  .tasks-rollup-results {
    flex: none;
    width: 100%;
    min-width: 0;
  }
}
</style>
