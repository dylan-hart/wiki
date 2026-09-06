<template>
  <w-page class="tags-browse">
    <!--
      No `padding` on the page: the design runs the section band edge to edge across the content
      column and pads only the body beneath it (`.tags-browse-body`). `w-page padding` inset the band
      by 16px on all four sides, which made it read as a floating heading rather than as the column's
      own header strip.
    -->
    <div class="w-section-header">{{ t('tags.title') }}</div>

    <div class="tags-browse-body">
      <div class="tags-browse-sidebar">
        <template v-if="state.selectedTags.length > 0">
          <div class="tags-browse-subheader flex items-center justify-between">
            <span>{{ t('tags.currentSelection') }}</span>
            <!--
              Plain secondary text flush to the column's own 8px edge, as the design draws it: the
              dense button's 10px of horizontal padding pushed the label past every chip below it.
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
          <div class="tags-browse-chips flex flex-wrap items-center gap-[5px] p-2">
            <!--
              The `#` is a mono glyph, not a drawn icon: the design sets it in Roboto Mono ahead of
              the label, exactly as the already-settled page tag plate (`PageTags.vue`) does.
            -->
            <w-chip
              v-for="tag of state.selectedTags"
              :key="`selected-${tag}`"
              color="primary"
              text-color="white"
              size="11.5px"
              removable
              @remove="toggleTag(tag)">
              <span class="tags-browse-hash" aria-hidden="true">#</span>{{ tag }}
            </w-chip>
          </div>
        </template>

        <div class="tags-browse-subheader flex items-center justify-between">
          <span>{{ state.managementMode ? t('tags.manageTags') : t('editor.props.tags') }}</span>
          <!--
            A 24px box with a 14px glyph, per the design: `size="10px"` gives the box (WBtn's round
            variant is 2.4em), and the glyph comes through the SLOT rather than the `icon` prop so
            `WIcon`'s own `size` renders as an inline style -- the prop route would inherit WBtn's
            1.715em and draw a 17px gear inside a 24px circle.
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
          Not `dense`: the design's filter fields are the 34px frame with 10px of inset, which is
          exactly what the DEFAULT field draws (`composables/fieldFrame.js`) -- `dense` is the 28px
          one. `options-dense` is unrelated and stays: it compresses the dropped-open menu.
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
        <!--
          The rows sit inside a hairline plate on the surface, not loose on the page ground -- the
          design wraps them in a bordered white box inset 8px from the column. `separator` is off
          because the rule the design draws between rows is the pale tint, not the list's own
          black-at-12%; `.tags-browse-plate` draws it as a border instead.
        -->
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
                <!--
                  Path and last-updated are the design's mono metadata pair -- the same treatment,
                  not a plain caption and a greyed one.
                -->
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
          <!-- An outlined plate on the surface, as the design draws it -- not a flat accent label. -->
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
/*
  `ui-redesign/Cardinal Wiki - Tags 3x.dc.html`, walked top to bottom (OpenProject #2626). Every
  metric below is the design file's own; where a number here looks arbitrary it is quoted from it.

  Deliberately NOT scoped. Several rules have to reach shared components the page mounts (`WChip`'s
  padding, `WItem`'s row metrics, `WItemLabel`'s caption tone), and a scoped block cannot -- while an
  SFC style block is emitted UNLAYERED, which is what lets a plain class here beat the Tailwind
  utility those components carry without `!important`.
*/
.tags-browse {
  /* The page's own inset, held here rather than on `w-page`, so the band above stays full-bleed. */
  &-body {
    display: flex;
    align-items: flex-start;
    /*
      The design pads the body `16px 20px` beneath a full-bleed section band. `.w-section-header`
      already contributes the section rhythm's own 14px `margin-block-end` (#2631), so 2px here lands
      the first row on the design's 16px -- rather than overriding the shared band, which #2631 owns.

      Unrelated to the band's own HEIGHT (#2717 raised it 34px -> 38px to match the sidebar-actions
      and breadcrumb bands beside it): this 2px reconciles the shared rhythm's fixed 14px trailing
      margin against the design's fixed 16px total gap, and that arithmetic doesn't involve the
      band's height at all -- `ui-redesign/Cardinal Wiki - Tags 3x.dc.html` draws the row below the
      band at a flat `padding: 16px 20px` regardless of how tall the band above it is.
    */
    padding: 2px 20px 16px;
    gap: 1.5rem;
    /* The design wraps rather than squeezing: 280 + 24 + 320 is the point the two columns stack. */
    flex-wrap: wrap;
  }

  &-sidebar {
    flex: 0 0 280px;
    min-width: 260px;
  }

  &-results {
    flex: 1 1 auto;
    min-width: 320px;
  }

  &-subheader {
    /* 12px above every group, 8px above the column's first -- the design's own rhythm. */
    padding: 12px 8px 0;
    font-size: 13px;
    font-weight: 500;
    color: $primary;

    &:first-child {
      padding-block-start: 8px;
    }

    @at-root .body--dark & {
      color: var(--color-primary-light);
    }
  }

  /*
    The `#` ahead of a chip's label, in the design's mono. Sized in `em` so one rule serves both the
    11.5px sidebar chip (10px) and the 11px result-row chip (9.5px).
  */
  &-hash {
    margin-inline-end: 4px;
    font-family: var(--font-mono);
    font-size: 0.87em;
    font-weight: 500;
  }

  /* Sidebar chips: `padding:3px 7px; gap:4px` -- neither the dense nor the default WChip box. */
  &-chips .w-chip {
    gap: 4px;
    padding: 3px 7px;
  }

  &-count {
    color: $text-secondary;

    strong {
      color: $ink;
      font-weight: 700;
    }

    @at-root .body--dark & {
      color: $text-secondary-dark;

      strong {
        color: $text-dark;
      }
    }
  }

  &-plate {
    margin: 8px 8px 0;
    border: 1px solid $hairline;
    background-color: $surface;

    @at-root .body--dark & {
      border-color: $hairline-dark;
      background-color: $dark-3;
    }

    .w-chip {
      gap: 3px;
    }
  }

  &-result-title {
    font-size: 14.5px;
    font-weight: 500;
    color: $ink;

    @at-root .body--dark & {
      color: $text-dark;
    }
  }

  &-result-desc {
    font-size: 12.5px;
    color: $text-secondary;

    @at-root .body--dark & {
      color: $text-secondary-dark;
    }
  }

  &-result-meta {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: $text-caption;

    @at-root .body--dark & {
      color: $text-caption-dark;
    }
  }

  &-more {
    padding: 16px 8px 0;
  }

  @media (max-width: $breakpoint-sm-max) {
    &-body {
      flex-direction: column;
      /* The design's 20px inline padding is a desktop rhythm; a phone column takes the page's own. */
      padding-inline: 16px;
    }

    &-sidebar,
    &-results {
      flex: none;
      width: 100%;
      min-width: 0;
    }
  }
}

/*
  OpenProject #2717: this page's own top band (`.w-section-header`, "Browse by tags") sat at the
  shared 34px section-header height while `.sidebar-actions` (`MainLayout.vue`, `height: 38px`)
  beside it and `.page-breadcrumbs` (`Index.vue`, `min-height: 38px`, matched to `.sidebar-actions` by
  #2613) sit at the same vertical position everywhere else -- so this band's own bottom hairline
  landed 4px above theirs instead of on the same line.

  The shared `.w-section-header` stays 34px (`#2631`'s own rhythm, guarded by
  `sectionHeaderRhythm.test.js`, which scans for -- and this rule deliberately isn't -- a `padding`
  override): raising it globally would move every section band in the app. This page pins its own
  band locally instead, the same way `.tags-browse-plate` below overrides `WItem`'s metrics: two
  classes for deterministic specificity over the shared, unscoped rule.

  `min-height`, not `height`, for the same reason `.page-breadcrumbs` uses it: a long enough locale
  name or a wrapped title still has to be able to grow past the band. Fill and border are left alone
  -- the design (`ui-redesign/Cardinal Wiki - Tags 3x.dc.html`) already draws this band at the shared
  class's own tint fill and hairline rule, just 38px tall, so nothing else needs to change for the
  two bands to read as one strip.
*/
.tags-browse .w-section-header {
  min-height: 38px;
}

/*
  The result row's own box, at the design's metrics rather than `WItem`/`WItemSection`'s defaults.

  Written with the page class stated a second time on purpose: the rules these override live in
  those components' SCOPED style blocks, which are unlayered and carry a `[data-v-*]` attribute --
  so `.w-item-section--main ~ .w-item-section--side` there scores the same as the two-class form
  here would, and a tie is settled by whichever stylesheet Vite happens to emit last. The extra
  class puts the outcome on specificity instead, where it is deterministic.
*/
.tags-browse .tags-browse-plate {
  /* Row box: `padding:12px 14px`, top-aligned, no minimum band height of its own. */
  .w-item {
    align-items: flex-start;
    min-height: 0;
    padding: 12px 14px;
  }

  /*
    The rule between rows is the pale tint, a step lighter than the plate's own hairline -- drawn
    here rather than through `WList`'s `separator`, which paints black at 12%.
  */
  .w-item + .w-item {
    border-block-start: 1px solid $tint;

    @at-root .body--dark & {
      border-block-start-color: $hairline-dark;
    }
  }

  /* 14px between the plate, the body and the tag rail -- the design's gap, not WItemSection's 16. */
  .w-item-section--avatar {
    min-width: 0;
    padding-inline-end: 14px;
  }

  .w-item-section--main ~ .w-item-section--side {
    padding-inline-start: 14px;
  }
}
</style>
