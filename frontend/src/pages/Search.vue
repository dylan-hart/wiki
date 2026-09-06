<template>
  <w-layout>
    <w-header><header-nav /></w-header>
    <w-page-container class="layout-search">
      <!--
        No floating Back control in the gutter beside this card. It was a shadowed circle -- the
        opposite of Cardinal's flat hairline vocabulary -- and it was redundant: the header's own
        search field is what brought the reader here and is still on screen above them, and the
        browser has its own Back. Removed outright rather than restyled (OpenProject #2697).
      -->
      <div class="layout-search-card">
        <!--
          Below 900px the sort and filter panel is a disclosure rather than a column: 300px of it beside a
          390px screen left the results a 210px strip, and being a column of form fields it cannot be
          narrowed to its content the way the profile's nav can. Closed to start with, because what a reader
          arriving here wants is the results -- refining them is the second thing, and one tap away.

          The chevron turns rather than being swapped for a second icon, so the two states are one drawing.
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
        <div class="layout-search-sd" v-show="!isFiltersCollapsed || state.filtersOpen">
          <div class="section-header">{{ t('search.sortBy') }}</div>
          <w-list dense padding>
            <w-item
              v-for="item of orderByOptions"
              :key="item.value"
              clickable
              :active="item.value === state.params.orderBy"
              @click="setOrderBy(item.value)">
              <w-item-section side>
                <w-icon
                  :name="item.icon"
                  :color="item.value === state.params.orderBy ? `primary` : ``" />
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
                  color="primary" />
              </w-item-section>
            </w-item>
          </w-list>
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
            <span v-else
              ><em>{{ t('search.emptyQuery') }}</em></span
            >
          </div>
          <!--
            A result row, as the design draws it: a hairline icon plate, then the page itself --
            title, description, mono path, the matched text -- then a fixed trailing column holding
            when it was last touched and what it is tagged with.

            Plain markup rather than `w-list`/`w-item`. Those rows are metric-driven by
            `WItemSection` (a 56px leading avatar column, 16px of padding between sections, a 40px
            avatar), and every measurement in this row -- the 34px plate, the 14px gutter, the 150px
            trailing column -- is the design's own. Expressing them through the shared component
            would mean overriding it from the outside at each of those three points, which is
            fighting a component this screen does not own rather than laying out a row.
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
                <div class="layout-search-rowtitle">{{ item.title }}</div>
                <div v-if="item.description" class="layout-search-rowdesc">
                  {{ item.description }}
                </div>
                <div class="layout-search-rowpath">/{{ item.path }}</div>
                <div class="layout-search-rowexcerpt text-highlight" v-if="item.highlight">
                  <span v-html="item.highlight" />
                </div>
              </div>
              <div class="layout-search-rowmeta">
                <div class="layout-search-rowdate">{{ item.updatedAtFormatted }}</div>
                <!--
                  Only when there is something to draw: an empty wrapper would still take the
                  column's 6px gap and leave the date sitting a row-height above the row's own
                  baseline on every untagged page.
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

import { humanizeDate } from '@/helpers/datetime'
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
import { apiErrorMessage } from '@/helpers/apiError'
import { log } from '@/helpers/log'
import { extractTags, MAX_QUERY_LENGTH } from './searchTags.js'

/** How many results one page of search results holds. The API caps a single request at 100. */
const RESULTS_LIMIT = 100

// STORES

const flagsStore = useFlagsStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// META

/*
  Both halves, because `/_search` is mounted on its own with no layout above it to supply either. Only
  the template was registered, and a template with no title leaves `document.title` alone: the tab read
  whatever was there already, which on a fresh load is the shell's own `Cardinal.js`.

  The name is this page's own, where the template said `profile.title` and announced a page of search
  results as somebody's profile. Nothing sits between it and the site name, so nothing is inserted there.

  A getter for the site title, as everywhere else -- see the note in `MainLayout`.
*/
useMeta(() => {
  const siteTitle = siteStore.title
  return {
    title: t('search.results'),
    titleTemplate: (title) => `${title} - ${siteTitle}`
  }
})

// DATA

const state = reactive({
  loading: 0,
  /** Whether the sort/filter panel is open. Only consulted below 900px, where it is a disclosure. */
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
   * `true` when `total` is a floor, not an exact count: this reader's page rules dropped one or more
   * of the rows the search engine itself matched (OpenProject #2006). The results list is never
   * wrong -- everything shown is something this reader may actually open -- only the count beside it
   * can undercount what a search with no restrictions would have found.
   */
  totalApproximate: false,
  offset: 0
})

/**
 * Below 900px, where the filter panel stops being a column beside the results and becomes a disclosure
 * above them.
 *
 * This layout's own breakpoint rather than one of the app's, and the same one `ProfileOverlay` uses for its
 * nav: the two screens are the same shape -- a card with a 300px sidebar -- so they run out of room at the
 * same width. The stylesheet has to agree with it; `$filters-collapse-max` is the same boundary from the
 * other side.
 */
const isAtLeast900 = useMinWidth(900)
const isFiltersCollapsed = computed(() => !isAtLeast900.value)

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

const tags = computed(() => siteStore.tags.map((t) => t.tag))

const defaultPageIcon = DEFAULT_PAGE_ICON

/**
 * `state.results` with each row's update time formatted, computed once when the result set changes
 * rather than once per render of a list that can hold up to `RESULTS_LIMIT` rows.
 */
const formattedResults = computed(() =>
  state.results.map((r) => ({ ...r, updatedAtFormatted: humanizeDate(t, r.updatedAt) }))
)

// WATCHERS

watch(
  () => route.query,
  async (newQueryObj) => {
    if (newQueryObj.q) {
      siteStore.search = newQueryObj.q.trim().slice(0, MAX_QUERY_LENGTH)
      syncTags()
      performSearch()
    }
  },
  { immediate: true }
)

watch(() => state.params, debounce(performSearch, 500), { deep: true })

// METHODS

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

/**
 * Runs a search. `append` distinguishes the two callers: a fresh search (a new query, filter or
 * sort) starts over at offset 0 and replaces `state.results`, while `loadMore()` asks for the next
 * page at the current offset and appends onto what is already shown.
 */
async function performSearch(append = false) {
  let q = siteStore.search ?? ''

  // -> Extract tags
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

  // -> Nothing to go on: the empty state says as much, and asking the server would answer with the
  //    most recently updated pages, which is not what an empty search box means
  if (!q && Object.keys(filters).length < 1) {
    state.results = []
    state.total = 0
    state.totalApproximate = false
    state.offset = 0
    siteStore.searchLastQuery = siteStore.search
    siteStore.searchIsLoading = false
    return
  }

  const offset = append ? state.offset : 0

  state.loading++
  siteStore.searchIsLoading = true
  try {
    const resp = await API_CLIENT.get(`sites/${siteStore.id}/pages/search`, {
      searchParams: {
        ...(q ? { query: q } : {}),
        ...filters,
        orderBy: state.params.orderBy,
        orderByDirection: state.params.orderByDirection,
        offset,
        limit: RESULTS_LIMIT
      }
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

function loadMore() {
  return performSearch(true)
}

// MOUNTED

onMounted(async () => {
  if (!siteStore.search) {
    siteStore.searchIsLoading = false
  }
  // -> The tag filter offers what the wiki actually uses, so the list has to be fetched; without it
  //    the dropdown is silently empty. Listing tags needs a session, and a reader without one still
  //    gets to search — they just filter by typing `#tag` instead of picking from the list
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

<style lang="scss">
/*
  Where this card's two desktop assumptions give out -- the same two widths `components/ProfileOverlay.vue`
  declares, because the two screens are the same shape and run out of room together. Deliberately not in
  `_palette.scss`, which is for breakpoints the whole app shares; these describe one kind of card. Change
  them in one file and the other wants the same change.

  `$filters-collapse-max` has to agree with the 900px `useMinWidth` above it.
*/
$filters-collapse-max: 899.98px;
$card-gutter-max: 1199.98px;

/*
  Row metrics, from the design (`docs/ui-redesign-supplementary/Cardinal Wiki - Search 3x.dc.html`).
  Named because the below-600px stacking rule has to derive its inset from them rather than restate
  a number: the date and tags wrap under the TITLE, which starts one plate plus one gutter in.
*/
$plate-size: 34px;
$row-gutter: 14px;
$row-inset: $plate-size + $row-gutter;

/*
  The trailing column: when the page was last touched, and what it is tagged with. Fixed rather than
  content-sized so that every row's title ends on the same edge down the list -- a column that sized
  itself would step in and out by a few pixels per row as the dates and tag counts varied.
*/
$row-meta-width: 150px;

/*
  A header strip's height. One value for all three (Sort by, Filters, Results) because Sort by and
  Results start the two columns side by side and are read as a single ruled line across the card.
*/
$strip-height: 37px;

.layout-search {
  /*
    The ordinary page ground. What used to be here was a dark radial band painted across the top
    200px of the window with a hairline gradient under it -- elevation and 2.x chrome, on a screen
    whose card is now held by a hairline like every other Cardinal surface. Both the `:before` band
    and the `:after` gradient are gone, and with them the `$grey-3` ground they were washing over
    (OpenProject #2697).
  */
  @at-root .body--light & {
    background-color: $paper;
  }
  @at-root .body--dark & {
    background-color: $dark-6;
  }

  &-card {
    position: relative;
    width: 90%;
    max-width: 1400px;
    margin: 50px auto;
    display: flex;
    align-items: stretch;
    /*
      No height of its own, as `.layout-profile-card` explains at length: the scrolling page container
      grows this into the height left over beside its margins, and lets its content take it past that.

      It used to say `height: 100%`, which overflowed the box by exactly its own margins on every
      search however few results came back -- so the footer under it started 100px below the fold --
      and, since a height is not a minimum, spilled a long result list out past the bottom edge of the
      white card the results are supposed to sit on.
    */

    /*
      A foreground to go with the background, as `.layout-profile-card` needs for the same reason:
      this card is a plain div rather than a WCard, and a WCard is what declares BOTH halves of a
      surface. With only the background set, everything inside inherited the document's black --
      headings, result titles, input and select values alike -- which is invisible on the dark one.
      The light value is the black it was already inheriting, so only dark mode changes.

      Held by a hairline rather than by a shadow: Cardinal draws a card as a plate on paper, and the
      `$shadow-2` that used to sit here was the other half of the dark band above.
    */
    @at-root .body--light & {
      background-color: $surface;
      border: 1px solid $hairline;
      color: $text-body;
    }
    @at-root .body--dark & {
      background-color: $dark-3;
      border: 1px solid $hairline-dark;
      color: $text-dark;
    }
  }

  &-sd {
    flex: 0 0 300px;
    overflow: hidden;

    @at-root .body--light & {
      background-color: $tint;
      border-inline-end: 1px solid $hairline;
    }
    @at-root .body--dark & {
      background-color: $dark-4;
      border-inline-end: 1px solid $hairline-dark;
    }
  }

  /*
    A header strip: Sort by, Filters, Results.

    PINNED to a fixed height, with `line-height: 1`. The Results strip carries the result count
    beside its label, and that count is the one thing on this screen whose length is not known in
    advance -- "42 results", "At least 1,204 results", nothing at all while a search is in flight.
    Left to size itself, the strip's height would follow the tallest line box inside it, and the
    Results bar would stop lining up with the Sort by bar that starts the column beside it. Since
    both are supposed to read as one ruled line across the top of the card, that is visible at a
    glance. A fixed height plus a line-height of 1 makes a bar's height independent of what is
    written in it.
  */
  .section-header {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 12px;
    height: $strip-height;
    padding: 0 16px;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.2em;
    text-transform: uppercase;

    @at-root .body--light & {
      color: $accent-strong;
      background-color: $tint-alt;
      border-bottom: 1px solid $hairline;
    }
    @at-root .body--dark & {
      color: $accent-dark;
      background-color: $dark-2;
      border-bottom: 1px solid $hairline-dark;
    }
  }

  /* -> A strip that follows content is ruled off from it as well as from what comes after */
  .layout-search-sd .section-header:not(:first-child) {
    @at-root .body--light & {
      border-top: 1px solid $hairline;
    }
    @at-root .body--dark & {
      border-top: 1px solid $hairline-dark;
    }
  }

  /*
    The result count, in the strip beside the Results label. Mono and `line-height: 1` for the same
    reason the strip itself is: it is a number that changes length, and nothing about it may reach
    the bar's height.
  */
  &-count {
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: 0;
    text-transform: none;

    @at-root .body--light & {
      color: $text-caption;
    }
    @at-root .body--dark & {
      color: $text-caption-dark;
    }
  }

  // -> `.text-highlight` (the matched-term `<b>` treatment) lives in `css/tailwind.css`'s
  //    `@layer components`, shared with `HeaderSearch.vue`'s preview panel rather than duplicated here.

  .w-page {
    flex: 1 1;
    min-width: 0;
  }

  /* --- A result row ------------------------------------------------------------------------------ */

  &-row {
    display: flex;
    gap: $row-gutter;
    padding: 14px 16px;
    text-decoration: none;
    color: inherit;

    @at-root .body--light & {
      border-bottom: 1px solid $hairline;
    }
    @at-root .body--dark & {
      border-bottom: 1px solid $hairline-dark;
    }

    &:hover {
      @at-root .body--light & {
        background-color: $paper;
      }
      @at-root .body--dark & {
        background-color: $dark-2;
      }
    }
  }

  /*
    The plate. The same square hairline frame `BlueprintIcon` draws for a settings row and at the
    same 34px, but in the accent rather than the chrome tone -- what sits in it here is the page's
    OWN icon, which is the thing the reader is looking for, not the label of a setting.
  */
  &-plate {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: $plate-size;
    height: $plate-size;

    @at-root .body--light & {
      border: 1px solid $hairline;
      background-color: $surface;
      color: $primary;
    }
    @at-root .body--dark & {
      border: 1px solid $hairline-dark;
      background-color: $dark-4;
      color: $accent-dark;
    }
  }

  /*
    A ZERO basis, not `auto`, and `min-width: 0` beside it. Both are load-bearing below 600px, where
    the row is `flex-wrap: wrap`: wrapping is decided from each item's hypothetical main size, so a
    body whose basis is its own content (a title, a description and a path) does not fit beside the
    plate and drops onto its own line -- putting the title hard against the card's edge instead of
    beside the plate, and leaving the stacked date and tags inset under nothing. From zero it stays
    on the plate's line and shrinks, which is what the design draws and what the `flex: 1 1 0%` on
    `WItemSection`'s main section was quietly doing before this row stopped being a `w-item`.
  */
  &-rowbody {
    flex: 1 1 0;
    min-width: 0;
  }

  &-rowtitle {
    font-size: 15px;
    font-weight: 500;

    @at-root .body--light & {
      color: $ink;
    }
    @at-root .body--dark & {
      color: $text-dark;
    }
  }

  &-rowdesc {
    padding-top: 1px;
    font-size: 13px;
    line-height: 1.5;

    @at-root .body--light & {
      color: $text-secondary;
    }
    @at-root .body--dark & {
      color: $text-secondary-dark;
    }
  }

  &-rowpath {
    padding-top: 3px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    overflow-wrap: anywhere;

    @at-root .body--light & {
      color: $text-caption;
    }
    @at-root .body--dark & {
      color: $text-caption-dark;
    }
  }

  &-rowexcerpt {
    padding-top: 5px;
    font-size: 12.5px;
    line-height: 1.55;

    @at-root .body--light & {
      color: $text-body;
    }
    @at-root .body--dark & {
      color: $text-dark;
    }
  }

  &-rowmeta {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    width: $row-meta-width;
  }

  &-rowdate {
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-align: end;

    @at-root .body--light & {
      color: $text-caption;
    }
    @at-root .body--dark & {
      color: $text-caption-dark;
    }
  }

  &-rowtags {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 4px;
  }

  /*
    THREE NARROWER LAYOUTS
    ======================

    Same shape and same thresholds as `components/ProfileOverlay.vue`, which is the app's other card-beside-a-
    sidebar screen: a sheet floating in a tinted page -- 90% of the width, 50px of gutter all round -- with
    a 300px sidebar down its left side. Both give out as the window narrows, so the card gives them up one
    at a time:

      below 1200px   the card's gutters halve, handing the results the width they are running out of. The
                     sidebar keeps its 300px, unlike the profile's nav: that one is a list of labels and
                     can be as narrow as they are, where this is a column of form fields
      below 900px    the sidebar goes altogether and becomes a disclosure above the results
      below 600px    the card stops being a sheet and becomes the screen, and a result row stacks

    Ordered narrowest-last, so each block overrides the one above it where the two speak about the same
    property. `$filters-collapse-max` is the stylesheet's half of the 900px `useMinWidth` above, which is
    what decides whether the disclosure button is rendered at all.
  */

  /* --- Below 1200px: the card gives up half its gutters ------------------------------------------- */
  @media (max-width: $card-gutter-max) {
    /*
      Halved from `90% / 50px`. Not bracketed to a band: below 900 the gutters would otherwise jump back to
      the wider pair as the window narrowed, which is the one thing a reader resizing a window notices.
    */
    &-card {
      width: 95%;
      margin: 25px auto;
    }
  }

  /* --- Below 900px: the sidebar is a disclosure above the results --------------------------------- */
  @media (max-width: $filters-collapse-max) {
    &-card {
      flex-direction: column;
    }

    /*
      The disclosure's bar. Full width, so it reads as a strip of the card rather than as a button sitting
      on it -- `space-between` is what puts the chevron at the far end from the label, where a disclosure's
      marker belongs.
    */
    &-filterbtn {
      justify-content: space-between;

      @at-root .body--light & {
        background-color: $tint-alt;
        border-bottom: 1px solid $hairline;
      }
      @at-root .body--dark & {
        background-color: $dark-2;
        border-bottom: 1px solid $hairline-dark;
      }
    }

    /* -> The whole content of the button is one flex row, so the chevron needs pushing to the end of it */
    &-filterbtn > span {
      flex: 1;
      justify-content: space-between;
    }

    &-filterchevron {
      transition: transform 0.2s var(--ease-standard);

      &.is-open {
        transform: rotate(180deg);
      }
    }

    /*
      The panel, no longer a 300px column: the full width of the card, and the seam that divided the two
      columns moves from its right edge to its bottom one. Both stated per theme, because that is where
      the rules they replace are declared -- at three classes each, which a plain override here would
      lose to.
    */
    &-sd {
      flex: none;
      width: 100%;

      @at-root .body--light & {
        border-inline-end: 0;
        border-bottom: 1px solid $hairline;
      }
      @at-root .body--dark & {
        border-inline-end: 0;
        border-bottom: 1px solid $hairline-dark;
      }
    }
  }

  /* --- Below 600px: the card is the screen, and a result row stacks -------------------------------- */
  @media (max-width: $breakpoint-xs-max) {
    &-card {
      width: 100%;
      margin: 0;

      @at-root .body--light & {
        border-inline: 0;
      }
      @at-root .body--dark & {
        border-inline: 0;
      }
    }

    /*
      A result stacks instead of reserving a column for its date and tags. That column is a fixed
      150px, so beside it a title had whatever was left -- and what was left of 390px, after a plate
      and a date, was a few words. Wrapped onto its own line the row reads as a card: plate and
      title, the path and the matched text under it, then when it was touched and what it is tagged
      with.
    */
    &-row {
      flex-wrap: wrap;
    }

    /*
      And the plate goes to the top of the row rather than the middle of it -- it is centred for a
      row two lines tall, and would be stranded halfway down one that is now six.
    */
    &-plate {
      align-self: flex-start;
    }

    /*
      Lined up under the title rather than under the plate. The inset is DERIVED from the row's own
      metrics ($plate-size + $row-gutter) rather than restated as a number: change the plate and the
      stacked line follows it, which is what the hand-written 56px it replaces did not do -- that
      value was `WItemSection`'s avatar-column width, and stopped describing this row the moment the
      row stopped being a `w-item`.
    */
    &-rowmeta {
      width: 100%;
      align-items: flex-start;
      margin-top: 0.25rem;
      padding-inline-start: $row-inset;
    }

    &-rowdate {
      text-align: start;
    }

    &-rowtags {
      justify-content: flex-start;
    }
  }
}

body.body--dark {
  background-color: $dark-6;
}

// -> The `.w-footer .q-bar` rule that used to sit here never matched: FooterNav renders
//    `.site-footer`, never a q-bar. Its colours live in FooterNav's own scoped style.
</style>
