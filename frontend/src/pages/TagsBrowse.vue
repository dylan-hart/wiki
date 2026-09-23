<template>
  <w-page class="tags-browse">
    <!--
      No `padding` on the page: the section band runs edge to edge across the content column, and
      only the body beneath it (`.tags-browse-body`) is inset.
    -->
    <div class="w-section-header">{{ t('tags.title') }}</div>

    <div class="tags-browse-body">
      <div class="tags-browse-sidebar">
        <template v-if="state.selectedTags.length > 0">
          <div class="tags-browse-subheader flex items-center justify-between">
            <span>{{ t('tags.currentSelection') }}</span>
            <!--
              `padding="none"` keeps the label flush to the column's 8px edge; the dense button's own
              10px of horizontal padding pushes it past every chip below.
            -->
            <w-btn
              flat
              dense
              size="12px"
              padding="none"
              text-color="text-secondary"
              :label="t('tags.clearSelection')"
              @click="clearSelection" />
          </div>
          <div
            class="tags-browse-chips tags-browse-chips--selected flex flex-wrap items-center gap-[5px] p-2">
            <!--
              The `#` is a mono glyph, not a drawn icon, matching the page tag plate (`PageTags.vue`).

              `color="accent"`, not `primary`: white text over a solid fill is the accent role's job.
              The two are numerically equal under Ledger but diverge under Cobalt, where primary is
              the link blue.
            -->
            <w-chip
              v-for="tag of state.selectedTags"
              :key="`selected-${tag}`"
              color="accent"
              text-color="white"
              size="11.5px"
              removable
              @remove="toggleTag(tag)">
              <span class="tags-browse-hash" aria-hidden="true">#</span>{{ tag }}
            </w-chip>
          </div>
          <div
            v-if="state.selectedTags.length > 1"
            class="tags-browse-match flex items-center gap-2 px-2 pb-2">
            <span class="text-caption">{{ t('tags.matchMode') }}</span>
            <w-btn-toggle
              class="tags-browse-match-toggle"
              :model-value="state.tagsMatch"
              :aria-label="t('tags.matchMode')"
              :options="matchOptions"
              @update:model-value="setTagsMatch" />
          </div>
        </template>

        <div class="tags-browse-subheader flex items-center justify-between">
          <span>{{ state.managementMode ? t('tags.manageTags') : t('editor.props.tags') }}</span>
          <!--
            The glyph comes through the slot, not the `icon` prop, so `WIcon`'s own `size` applies:
            the prop route inherits WBtn's 1.715em and draws a 17px glyph in a 24px circle.
          -->
          <w-btn
            v-if="canManageTags"
            flat
            round
            size="10px"
            :aria-label="state.managementMode ? t('common.actions.exit') : t('tags.manageTags')"
            @click="toggleManagementMode">
            <w-icon :name="state.managementMode ? 'tabler:x' : 'tabler:settings'" size="14px" />
          </w-btn>
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
        <div v-else class="tags-browse-chips flex flex-wrap items-center gap-[5px] p-2">
          <w-chip
            v-for="entry of availableTags"
            :key="`available-${entry.tag}`"
            color="slate"
            text-color="white"
            size="11.5px"
            clickable
            @click="toggleTag(entry.tag)">
            <span class="tags-browse-hash" aria-hidden="true">#</span>{{ entry.tag }} ({{
              entry.usageCount
            }})
          </w-chip>
          <span
            v-if="availableTags.length < 1 && state.loadingTags < 1"
            class="text-caption text-grey p-2">
            {{ t('tags.selectOneMoreTagsHint') }}
          </span>
        </div>

        <div class="tags-browse-subheader">{{ t('tags.locale') }}</div>
        <!--
          Not `dense`: the filter fields are the default 34px frame, `dense` being the 28px one
          (`composables/fieldFrame.js`). `options-dense` is unrelated -- it compresses the open menu.
        -->
        <div class="p-2">
          <w-select
            options-dense
            emit-value
            map-options
            :aria-label="t(`tags.locale`)"
            :model-value="state.filterLocale"
            :options="localeOptions"
            @update:model-value="setLocale">
            <template #prepend><w-icon name="tabler:language" size="14px" /></template>
          </w-select>
        </div>

        <div class="tags-browse-subheader">{{ t('tags.orderBy') }}</div>
        <div class="p-2">
          <w-select
            options-dense
            emit-value
            map-options
            :aria-label="t(`tags.orderBy`)"
            v-model="state.orderBy"
            :options="orderByOptions">
            <template #prepend><w-icon name="tabler:sort-descending" size="14px" /></template>
          </w-select>
        </div>

        <div class="tags-browse-subheader">{{ t('tasks.title') }}</div>
        <div class="p-2">
          <w-btn
            class="tags-browse-tasks-link"
            flat
            dense
            no-caps
            icon="tabler:checklist"
            :label="t('tasks.openTasks')"
            to="/_tasks" />
        </div>
      </div>

      <div class="tags-browse-results">
        <div
          class="tags-browse-subheader flex items-center justify-between"
          v-if="state.selectedTags.length > 0">
          <span>{{ t('search.results') }}</span>
          <i18n-t
            class="tags-browse-count text-caption"
            v-if="state.loading < 1"
            keypath="search.totalResults"
            tag="span"
            :plural="state.total">
            <strong>{{ state.total }}</strong>
          </i18n-t>
        </div>
        <div class="p-2">
          <w-input
            clearable
            v-model="state.filterQuery"
            :placeholder="t(`tags.searchWithinResultsPlaceholder`)"
            :disabled="state.selectedTags.length < 1">
            <template #prepend><w-icon name="tabler:search" size="14px" /></template>
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
        <!-- No `separator`: `.tags-browse-plate` draws the row rule itself, in a paler tint. -->
        <div v-else class="tags-browse-plate">
          <w-list>
            <w-item
              v-for="item of state.results"
              :key="item.id"
              clickable
              :to="localizedPagePath(item.path, item.locale, siteStore.localeRouting)">
              <w-item-section avatar top>
                <w-avatar color="primary" text-color="white" square size="36px">
                  <w-icon :name="item.icon || defaultPageIcon" size="20px" />
                </w-avatar>
              </w-item-section>
              <w-item-section>
                <w-item-label class="tags-browse-result-title">{{ item.title }}</w-item-label>
                <w-item-label v-if="item.description" caption class="tags-browse-result-desc">{{
                  item.description
                }}</w-item-label>
                <w-item-label caption class="tags-browse-result-meta"
                  >/{{ item.path }}</w-item-label
                >
                <w-item-label caption class="tags-browse-result-meta">{{
                  t('tags.pageLastUpdated', {
                    date: userStore.formatRecent(t, item.updatedAt) || '---'
                  })
                }}</w-item-label>
              </w-item-section>
              <w-item-section side top>
                <div class="flex flex-wrap items-center justify-end gap-1">
                  <w-chip
                    v-for="tag of item.tags"
                    :key="`${item.id}-${tag}`"
                    color="slate"
                    text-color="white"
                    size="11px"
                    dense>
                    <span class="tags-browse-hash" aria-hidden="true">#</span>{{ tag }}
                  </w-chip>
                </div>
              </w-item-section>
            </w-item>
          </w-list>
        </div>
        <div
          class="tags-browse-more flex justify-center"
          v-if="state.results.length > 0 && state.results.length < state.total">
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
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import { debounce } from 'es-toolkit/function'

import { confirm } from '@/composables/dialog'
import { useMeta } from '@/composables/meta'
import { notify } from '@/composables/notify'

import { apiErrorMessage } from '@/helpers/apiError'
import { localizedPagePath } from '@/helpers/pagePaths'

import { DEFAULT_PAGE_ICON } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/** The API caps a single search request at 100. */
const RESULTS_LIMIT = 100

const route = useRoute()
const router = useRouter()

const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

useMeta(() => {
  const siteTitle = siteStore.title
  return {
    title: t('tags.title'),
    titleTemplate: (title) => `${title} - ${siteTitle}`
  }
})

const state = reactive({
  loadingTags: 0,
  loading: 0,
  /**
   * The only piece of this screen's state kept in the URL, so a `PageTags.vue` chip or a shared
   * link reopens the same intersection. The filters below only refine an already-open browse.
   */
  selectedTags: [],
  tagsMatch: 'all',
  filterLocale: '',
  filterQuery: '',
  orderBy: 'title',
  results: [],
  total: 0,
  offset: 0,
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
 * A page-rule permission is not in `userStore.can()`'s global list: `pagePermissions` is what the
 * session holds for the current route path. Visibility only -- the PATCH/DELETE routes enforce it
 * per affected page, so a tag's unauthorized pages are left alone whatever this says.
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

const matchOptions = computed(() => [
  { label: t('tags.matchAll'), value: 'all' },
  { label: t('tags.matchAny'), value: 'any' }
])

const hasResultFilters = computed(() => Boolean(state.filterQuery || state.filterLocale))

/*
 * `title` reads A-Z, every other field newest-first, the same per-field default `Search.vue` uses.
 * This screen has no direction control, so the field's default is the only direction it ever gets.
 */
const orderByDirection = computed(() => (state.orderBy === 'title' ? 'asc' : 'desc'))

/*
 * The URL is the source of truth for the selection: toggling a tag pushes a route rather than
 * writing `state.selectedTags`, and this watcher is what turns a route change back into a fetch.
 */
watch(
  () => [route.query.tags, route.query.tagsMatch],
  ([newTags, newMatch]) => {
    state.selectedTags = splitTags(newTags)
    state.tagsMatch = newMatch === 'any' ? 'any' : 'all'
    performSearch()
  },
  { immediate: true }
)

watch(() => [state.filterLocale, state.filterQuery, state.orderBy], debounce(performSearch, 400))

function splitTags(raw) {
  return (raw ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function tagsQuery(tags, match) {
  return {
    ...(tags.length > 0 ? { tags: tags.join(',') } : {}),
    ...(tags.length > 0 && match === 'any' ? { tagsMatch: 'any' } : {})
  }
}

/**
 * Selected tags are ANDed server-side unless `state.tagsMatch` is `any`, where each one widens the
 * results instead.
 *
 * A push, not a replace: each toggle is a deliberate step through the facets and the back button
 * retracing them is how a reader backs out of a browse -- unlike `Search.vue`'s `q`, which replaces
 * on every keystroke so typing doesn't spam history.
 */
function toggleTag(tag) {
  const next = state.selectedTags.includes(tag)
    ? state.selectedTags.filter((t) => t !== tag)
    : [...state.selectedTags, tag]
  router.push({ path: '/_tags', query: tagsQuery(next, state.tagsMatch) })
}

function setTagsMatch(value) {
  router.push({ path: '/_tags', query: tagsQuery(state.selectedTags, value) })
}

function clearSelection() {
  router.push({ path: '/_tags', query: {} })
}

function setLocale(value) {
  state.filterLocale = value ?? ''
}

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
        tagsMatch: state.tagsMatch,
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

/** No permission check here: `canManageTags` gates the only control that calls it. */
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
 * Renaming onto a name another tag already holds IS the merge: same route and handler, differing
 * only in which title and message the confirmation shows.
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

async function refreshAfterMutation() {
  await siteStore.fetchTags(true)
  state.selectedTags = state.selectedTags.filter((tag) =>
    siteStore.tags.some((entry) => entry.tag === tag)
  )
  await performSearch()
}

onMounted(async () => {
  state.loadingTags++
  try {
    // -> Forced refresh: a tag created or applied elsewhere in this session leaves
    //    `siteStore.tags` stale, and browsing the current tag list is this screen's whole purpose.
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

<style>
/*
  Metrics below are `ui-redesign/Cardinal Wiki - Tags 3x.dc.html`'s own, which is where the
  arbitrary-looking numbers come from.

  Deliberately NOT scoped: several rules reach shared components the page mounts (`WChip`'s padding,
  `WItem`'s row metrics, `WItemLabel`'s caption tone), which a scoped block cannot. An SFC style
  block is emitted unlayered, so a plain class here still beats those components' Tailwind utilities
  without `!important`.
*/
.tags-browse {
  /* No inset of its own: `.tags-browse-body` pads, so the band above stays full-bleed. */
}
.tags-browse-body {
  display: flex;
  align-items: flex-start;
  /*
    The design pads this body `16px 20px`; `.w-section-header` above already contributes the shared
    section rhythm's 14px `margin-block-end`, so 2px here lands the first row on that 16px. The
    band's own height doesn't enter into it.
  */
  padding: 2px 20px 16px;
  gap: 1.5rem;
  /* Wrap rather than squeeze: 280 + 24 + 320 is where the two columns stack. */
  flex-wrap: wrap;
}
.tags-browse-sidebar {
  flex: 0 0 280px;
  min-width: 260px;
}
.tags-browse-results {
  flex: 1 1 auto;
  min-width: 320px;
}
.tags-browse-subheader {
  padding: 12px 8px 0;
  font-size: 13px;
  font-weight: 500;
  /*
    The accent role, not primary: the two are numerically identical under Ledger, but under Cobalt
    primary is the link blue while these subheaders are the accent red.
  */
  color: var(--color-accent);
}
.tags-browse-subheader:first-child {
  padding-block-start: 8px;
}
.tags-browse-subheader {
  /*
    The dark counterpart below is `--color-accent-dark`, the token for accent text on a dark ground,
    not a lightened primary -- which would be the wrong hue under Cobalt.
  */
}
.body--dark .tags-browse-subheader {
  color: var(--color-accent-dark);
}
.tags-browse {
  /*
    The `#` ahead of a chip's label is sized in `em` so one rule serves both the 11.5px sidebar chip
    and the 11px result-row chip.
  */
}
.tags-browse-hash {
  margin-inline-end: 4px;
  font-family: var(--font-mono);
  font-size: 0.87em;
  font-weight: 500;
}
.tags-browse {
  /* The sidebar chip box below is the design's own -- neither WChip's dense nor its default box. */
}
.tags-browse-chips .w-chip {
  gap: 4px;
  padding: 3px 7px;
}
.tags-browse {
  /*
    Selected chips carry their own modifier class because `.tags-browse-chips` is shared with the
    available-tags block, which stays a flat fill.
  */
}
.tags-browse-count {
  color: var(--color-text-secondary);
}
.tags-browse-count strong {
  color: var(--color-ink);
  font-weight: 700;
}
.body--dark .tags-browse-count {
  color: var(--color-text-secondary-dark);
}
.body--dark .tags-browse-count strong {
  color: var(--color-text-dark);
}
.tags-browse-plate {
  margin: 8px 8px 0;
  border: 1px solid var(--color-hairline);
  background-color: var(--color-white);
}
.body--dark .tags-browse-plate {
  border-color: var(--color-hairline-dark);
  background-color: var(--color-dark-3);
}
.tags-browse-plate {
  /*
    Cobalt draws this plate's edge through `--shadow-card` alone rather than the border above;
    `--radius-card`/`--shadow-card` are `0`/`none` under Ledger, leaving that border its only edge.
  */
}
body.body--cobalt .tags-browse-plate {
  border: 0;
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
}
.tags-browse-plate .w-chip {
  gap: 3px;
}
.tags-browse-result-title {
  font-size: 14.5px;
  font-weight: 500;
  color: var(--color-ink);
}
.body--dark .tags-browse-result-title {
  color: var(--color-text-dark);
}
.tags-browse-result-desc {
  font-size: 12.5px;
  color: var(--color-text-secondary);
}
.body--dark .tags-browse-result-desc {
  color: var(--color-text-secondary-dark);
}
.tags-browse-result-meta {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--color-text-caption);
}
.body--dark .tags-browse-result-meta {
  color: var(--color-text-caption-dark);
}
.tags-browse-more {
  padding: 16px 8px 0;
}
@media (max-width: 1023.98px) {
  .tags-browse-body {
    flex-direction: column;
    padding-inline: 16px;
  }
  .tags-browse-sidebar,
  .tags-browse-results {
    flex: none;
    width: 100%;
    min-width: 0;
  }
}

/*
  `--shadow-primary` is `none` under every aesthetic today, so this rule draws nothing; it is the
  wiring a glow would re-enter through. A `WChip` cannot pick the token up through `WBtn`'s
  `color="accent"` plumbing, so it is a hand-wired consumer of the same accent role.

  Not nested under `.tags-browse`: this selector does not descend from it.
*/
body.body--cobalt .tags-browse-chips--selected .w-chip {
  box-shadow: var(--shadow-primary);
}

/*
  This band has to sit on the same line as `.sidebar-actions` (`MainLayout.vue`) and
  `.page-breadcrumbs` (`Index.vue`) beside it, both 41px. The shared `.w-section-header` stays at its
  own 34px rhythm -- raising it globally would move every section band in the app -- so the height is
  pinned here instead, and only the height: padding stays the shared class's, as
  `sectionHeaderRhythm.test.js` checks.

  `min-height`, not `height`, so a wrapped title can still grow past the band.
*/
.tags-browse .w-section-header {
  min-height: 41px;
}

/*
  The page class is stated a second time on purpose: the rules these override live in those
  components' SCOPED style blocks, which are unlayered and carry a `[data-v-*]` attribute, so a
  single class here would tie with them and the tie goes to whichever stylesheet Vite emits last.
  The extra class settles it on specificity instead.
*/
.tags-browse .tags-browse-plate {
  .w-item {
    align-items: flex-start;
    min-height: 0;
    padding: 12px 14px;
  }

  /* The row rule is drawn here, not through `WList`'s `separator`, which paints black at 12%. */
  .w-item + .w-item {
    border-block-start: 1px solid var(--color-tint);

    .body--dark & {
      border-block-start-color: var(--color-hairline-dark);
    }
  }

  .w-item-section--avatar {
    min-width: 0;
    padding-inline-end: 14px;
  }

  .w-item-section--main ~ .w-item-section--side {
    padding-inline-start: 14px;
  }
}
</style>
