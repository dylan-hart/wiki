<template>
  <!--
    `row` is the phone form, a full-width row of its own. Shorter than the header proper, so the two
    read as a bar and a drawer under it rather than as two headers.
  -->
  <w-toolbar :style="{ height: row ? `52px` : `64px` }" v-if="siteStore.features.search">
    <!--
      The panel's positioning context and the width it matches. The toolbar cannot be it: the panel
      would then span the toolbar's padding as well, and with no positioned ancestor at all it
      stretches to the whole window. Full toolbar height, with the field centred inside it, so the
      panel's `top: 100%` lands on the bottom edge of the header.
    -->
    <div class="header-search relative flex h-full min-w-0 flex-1 flex-col justify-center">
      <div
        class="header-search-row-inline flex items-stretch"
        :class="{ 'is-focused': state.searchIsFocused }">
        <div
          class="header-search-field"
          :class="{
            'header-search-field--row': row,
            'header-search-field--docked': !row
          }">
          <w-circular-progress
            v-if="siteStore.searchIsLoading && route.path !== `/_search`"
            class="header-search-lead"
            color="primary"
            size="18px" />
          <w-icon v-else class="header-search-lead" name="tabler:search" />

          <input
            ref="searchField"
            v-model="siteStore.search"
            type="text"
            class="header-search-input"
            :placeholder="t('common.header.search')"
            :aria-label="t('common.header.search')"
            aria-keyshortcuts="Meta+K Control+K"
            autocomplete="off"
            @keyup.enter="onSearchEnter"
            @focus="state.searchIsFocused = true"
            @blur="checkSearchFocus" />

          <!--
            `mousedown.prevent` keeps the press from blurring the input -- the same guard every
            other control in and around this panel needs: the blur closes the panel out from under
            the click before it can fire.
          -->
          <button
            v-if="siteStore.search.length > 0"
            type="button"
            class="header-search-clear"
            :aria-label="t('common.actions.clear')"
            @mousedown.prevent
            @click="clearSearch">
            <w-icon name="tabler:x" />
          </button>
          <!--
            Shown regardless of focus: a hint that comes and goes on focus changes
            `.header-search-field`'s width, which shifts the buttons docked beside it out from under
            the pointer mid-click. Never in `row` form -- the phone has no keyboard to shortcut with.
          -->
          <span
            v-if="!row"
            class="header-search-kbd"
            aria-hidden="true"
            @click="searchField.focus()">
            {{ searchShortcutHint }}
          </span>
        </div>

        <!--
          `siteStore.features.semanticSearch` is the same combined flag `Search.vue`'s own in-page
          mode toggle gates on -- never re-derived here.
        -->
        <button
          v-if="!row && siteStore.features.semanticSearch"
          type="button"
          class="header-search-mode-btn"
          :class="{ 'is-active': state.searchMode === 'semantic' }"
          :aria-pressed="state.searchMode === 'semantic'"
          :aria-label="t('search.modeSemantic')"
          @click="toggleSearchMode">
          <w-icon name="tabler:sparkles" />
          <w-tooltip>{{ t('search.modeSemantic') }}</w-tooltip>
        </button>
        <!--
          Docked flush against the field's right edge so the two read as one continuous pill. Not
          offered in `row` form -- the phone's full-width field has no room for a control glued to
          it, and its other icon buttons live in `HeaderActionsMenu`'s overflow menu instead.
        -->
        <router-link
          v-if="!row"
          to="/_tags"
          class="header-search-tags-btn"
          :aria-label="t('common.header.browseTags')">
          <w-icon name="tabler:tags" />
          <w-tooltip>{{ t('common.header.browseTags') }}</w-tooltip>
        </router-link>
      </div>

      <div class="searchpanel" ref="searchPanel" v-if="searchPanelIsShown">
        <!--
          Gated on the query alone, not on the preview states below: a shareable link is meaningful
          below the 2-character preview floor too, where none of those has anything to say yet.
        -->
        <div class="searchpanel-header searchpanel-copylink-row" v-if="siteStore.search">
          <span
            v-if="
              searchPreviewIsActive && !state.previewLoading && state.previewResults.length > 0
            ">
            {{ t('common.header.searchResultsCount', { total: state.previewTotal }) }}
          </span>
          <w-space />
          <w-btn
            class="header-search-copy-link acrylic-btn"
            flat
            round
            size="xs"
            icon="tabler:link"
            :aria-label="t('common.header.searchCopyLink')"
            :title="t('common.header.searchCopyLink')"
            @mousedown.prevent
            @click="copySearchLink" />
        </div>

        <template v-if="state.previewLoading">
          <div class="searchpanel-header searchpanel-status">
            <w-circular-progress color="primary" size="16px" />
            <span>{{ t('common.header.searchLoading') }}</span>
          </div>
        </template>
        <template v-else-if="searchPreviewIsActive && state.previewResults.length < 1">
          <div class="searchpanel-header">{{ t('common.header.searchNoResult') }}</div>
          <button
            v-if="state.previewSuggestion"
            type="button"
            class="searchpanel-suggestion-link"
            @mousedown.prevent
            @click="applySuggestion">
            {{ t('common.header.searchDidYouMean') }} <strong>{{ state.previewSuggestion }}</strong>
          </button>
        </template>
        <template v-else-if="searchPreviewIsActive && state.previewResults.length > 0">
          <w-list dense class="searchpanel-results">
            <w-item
              v-for="item of previewResultRows"
              :key="item.path"
              clickable
              :to="resultHref(item)"
              @mousedown.prevent>
              <w-item-section avatar>
                <w-icon :name="item.icon || defaultPageIcon" />
              </w-item-section>
              <!--
                Ellipsised, not wrapped: the panel has a fixed width and no horizontal scroll, and
                every row has to stay exactly as tall as its neighbours.
              -->
              <w-item-section>
                <w-item-label lines="1">{{ item.title }}</w-item-label>
                <w-item-label class="text-grey" caption lines="1">/{{ item.path }}</w-item-label>
                <w-item-label class="text-highlight" v-if="item.highlight" caption lines="1">
                  <span v-html="item.highlight" />
                </w-item-label>
              </w-item-section>
            </w-item>
          </w-list>
        </template>

        <template v-if="siteStore.popularTagsLoaded && siteStore.popularTags.length > 0">
          <div class="searchpanel-header">
            <span>{{ t('common.header.popularTags') }}</span>
            <w-space />
            <w-btn class="acrylic-btn" flat :label="t('common.header.viewAll')" rounded size="xs" />
          </div>
          <div class="mb-4 flex flex-wrap gap-1">
            <w-chip
              v-for="tag of popularTags"
              :key="tag"
              color="grey-8"
              text-color="white"
              icon="tabler:hash"
              size="sm"
              clickable
              @click="addTag(tag)">
              {{ tag }}
            </w-chip>
          </div>
        </template>
        <button
          type="button"
          class="searchpanel-header searchpanel-operators-toggle"
          :aria-expanded="String(searchOperatorsExpanded)"
          :aria-controls="searchOperatorsId"
          @mousedown.prevent
          @click="searchOperatorsExpanded = !searchOperatorsExpanded">
          <span>{{ t('common.header.searchOperators') }}</span>
          <w-space />
          <w-icon
            name="tabler:chevron-down"
            class="searchpanel-operators-arrow"
            :class="{ 'rotate-180': searchOperatorsExpanded }" />
        </button>
        <div v-if="searchOperatorsExpanded" :id="searchOperatorsId">
          <div class="searchpanel-tip">
            <code>!foo</code> or <code>-bar</code> to exclude "foo" and "bar".
          </div>
          <div class="searchpanel-tip">
            <code>bana*</code> for to match any term starting with "bana" (e.g. banana).
          </div>
          <div class="searchpanel-tip">
            <code>foo,bar</code> or <code>foo|bar</code> to search for "foo" OR "bar".
          </div>
          <div class="searchpanel-tip">
            <code>"foo bar"</code> to match exactly the phrase "foo bar".
          </div>
        </div>
      </div>
    </div>
  </w-toolbar>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'

import { useSiteStore } from '@/stores/site'
import { DEFAULT_PAGE_ICON } from '@/stores/page'

import { orderBy } from 'es-toolkit/array'
import { debounce } from 'es-toolkit/function'
import { copyToClipboard } from '@/helpers/clipboard'
import { apiErrorMessage } from '@/helpers/apiError'
import { localizedPagePath } from '@/helpers/pagePaths'
import { log } from '@/helpers/log'
import { isApplePlatform } from '@/helpers/platform'
import { notify } from '@/composables/notify'

/** Below this, the panel's own tag and operator tips are the whole answer, so a fetch buys nothing. */
const PREVIEW_QUERY_MIN_LENGTH = 2

const PREVIEW_RESULTS_LIMIT = 5

const PREVIEW_DEBOUNCE_MS = 300

/**
 * Length with the operator/tag punctuation stripped: a leading `!`/`-`/`#` on a word, and
 * `"`/`*`/`,`/`|` wherever they occur. A query built entirely out of those -- `-a`, `#a`, a bare
 * `*` -- clears `PREVIEW_QUERY_MIN_LENGTH` in raw length while carrying nothing to search FOR.
 *
 * Gating only: the raw, unstripped query is still what gets sent, since the operators are real
 * syntax to the backend's `websearch_to_tsquery` rather than noise.
 */
function realQueryLength(query) {
  return query
    .split(/\s+/)
    .map((token) => token.replace(/^[!\-#]+/, '').replaceAll(/["*,|]/g, ''))
    .join('').length
}

const props = defineProps({
  /** What the phone header opens; see `HeaderNav`. */
  row: {
    type: Boolean,
    default: false
  }
})

const siteStore = useSiteStore()

const router = useRouter()
const route = useRoute()

const { t } = useI18n()

const state = reactive({
  searchIsFocused: false,
  previewResults: [],
  previewLoading: false,
  previewTotal: 0,
  /** The backend sets this only alongside a real, zero-hit query. */
  previewSuggestion: null,
  /**
   * The header's own not-yet-submitted choice, carried as the `mode` query param on the navigation
   * to `/_search`. Distinct from `Search.vue`'s `state.mode`, which is the live mode of a results
   * page already showing.
   */
  searchMode: 'keyword'
})

const searchPanel = ref(null)
const searchField = ref(null)

/** Deliberately not persisted: the watcher below resets it whenever the panel closes. */
const searchOperatorsExpanded = ref(false)
const searchOperatorsId = useId()

/**
 * Bumped on every fetch started or invalidated. A response is applied only under a still-matching
 * token, so a slower earlier request cannot clobber a faster later one's results.
 */
let previewRequestToken = 0

const searchPanelIsShown = computed(() => {
  return (
    state.searchIsFocused &&
    (siteStore.search !== siteStore.searchLastQuery || siteStore.search === '')
  )
})

/**
 * `siteStore.popularTags` (ranked by recent content activity and capped server-side), not the
 * all-time `siteStore.tags` the tag-edit autocomplete uses. The sort and slice here are
 * belt-and-braces, not the primary ranking.
 */
const popularTags = computed(() => {
  return orderBy(siteStore.popularTags, ['usageCount'], ['desc'])
    .map((t) => t.tag)
    .slice(0, 10)
})

const defaultPageIcon = DEFAULT_PAGE_ICON

/**
 * Apple platforms are hinted `⌘K`: Ctrl+K there is the OS-level emacs kill-to-end-of-line binding,
 * so the hint would name a combination that does something else entirely.
 *
 * A `computed`, not a `const`, even though the platform cannot change mid-session: `boot/i18n.js`
 * starts the i18n instance with empty messages and loads the catalog asynchronously, so a one-time
 * `t()` read before it lands would freeze the raw key in for the component's whole lifetime.
 */
const searchShortcutHint = computed(() =>
  isApplePlatform() ? t('common.header.searchShortcutMac') : t('common.header.searchShortcutOther')
)

/**
 * Below the floor `resetPreview()` has left `previewResults` at `[]`, which is indistinguishable
 * from a real zero-hit search unless this is checked first.
 */
const searchPreviewIsActive = computed(() => {
  return realQueryLength(siteStore.search ?? '') >= PREVIEW_QUERY_MIN_LENGTH
})

/** Defensive -- the request already asks for no more than this many. */
const previewResultRows = computed(() => state.previewResults.slice(0, PREVIEW_RESULTS_LIMIT))

watch(searchPanelIsShown, (newValue) => {
  if (newValue) {
    siteStore.fetchPopularTags()
  } else {
    searchOperatorsExpanded.value = false
  }
})

/*
  Only while the field is actually focused, so a query changed programmatically elsewhere (`addTag`,
  the `/_search` sync) does not start firing requests behind a panel nobody is looking at.
*/
watch(
  () => siteStore.search,
  (newQuery) => {
    if (!state.searchIsFocused) {
      return
    }
    const query = (newQuery ?? '').trim()
    if (realQueryLength(query) < PREVIEW_QUERY_MIN_LENGTH) {
      resetPreview()
      return
    }
    debouncedFetchPreview(query)
  }
)

/*
  Ignored while a full-screen overlay is up: this header is behind it, so the shortcut belongs to
  whatever is in front (FileManager has a search field of its own and claims it). Pulling focus into
  a field the reader cannot see is worse than the key doing nothing.
*/
function handleKeyPress(ev) {
  if (siteStore.features.search && !siteStore.overlayIsShown) {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'k') {
      ev.preventDefault()
      searchField.value.focus()
    }
  }
}

function onSearchEnter() {
  if (!siteStore.search) {
    return
  }
  submitSearch()
}

/** `replace` when a results page is already open -- that is refining a search in place, not a step. */
function submitSearch() {
  const query = { q: siteStore.search, mode: state.searchMode }
  if (route.path === '/_search') {
    router.replace({ path: '/_search', query })
  } else {
    siteStore.searchIsLoading = true
    router.push({ path: '/_search', query })
  }
}

/**
 * Resubmits immediately when a query is already typed: otherwise the click has no visible effect
 * until the reader separately presses Enter, which reads as the toggle having done nothing.
 */
function toggleSearchMode() {
  state.searchMode = state.searchMode === 'semantic' ? 'keyword' : 'semantic'
  if (siteStore.search) {
    submitSearch()
  }
}

function checkSearchFocus(ev) {
  if (!searchPanel.value?.contains(ev.relatedTarget)) {
    state.searchIsFocused = false
  }
}

/**
 * Exposed for `HeaderNav`: in `row` form, focusing the field is what draws the panel below it, so
 * it has to wait until the row's slide-in has finished (its `@after-enter`) rather than land a
 * layout pass and a `backdrop-filter` blur in the middle of the animation.
 */
function focus() {
  searchField.value?.focus()
}

/**
 * Also invalidates any request still in flight: its response is for a query the field no longer
 * holds, and would otherwise overwrite this reset with stale results.
 */
function resetPreview() {
  debouncedFetchPreview.cancel()
  previewRequestToken++
  state.previewResults = []
  state.previewLoading = false
  state.previewTotal = 0
  state.previewSuggestion = null
}

/**
 * Semantic mode is a separate route rather than a parameter on the keyword one -- the keyword
 * route's querystring schema has no mode field at all.
 */
async function fetchPreview(query) {
  const token = ++previewRequestToken
  state.previewLoading = true
  try {
    const endpoint =
      state.searchMode === 'semantic'
        ? `sites/${siteStore.id}/pages/search/semantic`
        : `sites/${siteStore.id}/pages/search`
    const resp = await API_CLIENT.get(endpoint, {
      searchParams: { query, limit: PREVIEW_RESULTS_LIMIT }
    }).json()
    if (token !== previewRequestToken) {
      return
    }
    state.previewResults = resp?.results ?? []
    state.previewTotal = resp?.totalHits ?? 0
    state.previewSuggestion = resp?.suggestion ?? null
  } catch (err) {
    if (token !== previewRequestToken) {
      return
    }
    state.previewResults = []
    state.previewTotal = 0
    state.previewSuggestion = null
    log.warn('search', 'could not load the search preview results', err)
  } finally {
    if (token === previewRequestToken) {
      state.previewLoading = false
    }
  }
}

const debouncedFetchPreview = debounce(fetchPreview, PREVIEW_DEBOUNCE_MS)

function clearSearch() {
  siteStore.search = ''
  resetPreview()
  searchField.value.focus()
}

/** The `q` param is what `Search.vue`'s route watcher reads, so the link opens a live search. */
async function copySearchLink() {
  const url = `${window.location.origin}/_search?q=${encodeURIComponent(siteStore.search)}`
  try {
    await copyToClipboard(url)
    notify({ type: 'positive', message: t('common.clipboard.success') })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('common.clipboard.failure'),
      caption: apiErrorMessage(err)
    })
  }
}

/**
 * A bare assignment re-runs the search: the field stays focused (the link's `@mousedown.prevent`),
 * so the preview watcher's own focus gate fires it exactly the way typing would.
 */
function applySuggestion() {
  if (!state.previewSuggestion) {
    return
  }
  siteStore.search = state.previewSuggestion
  searchField.value?.focus()
}

/**
 * Carries the query as `?highlight=` for the landing page's own in-page find (`Index.vue`'s
 * `applyKeywordHighlight`). `siteStore.search` is what the reader typed; `item.highlight` is the
 * backend's matched-text snippet with `<b>` markup, which is not what a find should look for.
 */
function resultHref(item) {
  const path = localizedPagePath(item.path, item.locale, siteStore.localeRouting)
  const query = (siteStore.search ?? '').trim()
  return query ? `${path}?highlight=${encodeURIComponent(query)}` : path
}

function addTag(tag) {
  if (!siteStore.search.includes(`#${tag}`)) {
    siteStore.search = siteStore.search ? `${siteStore.search} #${tag}` : `#${tag}`
  }
  searchField.value.focus()
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyPress)
  if (route.path.startsWith('/_search')) {
    searchField.value.focus()
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeyPress)
  resetPreview()
})

defineExpose({ focus, state })
</script>

<style>
@charset "UTF-8";
/*
  Deliberately not built on WInput: that is a form field -- label, hint line, error line -- and this
  is none of those, so it owns its own markup and styling rather than fighting a component's.
*/
.header-search {
  max-width: 480px;
  margin: 0 auto;
  /*
    Ground, edge and placeholder tone come from the `--color-header-search-*` tokens rather than the
    generic paper/hairline/caption trio: the field sits ON the header band, so it follows the band
    rather than the page surface.
  */
}
.header-search-field {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 6px 0 12px;
  border-radius: var(--radius-control);
  background-color: var(--color-header-search-bg);
  border: 1px solid var(--color-header-search-border);
  color: var(--color-header-search-placeholder);
  transition:
    border-color 0.2s var(--ease-standard),
    background-color 0.2s var(--ease-standard);
}
.header-search {
  /*
    A docked field owns only its two start-side corners; the tags button squares off its own to sit
    flush, so leaving these rounded draws a curved notch at the seam. Logical corner properties, so
    this follows the reading direction the way the border and padding around it already do.
  */
}
.header-search-field--docked {
  border-inline-end: 0;
  border-start-end-radius: 0;
  border-end-end-radius: 0;
}
.header-search {
  /*
    A class rather than `:focus-within`, so the field stays marked while the panel below is in use:
    clicking a tag in there moves focus out of the input, and the border flicking back
    mid-interaction reads as a glitch. The class sits on `.header-search-row-inline`, not on the
    field, so the ring can extend onto the docked buttons' borders instead of stopping at the seam.
  */
}
.header-search-row-inline.is-focused .header-search-field {
  background-color: var(--color-surface);
  border-color: var(--color-slate);
  color: var(--color-ink);
}
.header-search-lead {
  flex-shrink: 0;
  font-size: 17px;
  color: var(--color-header-icon);
}
.header-search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  /*
    `font: inherit` above would otherwise pull `body`'s 14px base rather than the search field's own
    13.5px role, which is identical in both aesthetics -- hence unscoped.
  */
  font-size: 13.5px;
  outline: none;
}
.header-search-input::placeholder {
  color: currentColor;
  opacity: 0.55;
}
.header-search-input {
  /* -> the UA's own clear affordance would sit beside ours */
}
.header-search-input::-webkit-search-cancel-button {
  display: none;
}
.header-search-clear {
  flex-shrink: 0;
  display: inline-flex;
  padding: 4px;
  color: var(--color-slate-soft);
  cursor: pointer;
}
.header-search-clear:hover {
  color: var(--color-ink);
}
.header-search {
  /* A key cap, set the way Cardinal sets every key. */
}
.header-search-kbd {
  flex-shrink: 0;
  padding: 2px 5px;
  background-color: var(--color-surface);
  border: 1px solid var(--color-hairline);
  color: var(--color-text-caption);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
/*
  Cobalt's header band is the same solid blue in light and dark, so its field, key cap and docked
  tags button stay the same translucent white in both. The `:not(.body--cobalt)` on the
  aesthetic-blind dark block below is what keeps the app's dark surface tones off them.
*/
body.body--cobalt .header-search-clear:hover {
  color: #fff;
}
body.body--cobalt .header-search-kbd {
  background-color: rgba(255, 255, 255, 0.18);
  border-color: transparent;
  border-radius: var(--radius-mark);
  color: #fff;
}

/*
  -> Flat, not nested inside a `.header-search` wrapper: a `&-field` shorthand there flattens the
     aesthetic class to a DESCENDANT of `.is-focused`, backwards from the real DOM where
     `body.body--cobalt` is always the top-level ancestor, so the rule can never match.
*/
body.body--cobalt .header-search-row-inline.is-focused .header-search-field {
  background-color: rgb(255 255 255 / 0.26);
  border-color: rgb(255 255 255 / 0.4);
  color: #fff;
}

body.body--cobalt .header-search-tags-btn,
body.body--cobalt .header-search-mode-btn {
  background-color: rgb(255 255 255 / 0.16);
  border-color: transparent;
  color: #fff;

  &:hover,
  &:focus-visible {
    background-color: rgb(255 255 255 / 0.26);
    color: #fff;
  }
}

/* -> Only the row's outer-right control gets the rounded corner. */
body.body--cobalt .header-search-tags-btn {
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
}

body.body--cobalt .header-search-mode-btn.is-active {
  background-color: rgb(255 255 255 / 0.32);
  color: #fff;
}

/*
  -> The other half of Cobalt's shared focus ring: without it the base cobalt button rule's
     see-through border wins and the buttons stay unchanged while the field lights up. The color
     matches the field's own focused border, so the row reads as one lit ring.
*/
body.body--cobalt .header-search-row-inline.is-focused .header-search-mode-btn,
body.body--cobalt .header-search-row-inline.is-focused .header-search-tags-btn {
  border-color: rgb(255 255 255 / 0.4);
}
.body--dark:not(.body--cobalt) .header-search-field {
  background-color: var(--color-dark-4);
  border-color: var(--color-hairline-dark);
  color: var(--color-text-caption-dark);
}
.body--dark:not(.body--cobalt) .header-search-lead {
  color: var(--color-slate-light);
}
.body--dark:not(.body--cobalt) .header-search-clear:hover {
  color: var(--color-text-dark);
}
.body--dark:not(.body--cobalt) .header-search-kbd {
  background-color: var(--color-dark-3);
  border-color: var(--color-hairline-dark);
  color: var(--color-text-caption-dark);
}

.body--dark:not(.body--cobalt) .header-search-row-inline.is-focused .header-search-field {
  background-color: var(--color-dark-3);
  border-color: var(--color-slate-light);
  color: var(--color-text-dark);
}

/*
  Docked to the field's trailing edge, sharing the field's own border rather than drawing a second
  one beside it, so the seam reads as one control. The two buttons share every rule here that does
  not depend on which end of the row a control sits at.
*/
.header-search-tags-btn,
.header-search-mode-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background-color: var(--color-paper);
  border: 1px solid var(--color-hairline);
  color: var(--color-slate-soft);
  font-size: 17px;
  cursor: pointer;
  transition:
    background-color 0.2s var(--ease-standard),
    color 0.2s var(--ease-standard),
    border-color 0.2s var(--ease-standard);

  &:hover,
  &:focus-visible {
    background-color: var(--color-tint);
    color: var(--color-ink);
  }
}

/*
  -> The mode button sits BETWEEN the field and the tags button, so it hands its trailing edge to
     the tags button's leading border -- the same "the earlier control omits the shared border, the
     later one draws it" rule `.header-search-field--docked` uses against this button.
*/
.header-search-mode-btn {
  border-inline-end: 0;
}

.header-search-mode-btn.is-active {
  background-color: var(--color-accent-wash);
  color: var(--color-accent-strong);
}

/*
  -> The field's trailing edge is never drawn (`--docked`); these two buttons draw the rest of it
     between them, so each needs its own border darkened for the focus ring to read as continuous.
*/
.header-search-row-inline.is-focused .header-search-tags-btn,
.header-search-row-inline.is-focused .header-search-mode-btn {
  border-color: var(--color-slate);
}

.body--dark:not(.body--cobalt) .header-search-tags-btn,
.body--dark:not(.body--cobalt) .header-search-mode-btn {
  background-color: var(--color-dark-4);
  border-color: var(--color-hairline-dark);
  color: var(--color-slate-light);

  &:hover,
  &:focus-visible {
    background-color: var(--color-dark-2);
    color: var(--color-text-dark);
  }
}

.body--dark:not(.body--cobalt) .header-search-mode-btn.is-active {
  background-color: var(--color-accent-wash-dark);
  color: var(--color-accent-dark);
}

.body--dark:not(.body--cobalt) .header-search-row-inline.is-focused .header-search-tags-btn,
.body--dark:not(.body--cobalt) .header-search-row-inline.is-focused .header-search-mode-btn {
  border-color: var(--color-slate-light);
}
/*
  Matched to the field's width by `inset-inline-*` against the wrapper rather than a width of its
  own, so the two cannot drift apart. Square top corners so the panel reads as a continuation of the
  header rather than a card floating under it.
*/
.searchpanel {
  position: absolute;
  top: 100%;
  inset-inline-start: 0;
  inset-inline-end: 0;
  z-index: 10;
  background-color: var(--color-surface);
  border: 1px solid var(--color-hairline);
  border-top: 0;
  color: var(--color-text-body);
  padding: 0.5rem 1rem 1rem;
  box-shadow: 0 8px 24px rgba(28, 34, 51, 0.12);
  /*
    A short viewport otherwise lets the panel grow past the bottom of the screen. 80px clears the
    toolbar above it (52px in `row` form, 64px inline) plus a margin.
  */
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}
.searchpanel-header {
  font-weight: 500;
  color: var(--color-text-caption);
  border-bottom: 1px solid var(--color-hairline);
  padding: 0 0 0.5rem 0;
  margin-bottom: 0.5rem;
  display: flex;
  align-items: center;
}
.searchpanel {
  /* -> Spinner beside its copy, not stacked above it. */
}
.searchpanel-status {
  gap: 8px;
}
.searchpanel-results {
  margin-bottom: 0.5rem;
}
.searchpanel {
  /* Plain `<button>`, not `w-btn`: it reads as a line of text, not as a UI control. */
}
.searchpanel-suggestion-link {
  display: block;
  margin-bottom: 0.5rem;
  color: inherit;
  opacity: 0.85;
  text-align: start;
  cursor: pointer;
  /* -> An unbounded page title, same as a result row's: ellipsis, not wrap. */
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.searchpanel-suggestion-link:hover {
  opacity: 1;
  text-decoration: underline;
}
.searchpanel-suggestion-link strong {
  font-weight: 600;
}
.searchpanel-tip + .searchpanel-tip {
  margin-top: 0.5rem;
}
.searchpanel {
  /*
    A `<button>` shrink-wraps its content rather than filling the row like the block-level headers
    beside it, so it needs `width: 100%`, plus its own cursor -- `.searchpanel-header` carries none.
  */
}
.searchpanel-operators-toggle {
  width: 100%;
  cursor: pointer;
  text-align: start;
}
.searchpanel-operators-arrow {
  transition: transform 0.3s var(--ease-standard);
}
@media (prefers-reduced-motion: reduce) {
  .searchpanel-operators-arrow {
    transition-duration: 0.01ms;
  }
}
.searchpanel {
  /* -> Set the way Cardinal sets every inline code run. */
}
.searchpanel code {
  background-color: var(--color-tint);
  border: 1px solid var(--color-hairline);
  color: var(--color-accent-strong);
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
}
.searchpanel {
  /* -> `.text-highlight` (the matched-term treatment) lives in `css/tailwind.css`'s */
  /*    `@layer components`, shared with the full results screen this panel previews. */
}
.body--dark .searchpanel {
  background-color: var(--color-dark-3);
  border-color: var(--color-hairline-dark);
  color: var(--color-text-dark);
}
.body--dark .searchpanel-header {
  color: var(--color-text-caption-dark);
  border-bottom-color: var(--color-hairline-dark);
}
.body--dark .searchpanel code {
  background-color: var(--color-accent-wash-dark);
  border-color: var(--color-hairline-dark);
  color: var(--color-accent-dark);
}
</style>
