<template>
  <div ref="containerRef" class="graph-view">
    <canvas
      ref="canvasRef"
      class="graph-view-canvas"
      role="img"
      :aria-label="graphAccessibleName"
      @click="onCanvasClick"
      @mousemove="onCanvasMouseMove">
      <!--
        Canvas fallback content (OpenProject #1686): a visually-hidden ("sr-only", the same
        Tailwind utility `CollabPresence.vue` uses) but focusable text alternative to the painted
        graph, for keyboard and screen-reader access -- one entry per REAL node (a synthetic
        folder/root node has no page to link to, so it never gets a top-level entry of its own),
        each an `<a>` to that node's page, with its direct graph-neighbors listed underneath: a
        real neighbor as another `<a>`, a synthetic one as plain text. Reuses
        `nodes.value`/`edges.value` -- the same currently-visible set the canvas draws, already
        shaped by `groupBy`/`activeFilters` -- rather than fetching or deriving anything
        separately, so the alternative always describes what is actually on screen.
      -->
      <ul class="graph-view-fallback sr-only">
        <li v-for="entry in fallbackNodes" :key="entry.node.path">
          <a :href="fallbackHref(entry.node)" @click.prevent="navigateToNode(entry.node)">{{
            entry.node.title || entry.node.path
          }}</a>
          <ul v-if="entry.links.length">
            <li v-for="link in entry.links" :key="link.path">
              <a
                v-if="!link.synthetic"
                :href="fallbackHref(link)"
                @click.prevent="navigateToNode(link)"
                >{{ link.title || link.path }}</a
              >
              <span v-else>{{ link.title || link.path }}</span>
            </li>
          </ul>
        </li>
      </ul>
    </canvas>
    <div
      v-if="hoveredNode"
      class="graph-view-tooltip"
      :style="{ left: `${tooltipPos.x + 12}px`, top: `${tooltipPos.y + 12}px` }">
      {{ hoveredNode.title ?? hoveredNode.path }}
      <template v-if="sizeBy === 'edits' && !hoveredNode.synthetic">
        ·
        {{
          t(tooltipKeyFor(), contributorCountFor(hoveredNode), {
            count: contributorCountFor(hoveredNode)
          })
        }}
      </template>
      <template v-if="sizeBy === 'visits' && !hoveredNode.synthetic">
        ·
        {{
          t(tooltipKeyFor(), pageviewCountFor(hoveredNode), {
            count: pageviewCountFor(hoveredNode)
          })
        }}
      </template>
    </div>
    <div v-if="graphTruncated" class="graph-view-truncation-notice">
      Showing {{ allNodes.length }} of {{ totalNodes }} pages. Filters and search apply only to the
      pages shown here, not the full site.
    </div>
    <div class="graph-view-right-rail">
      <div class="graph-view-controls">
        <div class="graph-view-control-group">
          <span class="graph-view-control-caption">{{ t('graph.controls.groupByLabel') }}</span>
          <w-btn-toggle
            v-model="groupBy"
            :aria-label="t('graph.controls.groupByLabel')"
            :options="groupByOptions" />
        </div>
        <div class="graph-view-control-group">
          <span class="graph-view-control-caption">{{ t('graph.controls.sizeByLabel') }}</span>
          <w-btn-toggle
            v-model="sizeBy"
            :aria-label="t('graph.controls.sizeByLabel')"
            :options="sizeByOptions" />
        </div>
        <div class="graph-view-control-group">
          <span class="graph-view-control-caption">{{ t('graph.controls.countLabel') }}</span>
          <w-btn-toggle
            v-model="sizeCountMode"
            :aria-label="t('graph.controls.countAriaLabel')"
            :options="sizeCountModeOptions" />
        </div>
        <GraphClientTypeFilter
          v-if="sizeBy === 'edits'"
          v-model="contributorTypes"
          :label="t('graph.controls.editsByLabel')"
          :options="contributorTypeOptions" />
        <div v-if="sizeBy === 'visits'" class="graph-view-control-group">
          <span class="graph-view-control-caption">{{ t('graph.controls.overLabel') }}</span>
          <w-btn-toggle
            v-model="pageviewsWindow"
            :aria-label="t('graph.controls.overAriaLabel')"
            :options="pageviewsWindowOptions" />
        </div>
        <GraphClientTypeFilter
          v-if="sizeBy === 'visits'"
          v-model="pageviewClientTypes"
          :label="t('graph.controls.visitsByLabel')"
          :options="pageviewClientTypeOptions" />
      </div>
    </div>
    <div class="graph-view-filters">
      <w-input v-model="keywordQuery" clearable dense :label="t('graph.filters.keyword')" />
      <w-select
        v-model="activeFilters.tags"
        multiple
        use-chips
        dense
        options-dense
        :options="tagOptions"
        :label="t('graph.filters.tags')" />
      <div class="flex flex-col gap-1">
        <span class="text-caption opacity-70">{{ t('graph.filters.folderDepth') }}</span>
        <div class="flex items-center gap-3">
          <w-range
            v-model="folderDepthSlider"
            single
            markers
            :min="0"
            :max="actualMaxFolderDepth"
            :aria-label="t('graph.filters.folderDepth')"
            class="min-w-0 flex-1" />
          <div style="width: 64px">
            <w-input
              v-model.number="folderDepthSlider"
              dense
              type="number"
              min="0"
              :max="actualMaxFolderDepth"
              hide-bottom-space
              :aria-label="t('graph.filters.folderDepth')" />
          </div>
        </div>
      </div>
      <w-select
        v-if="showLocaleFilter"
        v-model="activeFilters.locale"
        dense
        options-dense
        :options="localeOptions"
        :label="t('graph.filters.locale')" />
      <w-btn
        v-if="
          activeFilters.tags.length ||
          activeFilters.folderDepth !== actualMaxFolderDepth ||
          activeFilters.locale
        "
        flat
        dense
        :label="t('graph.filters.clear')"
        @click="clearFilters" />
      <div class="graph-view-legend">
        <div v-for="entry in legendEntries" :key="entry.key" class="graph-view-legend-item">
          <span class="graph-view-legend-swatch" :style="{ backgroundColor: entry.color }" />
          <span class="graph-view-legend-label">{{ entry.key }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import {
  computed,
  markRaw,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch
} from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { forceCenter, forceCollide } from 'd3-force'
import { quadtree as d3quadtree } from 'd3-quadtree'
import { zoomIdentity } from 'd3-zoom'
import { debounce } from 'es-toolkit/function'
import { apiErrorMessage } from '@/helpers/apiError'
import { localizedPagePath } from '@/helpers/pagePaths'
import { useDark } from '@/composables/dark'
import { useSiteStore } from '@/stores/site'
import GraphClientTypeFilter from '@/components/GraphClientTypeFilter.vue'
import {
  buildPathHierarchyEdges,
  computeHighlightedNodeIds,
  computeTitleMatchNodeIds,
  computeVisibleSubset,
  deriveFilterOptions,
  deriveMaxFolderDepth
} from './graphFilters.js'
import { paintGraph } from './graphDraw.js'
import { lerpRadius, sqrtRangeOf } from './graphNodeSize.js'
import {
  attachZoom as attachGraphZoom,
  computeClusters as buildClusters,
  startSimulation as runSimulation
} from './graphSimulation.js'

/**
 * The knowledge graph view (OpenProject #848/#873): a full-viewport, canvas-rendered force graph
 * of every page the caller may read on this site. Fetched once on mount -- every filter and
 * re-cluster after that (#874/#875) runs against `nodes`/`edges` already in memory, no further
 * network round trip.
 */

const siteStore = useSiteStore()
const router = useRouter()
const { t } = useI18n()
const dark = useDark()

const containerRef = ref(null)
const canvasRef = ref(null)

/** Raw payload from `GET sites/{siteId}/graph` -- see `backend/api/graph.ts#Graph`.
 *
 *  `shallowRef` (not `ref`) plus `markRaw()` on every element (see `loadGraph()`/`applyFilters()`)
 *  keeps these arrays and the node/edge objects inside them out of Vue's reactivity system
 *  entirely (OpenProject #1837). Nothing renders off them reactively -- the graph is canvas-only --
 *  but `forceSimulation`/`forceLink` write `x`/`y`/`vx`/`vy` on every node on every tick and
 *  `forceCollide`/`forceManyBody` read node properties constantly inside their quadtrees; with a
 *  plain `ref`, every one of those reads/writes goes through a reactive proxy's get/set traps for
 *  data nothing ever subscribes to. Both assignment sites below (`loadGraph()`,
 *  `applyFilters()`) reassign `.value` wholesale rather than mutating in place, so the two real
 *  consumers -- `legendEntries` and `hoveredNode`, both plain reads -- still update correctly off a
 *  shallow ref with no explicit `triggerRef()` needed. */
const nodes = shallowRef([])
const edges = shallowRef([])
const isLoading = ref(true)
const loadError = ref(null)

/** The full, unfiltered graph as fetched -- kept separate from `nodes.value`/`edges.value`, which
 *  after Task 26 (#901) are the CURRENTLY VISIBLE subset the simulation actually runs on. */
const allNodes = shallowRef([])
const allEdges = shallowRef([])

/** Server-side truncation signal (OpenProject #1866): `assembleGraph` caps the node set at
 *  `GRAPH_NODE_CAP` and reports whether it had to. `totalNodes` is the true readable-page count
 *  even when truncated, so the notice below (OpenProject #1875) can say how much was cut, not just
 *  that some was. */
const graphTruncated = ref(false)
const totalNodes = ref(0)

/** 'site' is deliberately not an option here -- see the spec's architecture note: a single loaded
 *  graph has exactly one site value, so grouping by it would be a no-op UI control. */
const groupBy = ref('folder')

/** Node-sizing dimension (OpenProject #1141/#1269): 'edits' (default), which scales a node's radius
 *  by its contributor count, or 'visits', by its pageview count -- see `radiusFor()`. There is no
 *  'uniform' mode any more (OpenProject #1270 dropped it): every real node is always sized by one
 *  of these two dimensions. */
const sizeBy = ref('edits')

/** Whether 'edits'/'visits' sizing (and the hover tooltip's count) reads the unique-identity figure
 *  or the raw row-count figure (OpenProject #1269's backend fields, #1270's toggle) --
 *  `contributorCountFor()`/`pageviewCountFor()` are the single place this is read. */
const sizeCountMode = ref('unique')

/** Which of `pageHistory.via`'s buckets count toward 'edits' sizing -- both checked by default,
 *  which reads the backend's pre-unioned `contributors.all` rather than adding the two buckets
 *  together (see `contributorCountFor()`). Irrelevant while `sizeBy` is 'visits', but kept around
 *  rather than reset, so switching back to 'edits' remembers the last filter chosen. */
const contributorTypes = ref(['editor', 'mcp'])

/** Whether pageview tracking is on at all (OpenProject #1238's admin opt-out,
 *  `WIKI.config.pageviews.isEnabled`, read via `GET system/pageviews` same as `AdminPageviews.vue`
 *  does). While off, nothing is being logged, so 'visits' sizing has no data to point at --
 *  `sizeByOptions` below omits the option entirely rather than showing a control for data that
 *  doesn't exist (OpenProject #1140's own scope decision). Defaults to `false` until the check
 *  resolves, which is the safe default: hidden-until-proven-on, not shown-until-proven-off. */
const pageviewsTrackingEnabled = ref(false)

/** 'Size by' control options (OpenProject #1141's 'edits', plus #1140's 'visits') -- a computed
 *  rather than a static template literal so 'visits' can be omitted while pageview tracking is
 *  disabled. No 'uniform' option any more (OpenProject #1270). */
const sizeByOptions = computed(() => {
  const options = [{ label: t('graph.controls.sizeByEdits'), value: 'edits' }]
  if (pageviewsTrackingEnabled.value) {
    options.push({ label: t('graph.controls.sizeByVisits'), value: 'visits' })
  }
  return options
})

/** Static `w-btn-toggle`/`GraphClientTypeFilter` option lists for the rest of the control rail
 *  (OpenProject #1690) -- computed, not module-level constants, so each label re-resolves through
 *  `t()` if the active locale changes at runtime. */
const groupByOptions = computed(() => [
  { label: t('graph.controls.groupByFolder'), value: 'folder' },
  { label: t('graph.controls.groupByTag'), value: 'tag' },
  { label: t('graph.controls.groupByClassification'), value: 'classification' }
])
const sizeCountModeOptions = computed(() => [
  { label: t('graph.controls.countUnique'), value: 'unique' },
  { label: t('graph.controls.countTotal'), value: 'total' }
])
const contributorTypeOptions = computed(() => [
  { value: 'editor', label: t('graph.controls.editsByEditor') },
  { value: 'mcp', label: t('graph.controls.editsByMcp') }
])
const pageviewsWindowOptions = computed(() => [
  { label: t('graph.controls.over30Days'), value: 'last30d' },
  { label: t('graph.controls.over6Months'), value: 'last6mo' },
  { label: t('graph.controls.over2Years'), value: 'last2yr' }
])
const pageviewClientTypeOptions = computed(() => [
  { value: 'browser', label: t('graph.controls.visitsByBrowser') },
  { value: 'api', label: t('graph.controls.visitsByApi') },
  { value: 'mcp', label: t('graph.controls.visitsByMcp') }
])

/** Which of the pageview log's fixed trailing windows (OpenProject #1140/#1238) 'visits' sizing
 *  reads -- matches `backend/models/pageviews.ts#pageviewWindows`. Irrelevant while `sizeBy` isn't
 *  'visits', same "kept around, not reset" reasoning as `contributorTypes`. */
const pageviewsWindow = ref('last30d')

/** Which pageview `clientType`s count toward 'visits' sizing -- all three checked by default. See
 *  `pageviewCountFor()` for why summing the checked buckets is exact here (unlike
 *  `contributorCountFor()`'s editor/mcp union, which needs the backend's precomputed `all`). */
const pageviewClientTypes = ref(['browser', 'api', 'mcp'])

/** Drill-down filter state (OpenProject #875): the AND of whichever of these are non-empty narrows
 *  the visible node/edge subset -- see `graphFilters.js#computeVisibleSubset` (Task 25). `'site'` is
 *  deliberately not a field here, same reasoning as `groupBy` above: a single loaded graph has
 *  exactly one site value, so filtering by it would be a no-op. */
const activeFilters = reactive({
  tags: [],
  /** No more `null`-means-"All" sentinel (OpenProject #2525) -- seeded to `actualMaxFolderDepth`
   *  once the graph loads (see `loadGraph()`), a concrete depth functionally equivalent to the old
   *  "All" for the currently-loaded graph. `0` here is only the brief pre-load placeholder, same
   *  window `actualMaxFolderDepth` itself reads `0` in before the fetch resolves. */
  folderDepth: 0,
  locale: null
})

/** The graph filter panel's keyword search box (OpenProject #2478, Feature #2414), bound to the
 *  `w-input` below and, via the `watch()` further down, the single source ref driving the whole
 *  keyword-search pipeline (OpenProject #2508 unified this with the `graphKeyword`/`keywordMatchIds`
 *  refs #2479/#2480 each introduced independently -- three refs for two states, never spliced
 *  together, was the bug). Deliberately kept OUTSIDE `activeFilters` above: that object drives
 *  `computeVisibleSubset()`'s AND-narrowing (a node failing any active tag/folder-depth/locale filter
 *  is hidden), while a keyword match is meant to HIGHLIGHT matching nodes without hiding the rest --
 *  a different behavior the epic spec calls out explicitly. */
const keywordQuery = ref('')

/** Resets every filter to its default -- the `activeFilters` watcher (Task 26/#901) fires
 *  automatically once these change, no separate wiring needed here. `keywordQuery` is deliberately
 *  not reset here: it isn't one of the narrowing filters this button/action targets (see its own doc
 *  comment above), and its own `w-input`'s `clearable` affordance already covers resetting it. */
function clearFilters() {
  activeFilters.tags = []
  activeFilters.folderDepth = actualMaxFolderDepth.value
  activeFilters.locale = null
}

/** Keyword search results driving the graph's highlight (OpenProject #2480, Feature #2414's third
 *  task) -- deliberately separate from `activeFilters` above: a keyword match HIGHLIGHTS matching
 *  nodes rather than narrowing which ones are visible, so it never feeds `computeVisibleSubset`.
 *  Each entry needs only `path`/`locale`, the shape `GET sites/:siteId/pages/search` returns per
 *  result (`backend/modules/search/shared.ts#SearchDocument`) -- populated by `searchKeyword()`
 *  below, the same function `keywordQuery`'s `watch()` debounces into. `shallowRef` (not `ref`), same
 *  reasoning as `allNodes`/`allEdges` above: nothing reads an individual match's fields reactively,
 *  only the whole array via `highlightedNodeIds` below -- so every assignment to it must be a new
 *  array (never a mutation), or the `watch(keywordMatches, repaint)` further down won't fire. */
const keywordMatches = shallowRef([])

/** OpenProject #2533: a second, thin, purely CLIENT-SIDE highlight pass alongside the backend
 *  full-text search above -- a case-insensitive substring check of `keywordQuery` against every
 *  currently-loaded node's `title` (`allNodes`, already in memory, no extra request). The backend's
 *  `websearch_to_tsquery` engine matches stemmed lexemes, not substrings, so a partial word typed
 *  mid-token doesn't reliably highlight a page whose TITLE plainly contains it -- this fills that
 *  gap without touching the backend search's own semantics (site-wide search still goes through
 *  `searchKeyword()` unchanged). See `graphFilters.js#computeTitleMatchNodeIds`. Synchronous and
 *  reactive off `keywordQuery`/`allNodes` directly -- no debounce needed, unlike the backend pass. */
const titleMatchNodeIds = computed(() =>
  computeTitleMatchNodeIds(allNodes.value, keywordQuery.value)
)

/** The composite `${locale}:${path}` id of every currently-visible node either the backend keyword
 *  search (`keywordMatches`) or the client-side title-contains pass (`titleMatchNodeIds`, #2533)
 *  matched -- the union of both, deduped via `Set`. See `graphFilters.js#computeHighlightedNodeIds`.
 *  Empty whenever both sources are (no search active yet, or a search that matched nothing by
 *  either method), which is also what tells `repaint()`'s `paintGraph()` call to draw every node at
 *  full strength with no highlight ring, same as before this WP existed. */
const highlightedNodeIds = computed(
  () => new Set([...computeHighlightedNodeIds(keywordMatches.value), ...titleMatchNodeIds.value])
)

/** The tag/locale values offered by the filter panel's `w-select`s, derived from `allNodes` (the
 *  full fetched graph, not the currently-filtered `nodes.value`) -- no separate endpoint
 *  (OpenProject #899). Deriving from `allNodes` rather than `nodes` matters once Task 26 (#901)
 *  redefines `nodes.value` as the currently-VISIBLE subset: options must stay the full universe of
 *  choices, or picking one filter (say, a locale) would shrink another filter's own dropdown (say,
 *  tags) down to whatever survived it, silently hiding tags the viewer could otherwise combine. */
const filterOptions = computed(() => deriveFilterOptions(allNodes.value))
const tagOptions = computed(() => filterOptions.value.tags)
const localeOptions = computed(() => filterOptions.value.locales)

/** The deepest folder actually present in the currently loaded graph (OpenProject #2514/#2520:
 *  replacing the folder-depth number input with a slider) -- derived from `allNodes`, the same
 *  full-universe source `filterOptions` above uses, not the currently-filtered `nodes.value`, for
 *  the same "narrowing one filter shouldn't shrink another's own range" reasoning that computed's
 *  own doc comment gives. Already capped at `graphFilters.js`'s `MAX_DEPTH` ceiling by
 *  `deriveMaxFolderDepth` itself, so the depth control (`folderDepthSlider` below, #2525) sizes its
 *  own `max` off this value directly, with no extra ceiling of its own to apply.
 *
 *  Before the initial graph fetch resolves, `allNodes.value` is still `[]` and this reads `0` --
 *  indistinguishable from a real, fully-flat graph. A caller must gate on `isLoading` (above)
 *  rather than trust `0` alone as meaning "this graph has no folders," or it will render a
 *  broken/0-step control while the graph is still loading. */
const actualMaxFolderDepth = computed(() => deriveMaxFolderDepth(allNodes.value))

/** Two-way bridge between the depth control (the `w-range` slider and its adjacent `w-input`
 *  number field, sharing this one v-model) and `activeFilters.folderDepth` -- clamped to
 *  `[0, actualMaxFolderDepth]` on every write (OpenProject #2525 dropped the old `null`-means-"All"
 *  sentinel entirely, so there is no more position offset to bridge: a depth value IS the control's
 *  position now). Clamping here, rather than trusting the `w-input`'s `min`/`max` HTML attributes
 *  alone, is what keeps `activeFilters.folderDepth` always valid even against a hand-typed
 *  out-of-range or non-numeric value in the number field. */
const folderDepthSlider = computed({
  get: () => activeFilters.folderDepth,
  set: (value) => {
    activeFilters.folderDepth = Math.min(
      actualMaxFolderDepth.value,
      Math.max(0, Math.round(Number(value) || 0))
    )
  }
})

/** Whether the locale filter control is worth showing at all (OpenProject #2294): gated on both the
 *  reader-facing locale-switcher setting AND there being more than one locale actually represented
 *  among the loaded nodes -- `showMenu` alone says nothing about how many locales the site has, so a
 *  single-locale site with the menu enabled would otherwise render a `w-select` whose one option is
 *  always a no-op, the same class of dead control `groupBy` already avoids for site grouping (see
 *  that const's own doc comment above). Derived from `localeOptions`, which is itself derived from
 *  `allNodes` (the full loaded graph, not the currently-filtered set -- see `filterOptions`' own
 *  doc comment two computeds above), so this reacts to how many locales the full graph actually
 *  has, not to the currently-narrowed tags/folderDepth/locale filters: picking a locale, or any
 *  other filter, never makes this control disappear on its own. It only hides once the underlying
 *  graph itself is reloaded down to a single locale, or the site setting is off. */
const showLocaleFilter = computed(
  () => siteStore.locales.showMenu && localeOptions.value.length > 1
)

/** How long to wait after the last keystroke before firing the keyword search (OpenProject #2479)
 *  -- same debounce window as the header search's own live preview (`HeaderSearch.vue`). */
const KEYWORD_SEARCH_DEBOUNCE_MS = 300

/** The search endpoint's own maximum `limit` (`backend/api/pages/read.ts`'s `/sites/:siteId/pages/
 *  search`), used as-is so as many of the currently-loaded graph's matches as the endpoint can
 *  return in one page get highlighted. A keyword matching more pages than this only has its top 100
 *  (by relevancy) highlighted -- accepted the same way the graph's own node cap is (see
 *  `graphTruncated` above) rather than paginating a highlight overlay. */
const KEYWORD_SEARCH_LIMIT = 100

/** Bumped on every keyword fetch started or invalidated -- same stale-response guard
 *  `HeaderSearch.vue`'s live preview uses (`previewRequestToken`), so a slower, earlier request
 *  landing after a faster, later one can't clobber fresher results with stale ones. */
let keywordSearchToken = 0

/** Runs the actual request. Not called directly outside the watcher below --
 *  `debouncedSearchKeyword` is what a burst of keystrokes collapses into one call through. */
async function searchKeyword(query) {
  const token = ++keywordSearchToken
  try {
    const resp = await API_CLIENT.get(`sites/${siteStore.id}/pages/search`, {
      searchParams: { query, limit: KEYWORD_SEARCH_LIMIT }
    }).json()
    // -> A newer keyword (or a clear) started while this request was in flight.
    if (token !== keywordSearchToken) {
      return
    }
    keywordMatches.value = resp?.results ?? []
  } catch (err) {
    if (token !== keywordSearchToken) {
      return
    }
    keywordMatches.value = []
    console.warn(apiErrorMessage(err))
  }
}

const debouncedSearchKeyword = debounce(searchKeyword, KEYWORD_SEARCH_DEBOUNCE_MS)

/**
 * Wires the filter panel's `keywordQuery` input (OpenProject #2478) to `searchKeyword()` (#2479),
 * which populates `keywordMatches` (#2480) -- see `keywordQuery`'s own doc comment above for why
 * this WP (#2508) unified what used to be three disconnected refs into these two.
 *
 * Deliberately NOT a field on `activeFilters` above: everything in that object narrows the VISIBLE
 * node set (`computeVisibleSubset`) and is deep-watched to re-run `applyFilters()`/
 * `syncSimulationToVisibleSet()` on every change, but a keyword match highlights matching nodes
 * rather than filtering non-matching ones out of view (the Feature's own scope decision) --
 * folding it into `activeFilters` would re-layout the whole graph on every keystroke for no reason,
 * and would need `computeVisibleSubset` to special-case it back out again.
 */
watch(keywordQuery, (newKeyword) => {
  const query = (newKeyword ?? '').trim()
  if (!query) {
    debouncedSearchKeyword.cancel()
    // -> Invalidates any request already in flight for a since-cleared keyword, the same way
    //    `keywordSearchToken++` alone (with no direct state reset) guards a stale FETCH -- this is
    //    the synchronous counterpart for a keyword cleared outright rather than merely changed.
    keywordSearchToken++
    keywordMatches.value = []
    return
  }
  debouncedSearchKeyword(query)
})

function groupKeyFor(node) {
  if (groupBy.value === 'tag') {
    return node.tags?.[0] ?? '(untagged)'
  }
  if (groupBy.value === 'classification') {
    return node.classification ?? '(unclassified)'
  }
  return node.folder || '(root)'
}

/** Accessible name for the canvas (OpenProject #1681) -- with no `role`/label at all, a screen
 *  reader announces the graph as nothing, so this is the minimum text alternative: a live summary
 *  of what's currently drawn. Reads `nodes.value`/`edges.value`/`groupBy` -- already-held reactive
 *  state, no separate computation -- and excludes synthetic folder/root nodes (`applyFilters()`'s
 *  path-hierarchy stand-ins, never real pages) from the page count. `groupBy`'s own values
 *  ('folder'/'tag'/'classification') already read as the words used here, so no separate label
 *  lookup is needed for that part; a real focusable text alternative (per-node links) is #1686's
 *  larger scope. The sentence is sourced from `graph.*` i18n keys (OpenProject #1690, #2359) --
 *  split into three pieces rather than one interpolated template because it carries two
 *  independently-pluralized counts, the same `"{count} x | {count} xs"` pipe convention
 *  `graph.tooltip.*` already uses for the hover tooltip below. */
const graphAccessibleName = computed(() => {
  const pageCount = nodes.value.filter((node) => !node.synthetic).length
  const linkCount = edges.value.length
  return t('graph.accessibleName.summary', {
    pages: t('graph.accessibleName.page', pageCount, { count: pageCount }),
    links: t('graph.accessibleName.link', linkCount, { count: linkCount }),
    groupBy: groupBy.value
  })
})

/*
  The `dataviz` skill's validated 8-slot categorical theme (references/palette.md), in the skill's
  own fixed (CVD-safe adjacent-pair) order -- assigned in that order as new group keys are first
  seen, never reordered per group. Light is the palette's light-surface column; dark is its
  dark-surface column -- the same eight hues stepped for the dark surface, not a separate palette
  (OpenProject #2412: `colorForGroup()` below picks the column live off `dark.isActive`, and
  `drawEdges()`/`drawLabels()` in `graphDraw.js` carry their own light/dark stroke/fill pair the
  same way).
*/
const CATEGORICAL_PALETTE_LIGHT = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948' // red
]
const CATEGORICAL_PALETTE_DARK = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767' // red
]

/** Fixed neutral color for every synthetic node (OpenProject #997/#1001) -- deliberately outside
 *  `CATEGORICAL_PALETTE_LIGHT`/`_DARK` so a synthetic folder/tag-hub marker never gets mistaken for
 *  a real group. A mid-gray reads clearly against both the light and dark canvas surface, so unlike
 *  the two palettes above it needs no dark variant of its own. */
const SYNTHETIC_NODE_COLOR = '#9e9e9e'

/** Keyed on the group's palette SLOT INDEX, never the resolved hex -- so a mode flip repaints every
 *  already-assigned group in its new palette's color instead of freezing it at whichever mode first
 *  assigned it (OpenProject #2412). */
const groupColorSlots = new Map()

/** Assigns the palette's next unused slot to a not-yet-seen group key, then always returns that
 *  same slot's color for that key going forward -- stable across redraws within a session, and
 *  stable across a reload too since the backend returns nodes in a consistent order (insertion
 *  order drives slot assignment). Past 8 distinct groups the palette wraps rather than leaving a
 *  group undrawn -- a graph view has no "fold into Other" fallback the way a chart legend would.
 *  Reads `dark.isActive` on every call (not just when a slot is first assigned), which is what
 *  lets a dark-mode toggle repaint existing groups in the other palette's color -- and, since every
 *  caller of this function ends up read from a Vue computed or watcher, is also what makes that
 *  toggle a tracked reactive dependency of the legend and the canvas repaint alike. */
function colorForGroup(key) {
  if (!groupColorSlots.has(key)) {
    groupColorSlots.set(key, groupColorSlots.size % CATEGORICAL_PALETTE_LIGHT.length)
  }
  const palette = dark.isActive ? CATEGORICAL_PALETTE_DARK : CATEGORICAL_PALETTE_LIGHT
  return palette[groupColorSlots.get(key)]
}

/** One entry per distinct group currently in the graph, in first-seen order -- the legend panel's
 *  data source. Recomputes reactively off `nodes.value`/`groupBy` (via `groupKeyFor`), so toggling
 *  the grouping selector updates the legend's entries and labels together with the canvas. */
const legendEntries = computed(() => {
  const seen = new Map()
  for (const node of nodes.value) {
    if (node.synthetic) {
      continue
    }
    const key = groupKeyFor(node)
    if (!seen.has(key)) {
      seen.set(key, colorForGroup(key))
    }
  }
  return [...seen.entries()].map(([key, color]) => ({ key, color }))
})

/** Path -> node lookup over the currently-visible set, for resolving a fallback-list edge
 *  endpoint that `d3-force` hasn't mutated into a node reference yet -- see `resolveEndpoint()`. */
const nodesByPath = computed(() => new Map(nodes.value.map((n) => [n.path, n])))

/** An edge's endpoint, resolved to the actual node object it names. `forceLink`'s `id()`
 *  resolution (attached by `startSimulation()`) mutates `edge.source`/`edge.target` in place from
 *  a plain path string into a node reference the moment it initializes against the simulation's
 *  current node set -- same object-or-string shape `graphFilters.js#endpointId` normalizes, here
 *  resolved to the node itself (not just its id) since the fallback list needs the node's title. */
function resolveEndpoint(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null
    ? endpoint
    : nodesByPath.value.get(endpoint)
}

/** A node's direct graph-neighbors, in first-seen order with no duplicates -- every other
 *  endpoint of an edge in `edges.value` (the edges currently drawn) that touches this node,
 *  whether the neighbor is a real page or a synthetic folder/root node. */
function fallbackLinksFor(node) {
  const seen = new Set()
  const links = []
  for (const edge of edges.value) {
    const source = resolveEndpoint(edge.source)
    const target = resolveEndpoint(edge.target)
    if (!source || !target) {
      continue
    }
    const neighbor = source === node ? target : target === node ? source : null
    if (neighbor && neighbor !== node && !seen.has(neighbor.path)) {
      seen.add(neighbor.path)
      links.push(neighbor)
    }
  }
  return links
}

/** The fallback list's data (OpenProject #1686): one entry per REAL node currently visible, each
 *  paired with its direct neighbors (`fallbackLinksFor`) -- a synthetic node never gets a
 *  top-level entry since it has no page for its `<a>` to point at, but it can still appear as a
 *  (non-link) neighbor under a real node's entry. Recomputes off `nodes.value`/`edges.value`, so
 *  it stays in step with `groupBy`/`activeFilters` the same way the canvas drawing does. */
const fallbackNodes = computed(() =>
  nodes.value
    .filter((node) => !node.synthetic)
    .map((node) => ({ node, links: fallbackLinksFor(node) }))
)

let simulation = null
let ctx = null
let resizeObserver = null
let nodeQuadtree = null
/** Identity cache for `applyFilters()`'s synthetic folder/root nodes (OpenProject #2538) -- keyed
 *  by each synthetic node's own id and passed into `graphFilters.js#buildPathHierarchyEdges`, so
 *  a node still visible across an `activeFilters` change reuses the same object (and
 *  whatever `x`/`y`/`vx`/`vy` d3-force has since assigned it) instead of jittering in from
 *  d3-force's origin-centered default placement. Reset in `loadGraph()`, never mutated elsewhere --
 *  a wholesale new site/keyword/sizeBy fetch is a fresh graph and must not carry stale positions
 *  forward from the one before it. */
let syntheticNodeCache = new Map()
const hoveredNode = ref(null)
/** Cursor position relative to `containerRef`, for positioning the hover tooltip. */
const tooltipPos = reactive({ x: 0, y: 0 })

function sizeCanvas() {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) {
    return
  }
  const { width, height } = container.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = width * dpr
  canvas.height = height * dpr
  ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  simulation?.force('center', forceCenter(width / 2, height / 2))
}

const zoomTransform = ref(null)
/** Populated by Task 20 (#895); an empty array here draws no hulls, which is correct pre-874. */
const clusters = ref([])

/*
  Node radius (5) and edge stroke color/opacity below are starting points for visual tuning, not
  verified-correct constants -- adjust them against a real graph in the browser once there's data on
  screen. The label zoom threshold/size cap (`drawLabels()`, OpenProject #1287/#1288) have since been
  tuned past that starting point.
*/

/** The one shared radius floor/ceiling for BOTH sizing metrics ('edits' and 'visits') -- consolidated
 *  from four separate (and, until OpenProject #2561, additively-capped) constants into this single
 *  pair once `radiusFor()` switched to a true min/max lerp normalized against the current graph's own
 *  observed range (`sqrtRangeOf()`/`lerpRadius()`, `graphNodeSize.js`) rather than an absolute
 *  `MIN + sqrt(count) * SCALE` formula. `MIN_NODE_RADIUS` matches the pre-#1270 'uniform' mode's fixed
 *  radius, same as before, so the smallest-ranked node in any graph is no smaller than that legacy
 *  dot. `MAX_NODE_RADIUS` is `5x` the old `22` cap (OpenProject #2561) -- the lerp's own normalization
 *  is what makes a ceiling this much larger workable at all: only the single highest-ranked node in
 *  the currently-loaded graph ever actually draws at it, everything else scales down from there. */
const MIN_NODE_RADIUS = 5
const MAX_NODE_RADIUS = 110

/** How many contributors count toward a node's 'edits'-mode size, per the currently-checked
 *  `contributorTypes` and the currently-selected `sizeCountMode`. `sizeCountMode === 'total'` reads
 *  the raw (not-distinct) row counts (OpenProject #1269's `contributors.total`) instead of the
 *  unique-contributor figures at the object's top level; either way, both types checked (the
 *  default) reads the backend's pre-summed `all` rather than adding `editor + mcp` together -- for
 *  the unique figures a contributor who used both channels would otherwise be counted twice, and
 *  for the total figures `all` is already an exact sum either way (see
 *  `backend/models/pageHistory.ts#contributorCountsForGraph()`'s doc comment). Neither type checked
 *  sizes every real node at the floor. */
function contributorCountFor(node) {
  const raw = node.contributors
  if (!raw) {
    return 0
  }
  const counts = sizeCountMode.value === 'total' ? raw.total : raw
  const countsEditor = contributorTypes.value.includes('editor')
  const countsMcp = contributorTypes.value.includes('mcp')
  if (countsEditor && countsMcp) {
    return counts.all
  }
  if (countsEditor) {
    return counts.editor
  }
  if (countsMcp) {
    return counts.mcp
  }
  return 0
}

/** How many visitors count toward a node's 'visits'-mode size, per the currently-checked
 *  `pageviewClientTypes`, within the currently-selected `pageviewsWindow` and `sizeCountMode`.
 *  `sizeCountMode === 'total'` reads the raw (not-distinct) row counts (OpenProject #1269's
 *  `pageviews.<window>.total`) instead of the unique-visitor figures at the window object's top
 *  level. Either way this is a plain sum of the checked buckets rather than reading a precomputed
 *  'all' -- exact for any subset here (see `backend/models/pageviews.ts#countsForGraph()`'s doc
 *  comment: each client type hashes a disjoint identity space for the unique figures, and a raw row
 *  count carries no identity to double-count at all, so summing all three always equals the
 *  backend's own `all`). */
function pageviewCountFor(node) {
  const windowCounts = node.pageviews?.[pageviewsWindow.value]
  if (!windowCounts) {
    return 0
  }
  const counts = sizeCountMode.value === 'total' ? windowCounts.total : windowCounts
  return pageviewClientTypes.value.reduce((sum, type) => sum + (counts[type] ?? 0), 0)
}

/** The hover tooltip's i18n message key for `count`, per the active `sizeBy`/`sizeCountMode`
 *  combination (OpenProject #2293). The noun must follow `sizeCountMode` as well as `sizeBy`:
 *  'total' reads the raw, non-distinct row counts (an edit or visit tally), while 'unique' reads
 *  the distinct-identity figures (a contributor or visitor tally) -- so "Edits + Total" and
 *  "Visits + Unique" need a different noun than "Edits + Unique" and "Visits + Total" use, even
 *  though all four share the same `sizeBy` pair. Each key carries its own singular/plural form
 *  (`backend/locales/en.json`), so `count` itself is only threaded through by the caller. */
function tooltipKeyFor() {
  if (sizeBy.value === 'edits') {
    return sizeCountMode.value === 'total' ? 'graph.tooltip.edits' : 'graph.tooltip.contributors'
  }
  return sizeCountMode.value === 'total' ? 'graph.tooltip.visits' : 'graph.tooltip.uniqueVisitors'
}

/** The currently active sizing metric's per-node counter -- `contributorCountFor()` for 'edits',
 *  `pageviewCountFor()` for 'visits', the only two values `sizeBy` can hold now that 'uniform' is
 *  gone (OpenProject #1270). Shared by `metricRange` and `radiusFor()` so the two always read the
 *  exact same counter for the exact same node. */
function metricCountFor(node) {
  return sizeBy.value === 'edits' ? contributorCountFor(node) : pageviewCountFor(node)
}

/** The active metric's sqrt-space `[min, max]` across every REAL node in the currently-loaded graph
 *  (OpenProject #2561) -- what `radiusFor()` normalizes its lerp against, so a node's drawn size
 *  expresses its RANK within THIS graph, not a fixed absolute scale. A plain variable refreshed by
 *  `refreshMetricRange()` below, deliberately NOT a Vue `computed`: node objects are kept out of
 *  Vue's reactivity on purpose (OpenProject #1837 -- see the `markRaw()`/`shallowRef` doc comment
 *  further up), so a `computed` reading a node's own `contributors`/`pageviews` field would never
 *  invalidate on the one write path that changes it in place (editing a node's data directly, the
 *  way `Graph.layout.test.js` does, or any future live-editing feature) -- only on `nodes.value`'s
 *  own identity changing, or one of the sizing-control refs changing. */
let currentMetricRange = { min: 0, max: 0 }

/** Recomputes `currentMetricRange` from the CURRENT `nodes.value`/`sizeBy`/`sizeCountMode`/etc, in
 *  place of Vue's own dependency tracking (see `currentMetricRange`'s doc comment for why). Every
 *  call site matters: `applyFilters()` (initial load, and every filter/edge-mode change) runs this
 *  before `startSimulation()` ever attaches `collide` for the first time; the sizing-controls watcher
 *  runs it before RE-attaching `collide`, so that force's one-time-per-attachment radius snapshot
 *  (see `collideRadiusFor()`'s own doc comment) is never taken against a stale range; and
 *  `computeClusters()` runs it on every call so the drawn/hull geometry it derives is always fresh
 *  too, however that call was reached. Cheap enough to call from all three: one O(n) pass over the
 *  currently-visible node set, not a per-`radiusFor()`-call cost. */
function refreshMetricRange() {
  const counts = []
  for (const node of nodes.value) {
    if (!node.synthetic) {
      counts.push(metricCountFor(node))
    }
  }
  currentMetricRange = sqrtRangeOf(counts)
}

/** A node's drawn radius: synthetic nodes are always the fixed `3`; a real node is a min/max lerp
 *  between `MIN_NODE_RADIUS` and `MAX_NODE_RADIUS`, interpolated in sqrt(count) space and normalized
 *  against `currentMetricRange` -- the current graph's own observed range for the active metric
 *  (OpenProject #2561). `lerpRadius()` (`graphNodeSize.js`) owns the interpolation itself, including
 *  the degenerate zero-range case (every loaded node the same count) -- see its own doc comment. */
function radiusFor(node) {
  if (node.synthetic) {
    return 3
  }
  return lerpRadius(metricCountFor(node), currentMetricRange, MIN_NODE_RADIUS, MAX_NODE_RADIUS)
}

/** `d3-force`'s `forceCollide` caches a function radius per node at `initialize()` time (same
 *  one-time-evaluation shape as the `forceX`/`forceY` pair #1158 replaced), so this is re-read only
 *  by re-attaching the force -- the sizing-related watcher below does that on toggle; it needs no
 *  per-tick recompute the way #1158's cluster centroids did, since a node's own contributor/pageview
 *  count never changes mid-session. */
function collideRadiusFor(node) {
  return radiusFor(node) + 2
}

/** Recomputes everything derived from node POSITION: rebuilds the hit-test quadtree over the
 *  current `x`/`y`s and re-colors/re-hulls clusters via `recomputeClusters()`. Call whenever nodes
 *  may have moved or the visible set may have changed -- a simulation tick, a resize, a sizing
 *  change -- never for a pan/zoom alone, where no node's position changed, only the canvas
 *  transform (OpenProject #1837; `recomputeClusters()`'s O(n log n) quadtree build plus per-group
 *  `polygonHull` work used to run at pointer/wheel frequency for a picture whose geometry hadn't
 *  changed). Always call `repaint()` afterward to actually draw the result. */
function relayout() {
  nodeQuadtree = d3quadtree(
    nodes.value,
    (d) => d.x,
    (d) => d.y
  )

  recomputeClusters()
}

/** Paints the current layout to the canvas. `graphDraw.js` owns the actual
 *  save/clear/transform/draw/restore sequence; this is only what the page holds that it needs.
 *  Safe to call on every zoom/pan frame since it recomputes no layout. */
function repaint() {
  paintGraph({
    ctx,
    canvas: canvasRef.value,
    transform: zoomTransform.value,
    nodes: nodes.value,
    edges: edges.value,
    clusters: clusters.value,
    radiusFor,
    dark: dark.isActive,
    highlightedIds: highlightedNodeIds.value
  })
}

/** Screen coordinates -> the simulation's own coordinate space, undoing the current zoom transform. */
function toGraphSpace(clientX, clientY) {
  const rect = canvasRef.value.getBoundingClientRect()
  const t = zoomTransform.value ?? zoomIdentity
  return {
    x: (clientX - rect.left - t.x) / t.k,
    y: (clientY - rect.top - t.y) / t.k
  }
}

/** The `12`px hit radius is a starting point matched to the `5`px node-dot radius plus some slack
 *  for an imprecise click -- tune visually. */
function findNodeAt(clientX, clientY) {
  if (!nodeQuadtree) {
    return null
  }
  const { x, y } = toGraphSpace(clientX, clientY)
  return nodeQuadtree.find(x, y, 12)
}

/** A node's in-app link (its page path plus locale prefix, per the site's locale-prefix rules) --
 *  shared by the canvas click handler and every fallback-list `<a>` (OpenProject #1686). When the
 *  graph's own keyword filter (`keywordQuery`) is non-empty at the moment this is read, the term is
 *  carried forward as a `?highlight=` query param (OpenProject #2540) so the loaded page can offer
 *  an in-page highlight/find for it (sibling task, same parent Feature #2539) -- this is the ONE
 *  place that decides whether the param is added, so both the real `<a href>` (keyboard/screen
 *  reader, and anyone opening it in a new tab) and `navigateToNode()`'s `router.push()` target agree;
 *  neither call site appends it separately. No active keyword at click time means no param, and
 *  navigation is byte-for-byte what it was before this param existed. */
function fallbackHref(node) {
  const path = localizedPagePath(node.path, node.locale, {
    useLocales: siteStore.useLocales,
    primary: siteStore.locales.primary,
    forcePrefix: siteStore.locales.forcePrefix
  })
  const keyword = keywordQuery.value.trim()
  return keyword ? `${path}?highlight=${encodeURIComponent(keyword)}` : path
}

/** Navigates to a node's page, if it has one -- a synthetic folder/root node is not a real page
 *  and is silently ignored, same as a canvas click that misses every dot. */
function navigateToNode(node) {
  if (!node || node.synthetic) {
    return
  }
  router.push(fallbackHref(node))
}

function onCanvasClick(event) {
  navigateToNode(findNodeAt(event.clientX, event.clientY))
}

function onCanvasMouseMove(event) {
  hoveredNode.value = findNodeAt(event.clientX, event.clientY)
  const containerRect = containerRef.value.getBoundingClientRect()
  tooltipPos.x = event.clientX - containerRect.left
  tooltipPos.y = event.clientY - containerRect.top
}

function startSimulation() {
  const { width, height } = containerRef.value.getBoundingClientRect()

  simulation = runSimulation(
    nodes.value,
    edges.value,
    { width, height },
    {
      groupKeyFor,
      collideRadiusFor,
      radiusFor,
      onTick: () => {
        relayout()
        repaint()
      }
    }
  )
}

/** Single entry point Task 18's coloring and Task 20's hull computation both funnel through --
 *  called every tick (from `relayout()`) so hulls/colors stay in step with the live layout, and
 *  whenever the grouping dimension or the visible node set changes. */
function recomputeClusters() {
  for (const node of nodes.value) {
    node.color = node.synthetic ? SYNTHETIC_NODE_COLOR : colorForGroup(groupKeyFor(node))
  }
  computeClusters()
}

/** Rebuilds `clusters.value` from the current node positions. `graphSimulation.js` owns the hull
 *  geometry; the page supplies the three answers only it has -- how a node is grouped, what colour
 *  that group is, and how large the node draws. */
function computeClusters() {
  refreshMetricRange()
  clusters.value = buildClusters(nodes.value, { groupKeyFor, colorForGroup, radiusFor })
}

function attachZoom() {
  attachGraphZoom(canvasRef.value, (transform) => {
    zoomTransform.value = transform
    // -> Only the canvas transform changed, no node moved -- repaint only (OpenProject #1837).
    repaint()
  })
  zoomTransform.value = zoomIdentity
}

/** `sizing` (OpenProject #1863) asks the backend to attach each node's `contributors`/`pageviews`
 *  count objects, which otherwise dominate the payload and go unused by most of a page's readers.
 *  Sent as the currently-active `sizeBy` mode, but the backend gates on presence alone and always
 *  returns both objects together -- since the "Size by" toggle (`sizeBy`, below) switches modes
 *  client-side with no refetch, both dimensions need to already be on hand either way. */
async function loadGraph() {
  isLoading.value = true
  loadError.value = null
  // -> A fresh fetch is a wholesale new graph (new site, keyword or sizeBy) -- stale synthetic node
  //    positions from the previous one must not leak into it (OpenProject #2538).
  syntheticNodeCache = new Map()
  try {
    const graph = await API_CLIENT.get(`sites/${siteStore.id}/graph`, {
      searchParams: { sizing: sizeBy.value }
    }).json()
    allNodes.value = (graph.nodes ?? []).map((n) => markRaw(n))
    allEdges.value = (graph.edges ?? []).map((e) => markRaw(e))
    graphTruncated.value = graph.truncated ?? false
    totalNodes.value = graph.totalNodes ?? allNodes.value.length
    // -> OpenProject #2525: the depth filter defaults to "everything" for the graph actually
    //    loaded, not a `null` sentinel -- `loadGraph()` is the one and only call site (mount-only),
    //    so this is a real one-time default rather than a reset on every reload.
    activeFilters.folderDepth = actualMaxFolderDepth.value
    applyFilters()
    sizeCanvas()
    startSimulation()
    attachZoom()
  } catch (err) {
    loadError.value = err
  } finally {
    isLoading.value = false
  }
}

/** Whether pageview tracking is currently on (OpenProject #1238's admin opt-out), same endpoint
 *  `AdminPageviews.vue` reads. A failed check is treated as "off" -- the safer default given
 *  `pageviewsTrackingEnabled`'s own doc comment, and consistent with `loadGraph()`'s own
 *  try/catch-and-recover shape below. Called after `loadGraph()` in `onMounted` (not raced with it)
 *  so a test asserting on the graph fetch being the FIRST `API_CLIENT.get` call keeps holding. */
async function loadPageviewsTrackingState() {
  try {
    const resp = await API_CLIENT.get('system/pageviews').json()
    pageviewsTrackingEnabled.value = resp?.isEnabled === true
  } catch {
    pageviewsTrackingEnabled.value = false
  }
}

/** Recomputes `nodes.value`/`edges.value` (what the simulation actually runs on) from `allNodes`
 *  against `activeFilters`, then layers on `buildPathHierarchyEdges`'s synthetic folder/root nodes
 *  and edges -- the graph's sole edge source (OpenProject #2580 removed the sibling `'tags'`/
 *  `'classification'` hub-edge modes that used to be selectable here, so every non-root node now
 *  has exactly one incoming `type: 'path'` edge, a strict tree). The 872 endpoint's `relation`/
 *  `link` edges (`computeVisibleSubset`'s `visibleEdges`) are deliberately not used here; see
 *  OpenProject #997. Called on initial load and by the `activeFilters` watcher below. Does not
 *  touch the live simulation itself; that's `syncSimulationToVisibleSet`'s job, since the initial
 *  call here runs before `startSimulation()` has created one. */
function applyFilters() {
  const { visibleNodes } = computeVisibleSubset(allNodes.value, allEdges.value, activeFilters)
  const { syntheticNodes, edges: syntheticEdges } = buildPathHierarchyEdges(
    visibleNodes,
    syntheticNodeCache
  )
  // -> `visibleNodes` are already-raw objects filtered from `allNodes.value` (markRaw'd in
  //    `loadGraph()`); `syntheticNodes`/`syntheticEdges` are built fresh only for a genuinely new
  //    key each call (see `graphFilters.js`'s `syntheticNodeCache`-backed reuse, OpenProject #2538)
  //    and have never passed through `markRaw()` yet. Mapping the whole assembled array/list through
  //    it here is what keeps every node/edge the simulation sees out of Vue's reactivity system,
  //    regardless of which builder produced it -- `markRaw()` is a no-op on an object already
  //    marked, so re-marking the reused ones costs nothing.
  nodes.value = [...visibleNodes, ...syntheticNodes].map((n) => markRaw(n))
  edges.value = syntheticEdges.map((e) => markRaw(e))
  // -> Must run before `startSimulation()`'s first `forceCollide(collideRadiusFor)` attachment
  //    (OpenProject #2561): that force snapshots every node's radius once, at attach time, so the
  //    very first attachment needs a correct range already in place, not just whatever later
  //    `recomputeClusters()`/`computeClusters()` call happens to run first.
  refreshMetricRange()
}

watch(groupBy, () => {
  recomputeClusters()
  simulation?.alpha(0.3).restart()
})

/** OpenProject #2412: no node/cluster moved and the visible set didn't change, only which palette
 *  column every color comes from -- `recomputeClusters()` alone (no simulation restart) re-derives
 *  `node.color`/cluster hull colors off the new mode, and `repaint()` is what actually redraws the
 *  canvas layer (edges/labels) in its own light/dark pair; the legend swatches update on their own
 *  since `legendEntries` reads `colorForGroup()`, which itself reads `dark.isActive`. */
watch(
  () => dark.isActive,
  () => {
    recomputeClusters()
    repaint()
  }
)

/** Re-attaching `collide` (rather than mutating it in place) is what makes `forceCollide` re-read
 *  every node's radius through `collideRadiusFor()` -- see that function's own doc comment on why a
 *  plain in-place change wouldn't be picked up. No `applyFilters()`/`syncSimulationToVisibleSet()`
 *  call needed: neither the visible node set nor any edge changes here, only how big each dot
 *  draws and how much room `collide` gives it. */
watch([sizeBy, sizeCountMode, contributorTypes, pageviewsWindow, pageviewClientTypes], () => {
  // -> Refresh BEFORE re-attaching `collide` (OpenProject #2561): the new attachment snapshots
  //    every node's radius immediately, off whichever metric/count-mode just became active, so the
  //    range has to already reflect that switch -- `relayout()`'s own `computeClusters()` refresh
  //    below runs too late for this specific force-initialize moment.
  refreshMetricRange()
  simulation?.force('collide', forceCollide(collideRadiusFor))
  simulation?.alpha(0.3).restart()
  relayout()
  repaint()
})

/** OpenProject #1140's own scope decision: while pageview tracking is off, 'visits' sizing has no
 *  data behind it -- if the admin opt-out toggles off while this control is active (e.g. in another
 *  tab), fall back to 'edits' rather than leaving a now-hidden option selected. No 'uniform' mode
 *  to fall back to any more (OpenProject #1270). */
watch(pageviewsTrackingEnabled, (enabled) => {
  if (!enabled && sizeBy.value === 'visits') {
    sizeBy.value = 'edits'
  }
})

/** OpenProject #2294: once the locale filter control disappears (single locale left, either from the
 *  outset or after tags/folder-depth narrow the visible set down to one), clear any value chosen on
 *  it -- otherwise a locale picked before the narrowing keeps filtering the graph with no visible
 *  control left to clear it from. */
watch(showLocaleFilter, (visible) => {
  if (!visible && activeFilters.locale !== null) {
    activeFilters.locale = null
  }
})

/*
  A real page node re-added after being filtered back in loses whatever `x`/`y`/velocity it had
  before removal (it is a fresh entry to `d3-force` as far as the simulation is concerned) --
  accepted per the spec's own framing ("removed nodes exit the simulation so the remainder
  re-settles, rather than just being drawn hidden"): re-settling is the explicitly wanted behavior
  for a REAL node, not a bug to work around.

  Synthetic folder/root nodes (OpenProject #997/#998) are a different case, and used to re-settle
  right along with real nodes on every `activeFilters` change -- but that was never a considered
  part of the above spec, just an incidental side effect of `applyFilters()`'s
  `buildPathHierarchyEdges` call (`graphFilters.js`) always constructing brand-new objects with no
  `x`/`y`, even for a marker that was already visible and already settled. That produced a visible
  flash-jitter on every filter change (OpenProject #2538): a stacked cluster of synthetic nodes at
  d3-force's origin-centered default placement, snapping into position as `forceLink`/`forceManyBody`
  pulled them across the canvas. `applyFilters()` now passes `syntheticNodeCache` into the builder so
  an already-visible synthetic node keeps its object identity (and therefore its settled position)
  across calls; only a genuinely new key still falls through to d3-force's default placement, same as
  a reappearing real node above.
*/
function syncSimulationToVisibleSet() {
  if (!simulation) {
    return
  }
  simulation.nodes(nodes.value)
  simulation.force('link')?.links(edges.value)
  recomputeClusters()
  simulation.alpha(0.5).restart()
}

watch(
  activeFilters,
  () => {
    applyFilters()
    syncSimulationToVisibleSet()
  },
  { deep: true }
)

/** OpenProject #2480, extended by #2533: a keyword match -- from EITHER the backend full-text
 *  search or the client-side title-contains pass -- changes only which ALREADY-visible nodes draw
 *  highlighted, no node/edge set changes, no simulation restart, just a repaint against the current
 *  layout (unlike `activeFilters`'s watcher above, which does change what's visible).
 *  Watches the unioned `highlightedNodeIds` itself, not `keywordMatches` alone: the backend pass
 *  populates `keywordMatches` only once its (debounced, async) request resolves, but the title pass
 *  is synchronous off `keywordQuery`/`allNodes` and never touches `keywordMatches` at all -- a
 *  title-only match with no corresponding backend hit would otherwise compute correctly but never
 *  actually repaint the canvas. */
watch(highlightedNodeIds, () => {
  repaint()
})

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    sizeCanvas()
    relayout()
    repaint()
  })
  resizeObserver.observe(containerRef.value)
  loadGraph()
  loadPageviewsTrackingState()
})

onBeforeUnmount(() => {
  simulation?.stop()
  resizeObserver?.disconnect()
  debouncedSearchKeyword.cancel()
})
</script>

<style lang="scss" scoped>
.graph-view {
  position: relative;
  width: 100%;
  // -> Fills whatever height MainLayout's <w-page-container> gives it; the canvas itself is
  //    sized to match via a ResizeObserver wired up in Task 12/13, not a fixed value here.
  height: 100%;
  min-height: 480px;
}

.graph-view-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.graph-view-right-rail {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: calc(100% - 32px);
}

.graph-view-controls {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.graph-view-control-group {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.graph-view-control-caption {
  font-size: 11px;
  opacity: 0.7;

  @at-root .body--light & {
    color: rgba(0, 0, 0, 0.8);
  }
  @at-root .body--dark & {
    color: #fff;
  }
}

.graph-view-filters {
  position: absolute;
  top: 16px;
  left: 16px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 220px;
  padding: 12px;
  border-radius: 4px;
  backdrop-filter: blur(4px);

  @at-root .body--light & {
    background: rgba(255, 255, 255, 0.85);
    color: rgba(0, 0, 0, 0.8);
  }
  @at-root .body--dark & {
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
  }
}

.graph-view-truncation-notice {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
  max-width: calc(100% - 64px);
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 12px;
  text-align: center;
  backdrop-filter: blur(4px);

  @at-root .body--light & {
    background: rgba(255, 244, 224, 0.9);
    color: rgba(0, 0, 0, 0.8);
  }
  @at-root .body--dark & {
    background: rgba(90, 60, 0, 0.55);
    color: #fff;
  }
}

.graph-view-legend {
  display: flex;
  flex-direction: column;
  flex: none;
  gap: 4px;
  padding: 8px 12px;
  border-radius: 4px;
  backdrop-filter: blur(4px);
  max-height: 240px;
  overflow-y: auto;

  @at-root .body--light & {
    background: rgba(0, 0, 0, 0.05);
  }
  @at-root .body--dark & {
    background: rgba(255, 255, 255, 0.08);
  }
}

.graph-view-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.graph-view-legend-swatch {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.graph-view-legend-label {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;

  @at-root .body--light & {
    color: rgba(0, 0, 0, 0.8);
  }
  @at-root .body--dark & {
    color: #fff;
  }
}

.graph-view-fallback,
.graph-view-fallback ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.graph-view-tooltip {
  position: absolute;
  z-index: 1;
  pointer-events: none;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
}
</style>
