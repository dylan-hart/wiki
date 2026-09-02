<template>
  <!--
    `row` is the phone form: the field is not squeezed between the site title and the header's
    buttons but has a row of the whole width to itself, opened from a search button. Slightly
    shorter than the header proper, so the two read as a bar and a drawer under it rather than as
    two headers.
  -->
  <w-toolbar :style="{ height: row ? `52px` : `64px` }" v-if="siteStore.features.search">
    <!--
      The positioning context for the panel below, and the width it matches. The toolbar cannot be
      it: the panel would then span the toolbar's padding as well, and with no positioned ancestor
      at all it stretched to the whole window.

      Full toolbar height rather than just the field's, with the field centred inside it, so that
      `top: 100%` on the panel lands on the bottom edge of the header instead of 12px above it.
    -->
    <div class="header-search relative flex h-full min-w-0 flex-1 flex-col justify-center">
      <div class="header-search-row-inline flex items-stretch">
        <div
          class="header-search-field"
          :class="{
            'is-focused': state.searchIsFocused,
            'header-search-field--row': row,
            'header-search-field--docked': !row
          }">
          <w-circular-progress
            v-if="siteStore.searchIsLoading && route.path !== `/_search`"
            class="header-search-lead"
            color="primary"
            size="18px" />
          <w-icon v-else class="header-search-lead" name="la:search" />

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
            `mousedown.prevent` keeps the press from pulling focus out of the input: the blur would
            swap the badge to its right (see below) and the resulting reflow shifts this button out
            from under the pointer before it can be released, eating the click.
          -->
          <button
            v-if="siteStore.search.length > 0"
            type="button"
            class="header-search-clear"
            :aria-label="t('common.actions.clear')"
            @mousedown.prevent
            @click="clearSearch">
            <w-icon name="la:times" />
          </button>
          <!--
            The shortcut hint doubles as the focus affordance, so it gives way to whatever the field
            has to say once it is in use.

            Never in `row` form: that is the phone field, opened by a button, and a keyboard shortcut is
            not something the device it exists for can offer. The focus test moves onto the branch below,
            which the chain used to get for free from this one.
          -->
          <span
            v-if="!row && !state.searchIsFocused"
            class="header-search-kbd"
            aria-hidden="true"
            @click="searchField.focus()">
            {{ searchShortcutHint }}
          </span>
          <span
            v-else-if="
              state.searchIsFocused &&
              siteStore.search &&
              siteStore.search !== siteStore.searchLastQuery
            "
            class="header-search-kbd">
            Press Enter
          </span>
        </div>

        <!--
          -> 2.5.x parity (OpenProject #987, #1120, #1218): docked flush against the search field's
             right edge so the two read as one continuous pill, matching the 2.5.x reference. Never
             in `row` form -- that is the phone field's own full-width row, with no room for a second
             control glued to it; the phone header falls back to `HeaderActionsMenu`'s overflow menu
             instead for its other icon buttons (see `HeaderNav`), and this one simply isn't offered
             there below the breakpoint.

          `la:tags` rather than the previous `la:hashtag`: a `#` glyph reads as an operator, not a
          tag, and doesn't match either the reference icon or every other tag control in the app
          (`PagePropertiesDialog.vue`, `Index.vue`).
        -->
        <router-link
          v-if="!row"
          to="/_tags"
          class="header-search-tags-btn"
          :aria-label="t('common.header.browseTags')">
          <w-icon name="la:tags" />
          <w-tooltip>{{ t('common.header.browseTags') }}</w-tooltip>
        </router-link>
      </div>

      <div class="searchpanel" ref="searchPanel" v-if="searchPanelIsShown">
        <!--
          The live-preview results, above the tag/operator content: they are what a query in progress
          is actually for, where the tips below are only ever relevant once the field is empty or the
          reader is stuck. Gated on `searchPreviewIsActive` (the same 2-character floor the fetch
          itself is gated on in the watcher below) so an empty or 1-character query -- `previewResults`
          freshly reset to `[]` by `resetPreview()` -- reads as "nothing typed yet", not as "searched
          and found nothing".
        -->
        <!--
          Independent of the loading/empty/found states below -- a shareable link is meaningful the
          moment there is a query at all, including below the 2-character preview floor where none of
          those three has anything to say yet. `mousedown.prevent` for the same reason as the clear
          button and result rows below: without it the field blurs before the click fires, closing the
          panel out from under it.
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
            icon="la:link"
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
          <!--
            Only ever present alongside a genuine zero-hit result: the backend computes `suggestion`
            solely when `totalHits === 0` and a query was given (see `search.suggestTitle()`), so no
            separate "active" gate is needed here beyond the field itself being set.

            `mousedown.prevent` for the same reason as the result rows and copy-link button above --
            without it the field blurs before the click fires, closing the panel first.
          -->
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
          <w-list dense dark class="searchpanel-results">
            <!--
              `mousedown.prevent` for the same reason as the clear button above: without it, pressing
              a row blurs the input first, which closes the panel (`searchPanelIsShown` goes false)
              before the click that would follow the mousedown ever fires.
            -->
            <w-item
              v-for="item of previewResultRows"
              :key="item.path"
              clickable
              :to="localizedPagePath(item.path, item.locale, siteStore.localeRouting)"
              @mousedown.prevent>
              <w-item-section avatar>
                <w-icon :name="item.icon || defaultPageIcon" />
              </w-item-section>
              <!--
                `lines="1"` on all three -- a title, path or excerpt long enough to wrap would grow the
                row past the panel's fixed width instead of the panel's own horizontal scrollbar it does
                not have; ellipsising keeps every row exactly as tall as its neighbours.
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

        <template v-if="siteStore.tagsLoaded && siteStore.tags.length > 0">
          <div class="searchpanel-header">
            <span>{{ t('common.header.popularTags') }}</span>
            <w-space />
            <w-btn class="acrylic-btn" flat :label="t('common.header.viewAll')" rounded size="xs" />
          </div>
          <div class="mb-4 flex flex-wrap gap-1">
            <w-chip
              v-for="tag of popularTags"
              :key="tag"
              square
              color="grey-8"
              text-color="white"
              icon="la:hashtag"
              size="sm"
              clickable
              @click="addTag(tag)">
              {{ tag }}
            </w-chip>
          </div>
        </template>
        <div class="searchpanel-header">{{ t('common.header.searchOperators') }}</div>
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
  </w-toolbar>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'

import { useSiteStore } from '@/stores/site'
import { DEFAULT_PAGE_ICON } from '@/stores/page'

import { orderBy } from 'es-toolkit/array'
import { debounce } from 'es-toolkit/function'
import { apiErrorMessage } from '@/helpers/apiError'
import { copyToClipboard } from '@/helpers/clipboard'
import { localizedPagePath } from '@/helpers/pagePaths'
import { isApplePlatform } from '@/helpers/platform'
import { notify } from '@/composables/notify'

/**
 * Below this many characters, `searchHint`'s copy in the panel is the whole answer -- tags and
 * operators, not results -- so a preview fetch would only be a request for `''`/`'a'` that the API
 * would happily run and every keystroke below the floor would refire it for nothing.
 */
const PREVIEW_QUERY_MIN_LENGTH = 2

/** A handful, not a page of them -- this is a live preview under the field, not the results screen. */
const PREVIEW_RESULTS_LIMIT = 5

/** Long enough that a fast typist's keystrokes collapse into one request, short enough to still feel live. */
const PREVIEW_DEBOUNCE_MS = 300

/**
 * The query with the operator/tag punctuation the panel's own tips describe stripped out: a leading
 * `!`/`-`/`#` on a word (exclusion, tag reference), and `"`/`*`/`,`/`|` wherever they occur (phrase
 * quoting, wildcard, OR). None of that is text to search FOR, so a query built entirely out of it --
 * `-a`, `#a`, `!"`, a bare `*` -- can clear `PREVIEW_QUERY_MIN_LENGTH` in raw length while carrying
 * under 2 real characters, which is exactly the query the floor exists to filter out.
 *
 * Used only to gate whether a preview fetch is worth firing; the raw, unstripped query is still what
 * actually gets sent -- the operators are real syntax to the backend's `websearch_to_tsquery`, not
 * noise to be cleaned up before it sees them.
 */
function realQueryLength(query) {
  return query
    .split(/\s+/)
    .map((token) => token.replace(/^[!\-#]+/, '').replaceAll(/["*,|]/g, ''))
    .join('').length
}

// PROPS

const props = defineProps({
  /**
   * Render as a row of its own rather than inline in the header bar. What the phone header opens;
   * see `HeaderNav`.
   */
  row: {
    type: Boolean,
    default: false
  }
})

// STORES

const siteStore = useSiteStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  searchIsFocused: false,
  previewResults: [],
  previewLoading: false,
  previewTotal: 0,
  /** The backend's "did you mean" title, only ever set alongside a real, zero-hit query. */
  previewSuggestion: null
})

const searchPanel = ref(null)
const searchField = ref(null)

/**
 * Bumped on every fetch that is started or invalidated. A response is only applied if this still
 * matches the token it was issued under -- otherwise a slower, earlier request landing after a
 * faster, later one would clobber the fresher results with stale ones.
 */
let previewRequestToken = 0

// COMPUTED

const searchPanelIsShown = computed(() => {
  return (
    state.searchIsFocused &&
    (siteStore.search !== siteStore.searchLastQuery || siteStore.search === '')
  )
})

const popularTags = computed(() => {
  return orderBy(siteStore.tags, ['usageCount'], ['desc']).map((t) => t.tag)
})

const defaultPageIcon = DEFAULT_PAGE_ICON

/**
 * `⌘K` on macOS/iOS/iPadOS, `Ctrl+K` everywhere else -- Ctrl+K is the OS-level emacs
 * kill-to-end-of-line binding on macOS, so the hint would otherwise tell Mac users to press a
 * combination that does something else entirely. A one-time read at mount, not a reactive watch:
 * the platform a session is running on does not change mid-session.
 */
const searchShortcutHint = isApplePlatform()
  ? t('common.header.searchShortcutMac')
  : t('common.header.searchShortcutOther')

/**
 * Whether the query is long enough for `state.previewResults` to actually mean something -- the same
 * floor the fetch watcher below is gated on, by real (operator/tag-stripped) length rather than raw
 * length. Below it, `resetPreview()` has left `previewResults` at `[]`, which is indistinguishable
 * from a real zero-hit search unless this is checked first.
 */
const searchPreviewIsActive = computed(() => {
  return realQueryLength(siteStore.search ?? '') >= PREVIEW_QUERY_MIN_LENGTH
})

/** Defensive cap to match the panel's "up to 5 rows" -- the API request already limits to this many. */
const previewResultRows = computed(() => state.previewResults.slice(0, PREVIEW_RESULTS_LIMIT))

// WATCHERS

watch(searchPanelIsShown, (newValue) => {
  if (newValue) {
    siteStore.fetchTags()
  }
})

/*
  Live preview, debounced -- only while the field is actually focused, so a query changed programmatically
  elsewhere (`addTag`, the `/_search` sync) does not start firing requests behind a panel nobody is
  looking at. Below the 2-character floor the panel already has something to say (`searchHint`'s tags and
  operators), so that range is left alone rather than asking the API to resolve `''` or a single letter.
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

// METHODS

/*
  Cmd+K (macOS/iOS) or Ctrl+K (everywhere else) focuses the field -- unless a full-screen overlay is
  up, in which case this header is behind it and the shortcut belongs to whatever is in front.
  FileManager has a search field of its own and claims it; the rest simply have nothing to focus, and
  pulling focus into a field the user cannot see is worse than the key doing nothing.
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
  if (route.path === '/_search') {
    router.replace({ path: '/_search', query: { q: siteStore.search } })
  } else {
    siteStore.searchIsLoading = true
    router.push({ path: '/_search', query: { q: siteStore.search } })
  }
}

function checkSearchFocus(ev) {
  if (!searchPanel.value?.contains(ev.relatedTarget)) {
    state.searchIsFocused = false
  }
}

/**
 * Put the caret in the field.
 *
 * Exposed because in `row` form the field is not focused by being mounted: focusing it is what draws
 * the panel below it, and a panel appearing mid-slide is layout and a `backdrop-filter` blur landing
 * in the middle of an animation. `HeaderNav` owns that transition, so it calls this when the slide has
 * finished -- see its `@after-enter`.
 */
function focus() {
  searchField.value?.focus()
}

/**
 * Clears the loading flag and the last-fetched preview, and invalidates any request still in flight --
 * a response that lands after this runs is for a query the field no longer holds, and would otherwise
 * overwrite the reset with stale results.
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
 * Runs the actual request. Not called directly outside this file -- `debouncedFetchPreview` below is
 * what the watcher drives, so a burst of keystrokes collapses into one call.
 */
async function fetchPreview(query) {
  const token = ++previewRequestToken
  state.previewLoading = true
  try {
    const resp = await API_CLIENT.get(`sites/${siteStore.id}/pages/search`, {
      searchParams: { query, limit: PREVIEW_RESULTS_LIMIT }
    }).json()
    // -> A newer request started (or the field was cleared/unmounted) while this one was in flight
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
    console.warn(apiErrorMessage(err))
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

/**
 * Copies a shareable link to the current search -- the same `q` query param `Search.vue`'s route
 * watcher already reads (`route.query.q`) -- to the clipboard. Mirrors `ApiKeyCopyDialog.vue`'s
 * `copyKey()`: try the copy, notify either way.
 */
async function copySearchLink() {
  const url = `${window.location.origin}/_search?q=${encodeURIComponent(siteStore.search)}`
  try {
    await copyToClipboard(url)
    notify({ type: 'positive', message: t('common.clipboard.success') })
  } catch (err) {
    notify({ type: 'negative', message: t('common.clipboard.failure'), caption: err.message })
  }
}

/**
 * Replaces the query with the "did you mean" suggestion and re-runs the search.
 *
 * Just an assignment: `siteStore.search` is what the live-preview watcher above already tracks, and
 * the field stays focused (the suggestion link's `@mousedown.prevent` kept it that way), so the
 * watcher's own gate on `state.searchIsFocused` fires it exactly the way typing would.
 */
function applySuggestion() {
  if (!state.previewSuggestion) {
    return
  }
  siteStore.search = state.previewSuggestion
  searchField.value?.focus()
}

function addTag(tag) {
  if (!siteStore.search.includes(`#${tag}`)) {
    siteStore.search = siteStore.search ? `${siteStore.search} #${tag}` : `#${tag}`
  }
  searchField.value.focus()
}

// MOUNTED

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

<style lang="scss">
/*
  The header search box.

  Deliberately not built on WInput: that is a form field -- label, hint line, error line, inset
  focus ring -- and this is none of those. It is a pill on a dark bar that inverts when you use it,
  so it owns its own markup and styling rather than fighting a component's.
*/
.header-search {
  &-field {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 8px 0 12px;
    border-radius: 9999px;
    background-color: #212121;
    color: rgba(255, 255, 255, 0.85);
    transition:
      background-color 0.25s var(--ease-standard),
      color 0.25s var(--ease-standard);
  }

  /*
    Docked against the tags button below (never in `row` form, which stands alone) -- squares off
    the right corners so the seam between the two doesn't double-round, leaving only the left half
    of the pill.
  */
  &-field--docked {
    border-radius: 9999px 0 0 9999px;
  }

  /*
    In `row` form, a wash of black over whatever is behind rather than a grey of its own.

    The row is the site's sidebar colour (see `HeaderNav`), which is the site's to choose -- so a fixed
    grey is a slab of a foreign colour sitting on it, right for one theme and wrong for the rest. A
    translucent black darkens whatever it is given and reads as a well sunk into the row on any of them.

    The inline form keeps its grey: it sits on the HEADER, which is black by default, and a translucent
    black on black is no field at all.
  */
  &-field--row {
    background-color: rgb(0 0 0 / 0.25);
  }

  /*
    In use, the field inverts: white fill, dark ink. Driven by a class rather than `:focus-within`
    so it stays inverted while the panel below is being used -- clicking a tag in there moves focus
    out of the input, and the field flickering back to dark mid-interaction reads as a glitch.

    Two classes, so this outranks the `--row` wash above whichever order they end up in.
  */
  &-field.is-focused {
    background-color: #fff;
    color: rgba(0, 0, 0, 0.87);
  }

  &-lead {
    flex-shrink: 0;
    font-size: 20px;
    opacity: 0.7;
  }

  &-input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    outline: none;

    &::placeholder {
      color: currentColor;
      opacity: 0.55;
    }
    /* -> the UA's own clear affordance would sit beside ours */
    &::-webkit-search-cancel-button {
      display: none;
    }
  }

  &-clear {
    flex-shrink: 0;
    display: inline-flex;
    padding: 4px;
    border-radius: 9999px;
    color: inherit;
    opacity: 0.6;
    cursor: pointer;

    &:hover {
      opacity: 1;
    }
  }

  /* Sits inside the pill, against its fill, so it inverts with everything else */
  &-kbd {
    flex-shrink: 0;
    /* -> pulls it clear of the pill's edge, where the two mismatched radii read as a kink */
    margin-right: 2px;
    padding: 2px 8px;
    border: 1px solid currentColor;
    border-radius: 9999px;
    font-size: 11px;
    line-height: 1.4;
    white-space: nowrap;
    opacity: 0.5;
    cursor: pointer;
    user-select: none;
  }
}

/*
  The browse-by-tags button docked to the search field's right edge (OpenProject #987, #1120,
  #1218) -- same fixed 40px height and dark fill as `.header-search-field`, so the seam between the
  two reads as one continuous pill rather than a field with a detached button beside it. Only the
  right corners are rounded; the left edge butts flush against the field's now-square right edge.
*/
.header-search-tags-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 0 9999px 9999px 0;
  background-color: #212121;
  color: rgba(255, 255, 255, 0.85);
  font-size: 20px;
  transition: background-color 0.25s var(--ease-standard);

  &:hover,
  &:focus-visible {
    background-color: #2f2f2f;
  }
}

/*
  Hangs off the field, matching its width -- `left: 0; right: 0` against the wrapper rather than a
  width of its own, so the two cannot drift apart.

  The wrapper is the full height of the header, so `top: 100%` puts the panel flush against its
  bottom edge; square top corners then read as a continuation of the header rather than a card
  floating under it.
*/
.searchpanel {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 10;
  background-color: rgba(0, 0, 0, 0.7);
  border-radius: 0 0 12px 12px;
  color: #fff;
  padding: 0.5rem 1rem 1rem;
  backdrop-filter: blur(7px) saturate(180%);
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.2),
    0 1px 1px rgba(0, 0, 0, 0.14),
    0 2px 1px -1px rgba(0, 0, 0, 0.12);
  /*
    A short viewport (a phone in `row` form, or any window a reader has made shorter than its width)
    otherwise lets the panel grow past the bottom of the screen once results are added on top of the
    tag/operator content -- there was no cap on it before because that content alone never got tall
    enough to matter. 80px leaves room for the toolbar above it (52px in `row` form, 64px inline) plus
    a margin, so the panel never quite touches the edge of the viewport it is measured against.
  */
  max-height: calc(100vh - 80px);
  overflow-y: auto;

  &-header {
    font-weight: 500;
    border-bottom: 1px solid rgba(255, 255, 255, 0.2);
    padding: 0 0 0.5rem 0;
    margin-bottom: 0.5rem;
    display: flex;
    align-items: center;
  }

  /* -> The loading header's spinner sits beside its copy rather than above it */
  &-status {
    gap: 8px;
  }

  &-results {
    margin-bottom: 0.5rem;
  }

  /* Plain `<button>`, not `w-btn` -- it reads as a line of text within the empty-preview state, not a UI control */
  &-suggestion-link {
    display: block;
    margin-bottom: 0.5rem;
    color: inherit;
    opacity: 0.85;
    text-align: left;
    cursor: pointer;
    /* -> The suggested title is unbounded page content, same as a result row's -- ellipsis, not wrap/overflow */
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;

    &:hover {
      opacity: 1;
      text-decoration: underline;
    }

    strong {
      font-weight: 600;
    }
  }

  &-tip {
    + .searchpanel-tip {
      margin-top: 0.5rem;
    }
  }

  code {
    background-color: rgba(0, 0, 0, 0.7);
    padding: 2px 8px;
    font-weight: 700;
    border-radius: 4px;
  }

  // -> `.text-highlight` (the matched-term `<b>` treatment) lives in `css/tailwind.css`'s
  //    `@layer components`, shared with `Search.vue`'s full results screen this panel previews.
}
</style>
