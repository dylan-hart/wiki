<template>
  <div ref="containerRef" class="graph-view">
    <canvas
      ref="canvasRef"
      class="graph-view-canvas"
      :class="{ 'graph-view-canvas--hover': hoveredNode }"
      role="img"
      :aria-label="graphAccessibleName"
      @click="onCanvasClick"
      @mousemove="onCanvasMouseMove"
      @mouseleave="onCanvasMouseLeave">
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
    <!--
      What is NOT on screen, said plainly rather than left for the reader to notice: the graph caps
      how many nodes it draws, and the filters below act on that cap, not on the site. Drawn as the
      design draws it -- a plain plate on the canvas with the accent as its edge, the one thing on
      this screen that is a warning (`ui-redesign/Cardinal Wiki - Graph 3x.dc.html`).
    -->
    <div v-if="graphTruncated" class="graph-view-truncation-notice">
      {{ t('graph.truncationNotice', { shown: allNodes.length, total: totalNodes }) }}
    </div>
    <div class="graph-view-right-rail graph-panel">
      <div class="graph-view-controls">
        <div class="graph-view-control-group">
          <span class="graph-view-control-caption">{{ t('graph.controls.groupByLabel') }}</span>
          <w-btn-toggle
            v-model="groupBy"
            :aria-label="t('graph.controls.groupByLabel')"
            :options="groupByOptions" />
        </div>
        <!--
          SIZE BY and COUNT used to be two separate rows, each with its own caption -- consolidated
          into one row under a single "SIZE BY" caption (OpenProject #2855/#2828 item 3): the
          Total/Unique toggle (sizeCountMode) first/left, the Visits/Edits toggle (sizeBy)
          second/right (option order within each toggle swapped per OpenProject #2934). The "COUNT"
          caption is dropped entirely rather than kept and hidden; the count toggle keeps its own
          aria-label since its accessible name ("Unique or total") still differs from the row's
          visible caption.
        -->
        <div class="graph-view-control-group">
          <span class="graph-view-control-caption">{{ t('graph.controls.sizeByLabel') }}</span>
          <div class="graph-view-control-row">
            <w-btn-toggle
              v-model="sizeCountMode"
              :aria-label="t('graph.controls.countAriaLabel')"
              :options="sizeCountModeOptions" />
            <w-btn-toggle
              v-model="sizeBy"
              :aria-label="t('graph.controls.sizeByLabel')"
              :options="sizeByOptions" />
          </div>
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
    <!--
      Each filter is an overline over its control, in the same mono the panel opposite uses for its
      own group captions -- the design labels every control on this screen that way. They were
      `WInput`/`WSelect` floating labels, which set them in body size and left the two panels
      speaking in two voices about the same kind of thing.
    -->
    <div class="graph-view-filters graph-panel">
      <div class="flex flex-col gap-[5px]">
        <span class="graph-view-control-caption">{{ t('graph.filters.keyword') }}</span>
        <w-input v-model="keywordQuery" clearable dense :aria-label="t('graph.filters.keyword')" />
      </div>
      <div class="flex flex-col gap-[5px]">
        <span class="graph-view-control-caption">{{ t('graph.filters.tags') }}</span>
        <w-select
          v-model="activeFilters.tags"
          multiple
          use-chips
          dense
          options-dense
          :options="tagOptions"
          :aria-label="t('graph.filters.tags')" />
      </div>
      <div class="flex flex-col gap-[5px]">
        <span class="graph-view-control-caption">{{ t('graph.filters.folderDepth') }}</span>
        <div class="flex items-center gap-3">
          <w-range
            v-model="folderDepthSlider"
            single
            markers
            :min="0"
            :max="actualMaxFolderDepth"
            :aria-label="t('graph.filters.folderDepth')"
            class="min-w-0 flex-1" />
          <!-- -> 56px, the width the design gives the readout beside this slider -->
          <div style="width: 56px">
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
      <div class="flex flex-col gap-[5px]" v-if="showLocaleFilter">
        <span class="graph-view-control-caption">{{ t('graph.filters.locale') }}</span>
        <w-select
          v-model="activeFilters.locale"
          dense
          options-dense
          :options="localeOptions"
          :aria-label="t('graph.filters.locale')" />
      </div>
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
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch
} from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { forceCenter, forceCollide } from 'd3-force'
import { quadtree as d3quadtree } from 'd3-quadtree'
import { zoomIdentity } from 'd3-zoom'
import { debounce } from 'es-toolkit/function'
import { log } from '@/helpers/log'
import { localizedPagePath } from '@/helpers/pagePaths'
import { useDark } from '@/composables/dark'
import { useGraphStore } from '@/stores/graph'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'
import GraphClientTypeFilter from '@/components/GraphClientTypeFilter.vue'
import {
  buildPathHierarchyEdges,
  computeHighlightedNodeIds,
  computeTitleMatchNodeIds,
  computeVisibleSubset,
  deriveFilterOptions,
  deriveMaxFolderDepth,
  nodeId,
  resolveFocusNode
} from './graphFilters.js'
import { paintGraph } from './graphDraw.js'
import { lerpRadius, sqrtRangeOf } from './graphNodeSize.js'
import { applyHoverPushImpulse } from './graphForces.js'
import {
  attachZoom as attachGraphZoom,
  computeClusters as buildClusters,
  linkDistanceFor,
  startSimulation as runSimulation
} from './graphSimulation.js'

/**
 * The knowledge graph view (OpenProject #848/#873): a full-viewport, canvas-rendered force graph
 * of every page the caller may read on this site. Fetched once on mount -- every filter and
 * re-cluster after that (#874/#875) runs against `nodes`/`edges` already in memory, no further
 * network round trip.
 */

const siteStore = useSiteStore()
const userStore = useUserStore()
const pageStore = usePageStore()
const graphStore = useGraphStore()
const router = useRouter()
const route = useRoute()
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

/** Node-sizing dimension (OpenProject #1141/#1269): 'edits', which scales a node's radius by its
 *  contributor count, or 'visits', by its pageview count -- see `radiusFor()`. There is no 'uniform'
 *  mode any more (OpenProject #1270 dropped it): every real node is always sized by one of these two
 *  dimensions. The REAL default is 'visits' when pageview tracking is on, falling back to 'edits'
 *  when it's off (OpenProject #2853) -- but it's declared here as 'edits' regardless, because
 *  `pageviewsTrackingEnabled` (below) itself defaults to `false` until its own async check resolves,
 *  and 'edits' is the one value `sizeByOptions` always offers no matter how that check turns out.
 *  Selecting 'visits' at this line would briefly pick an option that isn't there yet. The
 *  `reconcileSizeByForTracking()` function further down is where the real default actually gets
 *  applied, once it's known -- unless a persisted preference exists (OpenProject #2854), in which
 *  case `loadGraphPrefs()` overwrites this literal with it directly. */
const sizeBy = ref('edits')

/** Set by `loadGraphPrefs()` (OpenProject #2854) the moment a persisted `sizeBy` preference is
 *  found, regardless of its value -- read by `reconcileSizeByForTracking()` below as the signal that
 *  a real preference now exists, so its own "still holds the untouched literal default" check
 *  (`sizeBy.value === 'edits'`, #2853's original guard) is no longer a reliable stand-in for "hasn't
 *  been deliberately chosen": a reader who explicitly saved 'edits' while tracking was already on is
 *  otherwise indistinguishable, by value alone, from one who has never touched the control. Plain
 *  module state rather than a ref -- nothing templates or watches off it directly. */
let hasPersistedSizeBy = false

/** Set once `loadPageviewsTrackingState()` has resolved (OpenProject #2880), regardless of outcome
 *  -- read by `loadGraphPrefs()` as the signal that `pageviewsTrackingEnabled.value` now reflects a
 *  REAL check result rather than its own untouched initial `false`. `loadGraphPrefs()` must not
 *  reconcile against `pageviewsTrackingEnabled` before this is true: reconciling against a merely
 *  default-but-not-yet-checked `false` would incorrectly treat tracking as confirmed off (forcing a
 *  persisted `sizeBy: 'visits'` back to `'edits'`) whenever the profile load happens to settle before
 *  the tracking check does -- the ordinary case, since `loadGraphPrefs()` runs first in
 *  `initializeGraphPrefs()`'s `Promise.all()`. That premature reconcile would also latch
 *  `hasPersistedSizeBy` shut, permanently blocking the later, correct reconcile the tracking check's
 *  own resolution would otherwise still produce. Plain module state, same as `hasPersistedSizeBy`. */
let pageviewsTrackingResolved = false

/** Whether 'edits'/'visits' sizing (and the hover tooltip's count) reads the unique-identity figure
 *  or the raw row-count figure (OpenProject #1269's backend fields, #1270's toggle) --
 *  `contributorCountFor()`/`pageviewCountFor()` are the single place this is read. Defaults to
 *  'total' (OpenProject #2853; was 'unique'). */
const sizeCountMode = ref('total')

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
  const options = []
  if (pageviewsTrackingEnabled.value) {
    options.push({ label: t('graph.controls.sizeByVisits'), value: 'visits' })
  }
  options.push({ label: t('graph.controls.sizeByEdits'), value: 'edits' })
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
  { label: t('graph.controls.countTotal'), value: 'total' },
  { label: t('graph.controls.countUnique'), value: 'unique' }
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

/** The composite `${locale}:${path}` id of the node resolved from the `?path=` query param
 *  (OpenProject #3312, Feature #3311), or `null` when there is none/no match -- set once by
 *  `applyRouteFocus()` (see that function's own doc comment) and read only by `highlightedNodeIds`
 *  below, which folds it into the same highlight-ring rendering a keyword match already gets. A
 *  plain `ref` (not `shallowRef`): it only ever holds a primitive string or `null`, never an object. */
const focusNodeId = ref(null)

/** The composite `${locale}:${path}` id of the node the reader has SELECTED via a first canvas
 *  click (OpenProject #3363, Feature #3362's "Graph canvas -- selected node" scope), or `null` when
 *  nothing is selected -- set and cleared by `onCanvasClick()` below. Deliberately its own state,
 *  independent of the other two per-node states this file already tracks: `hoveredNode` (mouse-over
 *  only, no click involved) and `focusNodeId`/the anchor (the existing yellow ring, route-driven via
 *  `applyRouteFocus()`, unchanged by this ref). Not named `focusedNode` or any other synonym for
 *  "focus"/"anchor" on purpose -- the two concepts must stay independently trackable rather than
 *  merged into `focusNodeId`. A plain string/`null` ref, same shape as `focusNodeId`, for the same
 *  reason: nothing needs the node object itself, only its id.
 *
 *  The graph CANVAS draws no treatment of its own for this state (OpenProject #3364's corrected
 *  scope): the visible highlight lives on the nav sidebar's corresponding row instead
 *  (`stores/graph.js`'s `selectedPath`, read by `composables/navSidebarDestination.js#isSelected`),
 *  the same surface the anchor's own `is-graph-anchor` indicator already uses. `onCanvasClick()`
 *  keeps this composite id (for its own click-toggle comparisons) and separately mirrors the node's
 *  bare `path` into `graphStore.selectedPath` for the sidebar. */
const selectedNodeId = ref(null)

/** The `{ path, locale }` of the currently-anchored node (OpenProject #3333, Task #3312's own
 *  follow-up scope correction), or `null` when no anchor is active -- set alongside `focusNodeId`
 *  by `applyRouteFocus()`, and read by `applyFilters()` as `computeVisibleSubset()`'s fourth
 *  argument to restrict the rendered set to the anchor plus its descendants (see that function's
 *  own doc comment in `graphFilters.js`). A plain object of primitives, not the node itself: the
 *  node is a `markRaw()`'d, non-reactive entry of `allNodes.value` that `startSimulation()` mutates
 *  every tick, and this needs to be a reactive value the `watch(focusNodeId, ...)` below can key
 *  off safely without pulling that mutation churn into Vue's reactivity system. */
const routeFocusAnchor = ref(null)

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
 *  full strength with no highlight ring, same as before this WP existed.
 *
 *  A third source, unioned the same way (OpenProject #3312): `focusNodeId`, the `?path=` query-param
 *  target `applyRouteFocus()` resolves once on load -- see that function's own doc comment. Like the
 *  other two, this never narrows `computeVisibleSubset`'s own node set; it only marks an
 *  already-visible node for the highlight ring below. */
const highlightedNodeIds = computed(() => {
  const ids = new Set([
    ...computeHighlightedNodeIds(keywordMatches.value),
    ...titleMatchNodeIds.value
  ])
  if (focusNodeId.value) {
    ids.add(focusNodeId.value)
  }
  return ids
})

/** Reverts #3312's side effect of dimming the whole graph around a route-focused "anchor" node with
 *  no keyword filter active. `highlightedNodeIds` above unions in `focusNodeId` so the anchor still
 *  gets its highlight ring (`graphDraw.js#drawNodes`'s `highlightedIds` param, unchanged) -- but
 *  `repaint()` passes THIS set as `dimmingIds`, which gates the actual dimming and deliberately
 *  excludes `focusNodeId`. Landing on `/_graph?path=...` with no keyword typed must draw every node
 *  at full strength except the ones an active keyword filter didn't match -- the anchor being
 *  resolved is not itself a reason to dim anything. */
const keywordHighlightedNodeIds = computed(
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
    log.warn('graph', 'could not run the keyword search behind the graph filter', err)
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

/** Every directory segment of a node's own full `path`, excluding its trailing (page) segment --
 *  e.g. `guides/deep/two` -> `['guides', 'deep']`. Mirrors `graphFilters.js`'s `folderDepthOf()`
 *  (`path.split('/').length - 1` directory segments), just returning the segments themselves rather
 *  than their count: both exist because `node.folder` (backend `folderOf()`) is deliberately capped
 *  at just the first segment (OpenProject #3338/#3339) and can't distinguish `guides/one` from
 *  `guides/deep/two` -- a level-2/3 clustering key needs the full path, computed client-side. */
function directorySegmentsOf(node) {
  return node.path.split('/').slice(0, -1)
}

/** How many of a path's leading directory segments belong to the current anchor (OpenProject
 *  #3372) -- `0` with no anchor active or a root anchor (`path: ''`), matching the "root-anchored
 *  behaves exactly like unanchored" invariant `graphFilters.js#computeVisibleSubset`'s own doc
 *  comment already establishes elsewhere. Every node `groupKeyFor()`/`parentGroupKeyFor()` below
 *  ever sees is already restricted to the anchor plus its descendants (`applyFilters()`), so the
 *  anchor's own segments are always a strict leading prefix of theirs -- safe to subtract outright,
 *  never a partial/mismatched slice. */
function anchorSegmentCount() {
  const anchor = routeFocusAnchor.value
  return anchor && anchor.path !== '' ? anchor.path.split('/').length : 0
}

/** Cluster-nesting levels `computeClusters()`/`clusterForce()` bucket on (OpenProject #3339) -- 1
 *  is today's existing single-level grouping, 2/3 are the added folder-mode nesting. Passed to both
 *  so the simulation's centroid pull and the drawn circles bucket on the exact same set of levels. */
const CLUSTER_LEVELS = [1, 2, 3]

/** Computes a node's group key at a given nesting `level` (OpenProject #3339, made anchor-relative
 *  by #3372) -- `level` defaults to `1`, today's existing single-key behavior, so the third call
 *  site below (per-node dot color, Graph.vue ~1137) that must stay level-1-only needs no change to
 *  keep working exactly as before. Tag and classification grouping stay single-level: any `level`
 *  above 1 for either returns `null` (Feature #3338's scope -- neither has a genuine second level to
 *  nest), same as `computeClusters`/`clusterForce` already treat a `null`/`undefined` key as
 *  "exclude this node from this level".
 *
 *  Folder mode's level 1 stays `node.folder || '(root)'`, UNCHANGED, whenever no anchor (or only a
 *  root anchor) is active -- `node.folder` is a backend-computed field, not strictly required to
 *  equal `directorySegmentsOf(node)[0]` (a caller is free to stamp its own `.folder` independent of
 *  `.path`, as more than one existing suite does), so this only ever swaps to the path-derived
 *  segments below once there is an anchor depth to subtract; it never silently stops trusting
 *  `node.folder` for the un-anchored case. WITH a non-root anchor active, grouping restarts at the
 *  anchor's own children instead of the site root (OpenProject #3372) -- built from
 *  `directorySegmentsOf(node)` with the anchor's own leading segments dropped
 *  (`anchorSegmentCount()` above): e.g. anchored on folder A, a page directly in A's subfolder B
 *  groups under `'B'`, not under `'A'`, matching the anchor-restricted node set already on screen
 *  (#3333). Level 2 is the composite key of the node's first two segments AFTER that drop, level 3
 *  the first three -- a node not nested deep enough for a given level (not enough directory segments
 *  beyond the anchor) returns `null` for it, so it simply gets no cluster circle or centroid pull at
 *  that level. */
function groupKeyFor(node, level = 1) {
  if (level > 1 && groupBy.value !== 'folder') {
    return null
  }
  if (groupBy.value === 'tag') {
    return node.tags?.[0] ?? '(untagged)'
  }
  if (groupBy.value === 'classification') {
    return node.classification ?? '(unclassified)'
  }
  const anchorDepth = anchorSegmentCount()
  if (level === 1 && anchorDepth === 0) {
    return node.folder || '(root)'
  }
  const segments = directorySegmentsOf(node).slice(anchorDepth)
  if (level === 1) {
    return segments[0] ?? '(root)'
  }
  if (segments.length < level) {
    return null
  }
  return segments.slice(0, level).join('/')
}

/** A synthetic folder/root node's own MEMBERSHIP key (OpenProject #3355, made anchor-relative by
 *  #3372) -- which circle it belongs to as a member of its PARENT folder's grouping, never the key
 *  it would itself produce for its own children (`buildClusters()`'s own doc comment explains why
 *  that distinction matters). Only `groupBy: 'folder'` needs real path logic: a folder/root node
 *  carries no `tags`/`classification` of its own, so `groupKeyFor(node)` called directly on it
 *  already answers correctly for those two modes (the same `'(untagged)'`/`'(unclassified)'`
 *  catch-all bucket every other untagged node falls into).
 *
 *  `node.path`'s own leading segments belonging to the anchor are dropped the same way
 *  `groupKeyFor()` drops them (`anchorSegmentCount()` above), THEN the first-segment-or-root logic
 *  runs against what's left -- so a folder node's PARENT-folder key is its own anchor-relative first
 *  segment. With no anchor (or a root anchor) that drop is a no-op, so this reads exactly as before:
 *  first-segment doesn't care how many segments follow, so it's identical whether taken from the
 *  folder's own path or its parent's, and only a top-level folder (no segment beyond the anchor at
 *  all) differs -- its parent IS the anchor itself, which has no folder key of its own, so that case
 *  reads `'(root)'` the same way a folder-less real page does. This is what keeps a folder out of the
 *  circle it is itself the namer of: a nested folder's parent key coincides with the SAME
 *  anchor-relative top-level circle its own descendants already share (the existing single-level
 *  grouping this WP's scope is limited to -- multi-level nesting is the sibling Task's job), never
 *  with a circle keyed off the folder's own identity. */
function parentGroupKeyFor(node) {
  if (groupBy.value !== 'folder') {
    return groupKeyFor(node)
  }
  const segments = (node.path === '' ? [] : node.path.split('/')).slice(anchorSegmentCount())
  return segments.length > 1 ? segments[0] : '(root)'
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
  The edge stroke color/opacity below are starting points for visual tuning, not verified-correct
  constants -- adjust them against a real graph in the browser once there's data on screen. The node
  radius bounds and the label zoom threshold/size cap (`drawLabels()`, OpenProject #1287/#1288) have
  both since been tuned past that starting point -- see `MIN_NODE_RADIUS`/`MAX_NODE_RADIUS` below.
*/

/** The one shared radius floor/ceiling for BOTH sizing metrics ('edits' and 'visits') -- consolidated
 *  from four separate (and, until OpenProject #2561, additively-capped) constants into this single
 *  pair once `radiusFor()` switched to a true min/max lerp normalized against the current graph's own
 *  observed range (`sqrtRangeOf()`/`lerpRadius()`, `graphNodeSize.js`) rather than an absolute
 *  `MIN + sqrt(count) * SCALE` formula. `MIN_NODE_RADIUS` was `5` -- the pre-#1270 'uniform' mode's
 *  fixed dot radius -- doubled to `10` by OpenProject #2594 (the floor now has to leave room for a
 *  legible page title rendered INSIDE the node rather than beside it, Task #2593, which a 5px dot
 *  cannot do at any font size), and doubled again to `20` per Dylan's hands-on review (OpenProject
 *  #2900). Nothing else keys off it: `lerpRadius()` takes it as a parameter, `collideRadiusFor()`
 *  derives from `radiusFor()` and so rescales on its own, and a synthetic folder/root hub keeps its
 *  own fixed `3` (see `radiusFor()`), deliberately below the real-node floor. `MAX_NODE_RADIUS` is
 *  `5x` the old `22` cap (OpenProject #2561) and is left untouched by #2900 -- the lerp's own
 *  normalization is what makes a ceiling this much larger workable at all: only the single
 *  highest-ranked node in the currently-loaded graph ever actually draws at it, everything else
 *  scales down from there. */
const MIN_NODE_RADIUS = 20
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
 *  current `x`/`y`s and re-colors/re-circles clusters via `recomputeClusters()`. Call whenever
 *  nodes may have moved or the visible set may have changed -- a simulation tick, a resize, a
 *  sizing change -- never for a pan/zoom alone, where no node's position changed, only the canvas
 *  transform (OpenProject #1837; `recomputeClusters()`'s O(n log n) quadtree build plus per-group
 *  cluster-circle work used to run at pointer/wheel frequency for a picture whose geometry hadn't
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
    minRadius: MIN_NODE_RADIUS,
    dark: dark.isActive,
    highlightedIds: highlightedNodeIds.value,
    dimmingIds: keywordHighlightedNodeIds.value,
    hoveredNode: hoveredNode.value
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

/** Hit-tests a click/hover point against each candidate's OWN rendered size
 *  (`collideRadiusFor()` -- `radiusFor()` plus the same small padding the collision force already
 *  uses, rather than a second flat constant) instead of one flat radius for every node (OpenProject
 *  #2748) -- a node's hit area now actually tracks its drawn size across the full
 *  `MIN_NODE_RADIUS`..`MAX_NODE_RADIUS` range instead of only being roughly right at the (small,
 *  pre-#2594) end of it. `d3-quadtree#find(x, y, radius)` only supports a single flat search radius,
 *  so this walks the tree by hand via `visit()`: a quadrant is pruned only when its bounding box
 *  cannot contain a point within `MAX_NODE_RADIUS` of the click -- the largest any node's own hit
 *  radius can be -- and every surviving candidate is then checked against its OWN radius, not the
 *  search bound. The nearest candidate that actually contains the point wins, the same nearest-wins
 *  tie-break `d3-quadtree#find()` itself used. A quadrant's leaf may chain more than one node via
 *  `.next` (`d3-quadtree`'s representation for coincident points), so every node in that chain is
 *  checked, not just the first. */
function findNodeAt(clientX, clientY) {
  if (!nodeQuadtree) {
    return null
  }
  const { x, y } = toGraphSpace(clientX, clientY)
  let best = null
  let bestDist = Infinity
  nodeQuadtree.visit((quad, x0, y0, x1, y1) => {
    if (!quad.length) {
      let leaf = quad
      do {
        const node = leaf.data
        const dist = Math.hypot(node.x - x, node.y - y)
        if (dist <= collideRadiusFor(node) && dist < bestDist) {
          bestDist = dist
          best = node
        }
      } while ((leaf = leaf.next))
    }
    return (
      x0 > x + MAX_NODE_RADIUS ||
      x1 < x - MAX_NODE_RADIUS ||
      y0 > y + MAX_NODE_RADIUS ||
      y1 < y - MAX_NODE_RADIUS
    )
  })
  return best
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

/** A first click on a real node selects it (`selectedNodeId`, no navigation); a second click on the
 *  SAME already-selected node navigates to its page and clears the selection (the click just left
 *  the graph, so there is nothing left to show as selected); a click on a DIFFERENT node re-selects
 *  that one instead of navigating -- three-way behavior required by OpenProject #3363. A click that
 *  misses every node, or lands on a synthetic folder/root node (no real page to select or navigate
 *  to), is a no-op and leaves any existing selection exactly as it was, same as `navigateToNode`'s
 *  own long-standing guard for the miss/synthetic case. */
function onCanvasClick(event) {
  const node = findNodeAt(event.clientX, event.clientY)
  if (!node || node.synthetic) {
    return
  }
  const clickedId = nodeId(node)
  if (selectedNodeId.value === clickedId) {
    selectedNodeId.value = null
    graphStore.clearSelection()
    navigateToNode(node)
    return
  }
  selectedNodeId.value = clickedId
  graphStore.select(node.path)
}

/** Alpha `simulation.alpha(...).restart()` is bumped to right after a hover push impulse -- small
 *  on purpose, so the settle reads as a brief, subtle pulse rather than the whole layout visibly
 *  reworking itself, the way a fresh filter/edit (`0.3`/`0.5` elsewhere in this file) does. */
const HOVER_PUSH_ALPHA = 0.15

/** Releases the currently-hovered node (if any) back into the simulation -- clears the `fx`/`fy`
 *  pin `onCanvasMouseMove` set and drops `hoveredNode` (which also hides the tooltip and the
 *  `--hover` cursor class). The ONE release path shared by every way a hover can end: hover
 *  moving onto empty canvas, hover moving straight onto a different node, and the pointer leaving
 *  the canvas element entirely (OpenProject #2931) -- that last one fires no further `mousemove`
 *  on the canvas, so without `onCanvasMouseLeave` the node stayed pinned forever. Deliberately
 *  does NOT repaint: each caller paints exactly once after it has finished its own changes, so a
 *  hover-change (release + pin) is one paint, not two. Answers whether anything was released. */
function releaseHoveredNode() {
  if (!hoveredNode.value) {
    return false
  }
  hoveredNode.value.fx = null
  hoveredNode.value.fy = null
  hoveredNode.value = null
  return true
}

function onCanvasMouseLeave() {
  if (releaseHoveredNode()) {
    repaint()
  }
}

function onCanvasMouseMove(event) {
  const nextHovered = findNodeAt(event.clientX, event.clientY)
  if (nextHovered !== hoveredNode.value) {
    // -> Release the previously-hovered node (if any) before pinning the next one -- this covers
    //    hover moving directly from one node to another, not just hover-end onto empty canvas,
    //    since `hoveredNode.value` is read inside the helper before being reassigned below.
    releaseHoveredNode()
    // -> Only on an actual mouseover of a (possibly different) node, never on leaving one: moving
    //    OFF a node onto empty canvas sets `nextHovered` to `null`, which this guard excludes.
    if (nextHovered) {
      // -> Pin the hovered node stationary at its current position so it stops animating while
      //    other nodes keep moving (OpenProject #2924/#2907) -- a defined fx/fy freezes a d3-force
      //    node against every force each tick, and is cleared above on hover-end/hover-change.
      nextHovered.fx = nextHovered.x
      nextHovered.fy = nextHovered.y
      applyHoverPushImpulse(nodes.value, nextHovered)
      simulation?.alpha(HOVER_PUSH_ALPHA).restart()
    }
    hoveredNode.value = nextHovered
    repaint()
  }
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
      },
      clusterLevels: CLUSTER_LEVELS
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
  clusters.value = buildClusters(nodes.value, {
    groupKeyFor,
    colorForGroup,
    radiusFor,
    levels: CLUSTER_LEVELS,
    parentGroupKeyFor
  })
}

function attachZoom() {
  attachGraphZoom(canvasRef.value, (transform) => {
    zoomTransform.value = transform
    // -> Only the canvas transform changed, no node moved -- repaint only (OpenProject #1837).
    repaint()
  })
  zoomTransform.value = zoomIdentity
}

/** The actual node object `applyRouteFocus()` currently has pinned to the viewport center, if any
 *  -- not merely its id, which `focusNodeId` already tracks for the highlight ring. Kept so a LIVE
 *  re-focus (OpenProject #3334) can release the previous target's `fx`/`fy` pin before handing the
 *  center point to the new one; without this, the old target would stay pinned forever, stacked on
 *  top of the new one at the exact same point. Plain module state, not a ref -- nothing templates
 *  or watches off the node object itself, only off `focusNodeId`. Reset alongside
 *  `syntheticNodeCache` in `loadGraph()`: a fresh fetch is a wholesale new graph, so any node
 *  identity a previous load pinned no longer exists to release. */
let pinnedFocusNode = null

/** Centers and highlights the anchor the reader arrived from, addressed by the `path` query param on
 *  `/_graph` (OpenProject #3312, Feature #3311; folder/root anchoring OpenProject #3337) -- e.g. the
 *  header's Graph button (which sends the current page's nearest containing folder, root for a
 *  top-level page -- `HeaderNav.vue#onGraphNavClick()`), or a bookmarked/shared link. Called once,
 *  mount-only, from `loadGraph()`'s initial fetch (same "read once" framing `loadGraph()`'s own
 *  `activeFilters.folderDepth` default already uses just above its call site below) -- a later filter
 *  or keyword change must not re-home the focus.
 *
 *  Also re-run live, by the `watch(() => route.query.path, applyRouteFocus)` further down
 *  (OpenProject #3334): the sidebar's own in-graph re-root branch
 *  (`navSidebarDestination.js#graphSidebarBranch`, OpenProject #3313) updates `route.query.path` via
 *  `router.replace()` while `/_graph` stays mounted the whole time -- no remount, so `onMounted`
 *  (and therefore this function's mount-time call) never re-fires on its own. That watch is what
 *  makes a live sidebar click while `/_graph` is already open actually move the focus; without it,
 *  the URL's `path` query param updated but nothing downstream ever noticed. The watch is not
 *  `immediate: true` -- the initial value is already handled by `loadGraph()`'s own call below, and
 *  this function no-ops (see the `focusNode === pinnedFocusNode` guard below) whenever the resolved
 *  node hasn't actually changed, which is what keeps the two call sites from double-running against
 *  the same target.
 *
 *  Locale resolution rule: `route.query.path` is a bare, un-prefixed path -- the same raw form nav
 *  tree items carry (`item.path`, per sibling WP #3313's `composables/navSidebarDestination.js`) --
 *  and a bare path is ambiguous on a multi-locale site (`graphFilters.js#nodeId`'s own doc comment:
 *  two locales' translations of the same page share a `path` by design). `/_graph`
 *  (`router/routes.js`) carries no locale segment of its own to resolve against, so this scopes the
 *  match to `pageStore.locale` -- the locale of whichever page the reader was actually reading
 *  before navigating here, set by `pageLoad()` on every page navigation. That is the same field
 *  `navSidebarDestination.js` already documents as "the right locale to build a nav link in," for
 *  the identical "no per-row/per-param locale of its own" reason, which is what keeps this
 *  consistent with #3313's nav-tree-sourced `path`. A guest who lands on `/_graph` with no page ever
 *  loaded this session reads `pageStore`'s own default (`'en'`).
 *
 *  No match -- a missing param, a stale path, or one in the wrong locale -- is a silent no-op: no
 *  pin, no highlight, same as before this WP existed. `route.query.path` as an array (a repeated
 *  query param) takes the first entry, same convention a `<w-select>`-less bare query reader would.
 *  Resolves against a freshly-computed UN-anchored node set -- `computeVisibleSubset(allNodes.value,
 *  allEdges.value, activeFilters, null)`'s `visibleNodes` plus the synthetic folder/root nodes
 *  `buildPathHierarchyEdges` builds from them -- rather than `nodes.value` itself, deliberately: on
 *  a LIVE re-focus (OpenProject #3334) `nodes.value` may already be narrowed to a PREVIOUS anchor's
 *  descendants (OpenProject #3333/#3337's own restriction, applied by `applyFilters()`), which would
 *  make a node outside that subtree permanently unresolvable even though it is a perfectly valid new
 *  anchor. `allNodes.value`/`activeFilters` stay the same regardless of anchor, so recomputing this
 *  way always offers every tag/locale/depth-eligible node as a candidate. `resolveFocusNode`'s
 *  `includeSynthetic: true` here is what lets a folder/root anchor (`path: ''` for the root, per
 *  `pageStore.folderPath`'s own doc comment) resolve at all -- the default page-only match excludes
 *  them. The real-node entries of this set are the same object references `allNodes.value` holds
 *  (`computeVisibleSubset` filters, never clones), so a match still pins the exact object the
 *  simulation below runs on; `nodes.value` itself is narrowed to the new anchor separately, by the
 *  `watch(focusNodeId, ...)` below re-running `applyFilters()` once this function sets `focusNodeId`.
 *
 *  Centering reuses the hover pin's own `fx`/`fy` mechanic (`onCanvasMouseMove` below): the resolved
 *  node is pinned to the exact `(width/2, height/2)` point `startSimulation()`'s own `forceCenter`
 *  already targets, so d3-force settles the rest of the layout around it -- anchored at the viewport
 *  center rather than the node's own current position, and never released on its own the way the
 *  hover pin clears on hover-end -- only ever replaced by a later call's own release of it (below),
 *  never by anything time- or pointer-based. Highlighting folds the node's composite id into
 *  `focusNodeId`, which `highlightedNodeIds` above unions in alongside a keyword match, so it draws
 *  with the identical highlight ring `graphDraw.js` already renders -- no draw-layer change needed.
 *
 *  Also sets `routeFocusAnchor` (OpenProject #3333) to the resolved node's `{ path, locale }` --
 *  read by `applyFilters()` to restrict the rendered set to the anchor plus its descendants. A
 *  no-match leaves `routeFocusAnchor` untouched rather than clearing it to `null`, same as
 *  `focusNodeId`'s own silent no-op above; today (mount-only call) that distinction has no
 *  observable effect, but it keeps this function's two outputs consistent with each other rather
 *  than one silently resetting while the other doesn't. */
function applyRouteFocus() {
  const rawPath = route.query.path
  const path = Array.isArray(rawPath) ? rawPath[0] : rawPath
  const { visibleNodes: unanchoredNodes } = computeVisibleSubset(
    allNodes.value,
    allEdges.value,
    activeFilters,
    null
  )
  const { syntheticNodes: unanchoredSyntheticNodes } = buildPathHierarchyEdges(
    unanchoredNodes,
    syntheticNodeCache
  )
  const focusNode = resolveFocusNode(
    [...unanchoredNodes, ...unanchoredSyntheticNodes],
    path,
    pageStore.locale,
    { includeSynthetic: true }
  )
  // -> No match (a missing/blank param, a stale path, or one in the wrong locale) is a silent
  //    no-op -- same as before OpenProject #3334, and also what keeps a live re-focus from
  //    releasing an already-good pin over a transient/bad query value. Likewise a match that IS
  //    already the pinned target (the mount-time call landing here a second time via the watch
  //    below with nothing having actually changed, or two rapid clicks on the same sidebar item)
  //    is a no-op too -- see this function's own doc comment on why the two call sites need this
  //    guard to not double-run.
  if (!focusNode || focusNode === pinnedFocusNode) {
    return
  }
  // -> Release the previously-pinned target (if any) before handing the center point to the new
  //    one (OpenProject #3334) -- without this, a live re-focus would leave the old target's
  //    `fx`/`fy` still pinned at the exact same point as the new one, forever.
  if (pinnedFocusNode) {
    pinnedFocusNode.fx = null
    pinnedFocusNode.fy = null
  }
  pinnedFocusNode = focusNode
  focusNodeId.value = nodeId(focusNode)
  routeFocusAnchor.value = { path: focusNode.path, locale: focusNode.locale }
  const { width, height } = containerRef.value.getBoundingClientRect()
  focusNode.fx = width / 2
  focusNode.fy = height / 2
  // -> Only a LIVE re-focus needs to nudge the simulation back awake -- the mount-time call runs
  //    before `startSimulation()` has attached one at all (see this function's own doc comment on
  //    why the pin has to land first), so `simulation` is still `null` there and this is correctly
  //    a no-op for that call; a later call via the `route.query.path` watch runs against an
  //    already-settled simulation, which needs a real bump to visibly re-center rather than
  //    silently update a resting layout's target point.
  simulation?.alpha(0.4).restart()
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
  //    positions from the previous one must not leak into it (OpenProject #2538). `pinnedFocusNode`
  //    is the same story for OpenProject #3334's route-focus pin: the node object it may still be
  //    holding belongs to the graph that is about to be replaced, and has nothing left to release.
  syntheticNodeCache = new Map()
  pinnedFocusNode = null
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
    // -> Before `startSimulation()` (OpenProject #3312): `initializeNodes()` (d3-force) seeds a
    //    node's initial `x`/`y` from its `fx`/`fy` when set, so resolving/pinning the focus node
    //    here is what lets it spawn already at center instead of jittering in from d3-force's
    //    default phyllotaxis placement over the first several ticks.
    applyRouteFocus()
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
  pageviewsTrackingResolved = true
  // -> OpenProject #2854: `watch(pageviewsTrackingEnabled, reconcileSizeByForTracking)` below only
  //    fires on an actual VALUE CHANGE. `pageviewsTrackingEnabled` starts at its own literal `false`,
  //    so a check that resolves to `false` -- no change at all -- would never reconcile a persisted
  //    `sizeBy: 'visits'` preference `loadGraphPrefs()` may have already applied before this
  //    resolved. Calling the same reconciliation here explicitly, once, unconditionally, covers that
  //    case regardless of which of the two loads finishes first; it is a no-op wherever the watch's
  //    own transition already produced the same outcome.
  reconcileSizeByForTracking(pageviewsTrackingEnabled.value)
}

/** Reads this reader's own previously-saved graph view preferences off their profile (OpenProject
 *  #2854), applying whichever of the five are present onto their matching ref -- a control the
 *  reader has never touched keeps its own corrected default (`sizeBy`/`sizeCountMode`'s literals
 *  above, or the plain literals the other three always had). `sizeBy` specifically is applied
 *  directly here (not gated on `pageviewsTrackingEnabled`, which may not have resolved yet) and then
 *  reconciled against the tracking state by `reconcileSizeByForTracking()`, called from this
 *  function's own end, from `loadPageviewsTrackingState()`, and from the `pageviewsTrackingEnabled`
 *  watch below (OpenProject #2880 added this function's own call, alongside the pre-existing other
 *  two) -- whichever of the two async loads finishes last is what leaves `sizeBy` in its final,
 *  correct state, regardless of which order they settle in.
 *
 *  Skipped for a guest reader: `GET profile` is session-authenticated, and a guest has no profile to
 *  have ever saved one onto. Called from `onMounted`, alongside `loadPageviewsTrackingState()`. */
async function loadGraphPrefs() {
  if (!userStore.authenticated) {
    return
  }
  try {
    const resp = await API_CLIENT.get('users/profile').json()
    const saved = resp?.graph ?? {}
    if (saved.groupBy !== undefined) {
      groupBy.value = saved.groupBy
    }
    if (saved.sizeBy !== undefined) {
      hasPersistedSizeBy = true
      sizeBy.value = saved.sizeBy
    }
    if (saved.count !== undefined) {
      sizeCountMode.value = saved.count
    }
    if (saved.over !== undefined) {
      pageviewsWindow.value = saved.over
    }
    if (Array.isArray(saved.clientTypes)) {
      pageviewClientTypes.value = saved.clientTypes
    }
  } catch (err) {
    log.warn('graph', 'could not load persisted graph view preferences', err)
  }
  // -> OpenProject #2880: the mirror image of `loadPageviewsTrackingState()`'s own explicit call
  //    below, guarded by `pageviewsTrackingResolved` (see that flag's own doc comment for why the
  //    guard is required -- reconciling against a not-yet-checked `pageviewsTrackingEnabled` would
  //    do the wrong thing). `watch(pageviewsTrackingEnabled, ...)` only fires on an actual value
  //    CHANGE, so if `system/pageviews` happens to resolve (and settle at a value with no further
  //    change) BEFORE this function applies a persisted `sizeBy` above, nothing would otherwise
  //    re-reconcile the result -- `loadPageviewsTrackingState()`'s own call ran too early to see the
  //    persisted value this function just applied. Calling the same reconciliation here too, once,
  //    covers that ordering as well; when the tracking check hasn't resolved yet, this is a no-op by
  //    design -- `loadPageviewsTrackingState()`'s own call reconciles correctly once it does.
  if (pageviewsTrackingResolved) {
    reconcileSizeByForTracking(pageviewsTrackingEnabled.value)
  }
}

/** Saves the five graph view controls back onto this reader's profile (OpenProject #2854), merged
 *  into one `graph` object -- the existing profile PATCH route's whitelist replaces that whole key
 *  rather than merging into it (same as `aesthetic`/`appearance`/`locale`), so every save sends all
 *  five together regardless of which one actually changed. A no-op for a guest reader, who has no
 *  profile to save onto; a failure is logged and otherwise swallowed, the same tolerance
 *  `loadGraphPrefs()` gives its own read -- losing a preference save is not worth interrupting the
 *  reader's actual task of looking at the graph. */
async function saveGraphPrefs() {
  if (!userStore.authenticated) {
    return
  }
  try {
    await API_CLIENT.put('users/profile', {
      json: {
        graph: {
          groupBy: groupBy.value,
          sizeBy: sizeBy.value,
          count: sizeCountMode.value,
          over: pageviewsWindow.value,
          clientTypes: pageviewClientTypes.value
        }
      }
    }).json()
  } catch (err) {
    log.warn('graph', 'could not save graph view preferences', err)
  }
}

/** How long to wait after the last of a burst of control changes before saving (OpenProject #2854)
 *  -- same window `EditorMarkdown.vue`'s own content-change debounce uses for syncing to the store. */
const GRAPH_PREFS_SAVE_DEBOUNCE_MS = 500

const debouncedSaveGraphPrefs = debounce(saveGraphPrefs, GRAPH_PREFS_SAVE_DEBOUNCE_MS)

/** Guards `debouncedSaveGraphPrefs()` against firing off the load itself: `loadGraphPrefs()` and
 *  `reconcileSizeByForTracking()` both assign the very refs the watch below saves, and neither
 *  reflects a reader's own action. Flipped once, in `onMounted`, only after BOTH loads that touch
 *  these refs (`loadGraphPrefs()`, `loadPageviewsTrackingState()`) have settled -- before that, a
 *  save would race the load, potentially persisting a still-resolving `sizeBy` (OpenProject #2853's
 *  own async-timing problem, which a save fired mid-resolution would reintroduce for #2854). */
let graphPrefsReady = false

/** Runs `loadGraphPrefs()` and `loadPageviewsTrackingState()` (whichever settles last decides
 *  `sizeBy`'s final value, per their own doc comments), then waits one `nextTick()` before flipping
 *  `graphPrefsReady` -- Vue's own watchers run as queued jobs, flushed on a microtask, so a mutation
 *  either load made to `groupBy`/`sizeBy`/... schedules the save-watch's callback onto that same
 *  queue; without this extra tick, `graphPrefsReady` could already read `true` by the time that
 *  queued callback actually runs, which is exactly the race this flag exists to prevent. Awaiting
 *  `nextTick()` guarantees any such pending callback has already run (and no-opped, correctly, on
 *  `graphPrefsReady` still being `false`) before this function sets it. */
async function initializeGraphPrefs() {
  await Promise.all([loadGraphPrefs(), loadPageviewsTrackingState()])
  await nextTick()
  graphPrefsReady = true
}

/** Recomputes `nodes.value`/`edges.value` (what the simulation actually runs on) from `allNodes`
 *  against `activeFilters`, then layers on `buildPathHierarchyEdges`'s synthetic folder/root nodes
 *  and edges -- the graph's sole edge source (OpenProject #2580 removed the sibling `'tags'`/
 *  `'classification'` hub-edge modes that used to be selectable here, so every non-root node now
 *  has exactly one incoming `type: 'path'` edge, a strict tree). The 872 endpoint's `relation`/
 *  `link` edges (`computeVisibleSubset`'s `visibleEdges`) are deliberately not used here; see
 *  OpenProject #997. Called on initial load and by the `activeFilters` watcher below. Does not
 *  touch the live simulation itself; that's `syncSimulationToVisibleSet`'s job, since the initial
 *  call here runs before `startSimulation()` has created one.
 *
 *  Passes `routeFocusAnchor` as `computeVisibleSubset()`'s fourth argument (OpenProject #3333):
 *  while a non-root anchor is active, this additionally restricts the rendered set to the anchor
 *  plus its descendants, and reinterprets `activeFilters.folderDepth` as hops-from-the-anchor
 *  rather than path-segments-from-root -- see that function's own doc comment in `graphFilters.js`
 *  for the full behavior, including why a root anchor computes identically to no anchor at all.
 *
 *  Also passes `routeFocusAnchor.value?.path` as `buildPathHierarchyEdges()`'s own anchor cap
 *  (OpenProject #3361) -- without it, that call would still climb every already-restricted
 *  `visibleNodes` entry's full ancestor chain up to the TRUE root regardless of the anchor,
 *  re-synthesizing everything above the anchor (including root itself) straight back into
 *  `nodes.value` and defeating the restriction above for exactly the nodes it exists to keep out. */
function applyFilters() {
  const { visibleNodes } = computeVisibleSubset(
    allNodes.value,
    allEdges.value,
    activeFilters,
    routeFocusAnchor.value
  )
  const { syntheticNodes, edges: syntheticEdges } = buildPathHierarchyEdges(
    visibleNodes,
    syntheticNodeCache,
    routeFocusAnchor.value?.path ?? ''
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
 *  plain in-place change wouldn't be picked up. `forceLink`'s own target distance
 *  (`linkDistanceFor()`, OpenProject #2562) needs the same treatment and used to be missed here
 *  (OpenProject #2749): d3-force evaluates `.distance()` once, at attach time, exactly like
 *  `collide`'s radius (see `graphSimulation.js`'s own doc comment), so leaving it untouched left
 *  every link's resting distance frozen at whatever radii existed when the simulation last
 *  (re)started -- a large node bumping into a small one after a live "size by" change, even though
 *  `collide`'s own minimum separation was already tracking the new radii correctly. Calling
 *  `.distance()` again on the ALREADY-attached link force (rather than re-attaching a brand new
 *  `forceLink` instance, the way `collide` does) is enough: it re-runs d3-force's own
 *  `initializeDistance()` synchronously against the current `edges.value`, with no need to
 *  re-resolve `link.source`/`link.target` from ids the way a fresh attachment would. No
 *  `applyFilters()`/`syncSimulationToVisibleSet()` call needed either way: neither the visible
 *  node set nor the edge set changes here, only how big each dot draws and how much room
 *  `collide`/`link` give it. */
watch([sizeBy, sizeCountMode, contributorTypes, pageviewsWindow, pageviewClientTypes], () => {
  // -> Refresh BEFORE re-attaching `collide`/`link` (OpenProject #2561): the new attachment
  //    snapshots every node's radius immediately, off whichever metric/count-mode just became
  //    active, so the range has to already reflect that switch -- `relayout()`'s own
  //    `computeClusters()` refresh below runs too late for this specific force-initialize moment.
  refreshMetricRange()
  simulation?.force('collide', forceCollide(collideRadiusFor))
  simulation?.force('link')?.distance((link) => linkDistanceFor(link, collideRadiusFor))
  simulation?.alpha(0.3).restart()
  relayout()
  repaint()
})

/** This is where `sizeBy`'s REAL default (its own doc comment above) actually gets applied, the
 *  moment `pageviewsTrackingEnabled` resolves either way (OpenProject #2853):
 *  - turns on: promote 'edits' -> 'visits' -- but only while `sizeBy` still holds its own untouched
 *    declared default AND no persisted preference has been loaded (`hasPersistedSizeBy`, OpenProject
 *    #2854): a reader who already picked 'edits' by hand in the brief window before this resolves,
 *    or who saved 'edits' deliberately on an earlier visit, keeps that choice rather than being
 *    overridden.
 *  - turns off (OpenProject #1140's own scope decision: while tracking is off, 'visits' sizing has
 *    no data behind it -- e.g. the admin opt-out flips live, in another tab): fall back from
 *    'visits' to 'edits' rather than leaving a now-hidden option selected, even for a persisted
 *    'visits' preference -- there is nothing to size by while tracking is off, persisted or not. No
 *    'uniform' mode to fall back to any more (OpenProject #1270).
 *
 *  Extracted to a named function (OpenProject #2854) rather than an inline watch callback so
 *  `loadPageviewsTrackingState()` and `loadGraphPrefs()` (OpenProject #2880) can each call it
 *  directly too, once, after resolving -- `watch(pageviewsTrackingEnabled, ...)` only fires on an
 *  actual value change, which a check that resolves to the ref's own initial `false` never produces,
 *  and neither load knows whether it is the one settling last. */
function reconcileSizeByForTracking(enabled) {
  if (enabled && sizeBy.value === 'edits' && !hasPersistedSizeBy) {
    sizeBy.value = 'visits'
  } else if (!enabled && sizeBy.value === 'visits') {
    sizeBy.value = 'edits'
  }
}

watch(pageviewsTrackingEnabled, reconcileSizeByForTracking)

/** Persists the five graph view controls (OpenProject #2854) whenever any of them changes --
 *  `groupBy`'s own separate watch above still handles re-clustering/repainting; this one only saves.
 *  Guarded by `graphPrefsReady` so neither the initial load (`loadGraphPrefs()`,
 *  `reconcileSizeByForTracking()` assigning these same refs) nor the brief window before it settles
 *  fires a save of its own -- see that flag's doc comment. Not `{ deep: true }`: `pageviewClientTypes`
 *  is always reassigned wholesale by its `w-btn-toggle`-style control, never mutated in place, the
 *  same convention the `[sizeBy, sizeCountMode, contributorTypes, pageviewsWindow,
 *  pageviewClientTypes]` watch above already relies on. */
watch([groupBy, sizeBy, sizeCountMode, pageviewsWindow, pageviewClientTypes], () => {
  if (!graphPrefsReady) {
    return
  }
  debouncedSaveGraphPrefs()
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

/** OpenProject #3333 (Feature #3311's own follow-up scope correction, this round's epic-plan note
 *  #9742): re-runs the same anchor-plus-descendants restriction `activeFilters`'s own watcher above
 *  runs for a filter change, but keyed off `focusNodeId` instead -- today that only ever changes
 *  once, from `loadGraph()`'s own mount-time `applyRouteFocus()` call, but nothing else in this
 *  round's Group A work (#3334's live sidebar-click re-homing) can make the anchor restriction
 *  react to a later navigation without this watcher existing to catch the resulting `focusNodeId`
 *  change. Deliberately NOT `{ deep: true }`: `focusNodeId` is a plain string/`null` ref, matching
 *  its own doc comment above. */
watch(focusNodeId, () => {
  applyFilters()
  syncSimulationToVisibleSet()
})

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

/** OpenProject #3334: re-runs `applyRouteFocus()` on every LIVE change to `route.query.path` --
 *  see that function's own doc comment for the full story (the sidebar's in-graph re-root branch
 *  updates the query param via `router.replace()` while `/_graph` stays mounted, which `onMounted`
 *  never sees) and for why this deliberately is not `immediate: true`. A getter source (not the
 *  route object itself) so this fires only on the one field the graph's focus actually depends on,
 *  not on every unrelated query-param or route change `/_graph` might otherwise see. */
watch(() => route.query.path, applyRouteFocus)

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    sizeCanvas()
    relayout()
    repaint()
  })
  resizeObserver.observe(containerRef.value)
  loadGraph()
  // -> `loadGraph()` above stays the first `API_CLIENT.get` call (OpenProject #2853's own ordering
  //    note above `loadPageviewsTrackingState()`). `initializeGraphPrefs()` calls
  //    `loadGraphPrefs()` before `loadPageviewsTrackingState()` (both run synchronously up to their
  //    first `await`, in argument order), so its own `GET profile` call -- issued only when
  //    authenticated -- lands second and `system/pageviews` third, a stable, test-predictable order.
  initializeGraphPrefs()
})

onBeforeUnmount(() => {
  simulation?.stop()
  resizeObserver?.disconnect()
  debouncedSearchKeyword.cancel()
  debouncedSaveGraphPrefs.cancel()
  // -> The nav sidebar's `is-graph-selected` indicator (OpenProject #3364) has nothing left to
  //    highlight once this page is gone -- without this, a selection made just before navigating
  //    away would otherwise keep marking that row as "selected" indefinitely.
  graphStore.clearSelection()
})
</script>

<style scoped>
.graph-view {
  position: relative;
  width: 100%;
  /* -> Fills whatever height MainLayout's <w-page-container> gives it; the canvas itself is */
  /*    sized to match via a ResizeObserver wired up in Task 12/13, not a fixed value here. */
  height: 100%;
  min-height: 480px;
}

.graph-view-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: default;

  &--hover {
    cursor: pointer;
  }
}

/*
  The two panels over the canvas are PANELS: an opaque surface with a hairline edge, as the design
  draws them (`ui-redesign/Cardinal Wiki - Graph 3x.dc.html`). They used to be translucent washes with
  a backdrop blur, which is frosted glass -- a material this language does not have, and one that put
  the graph's own edges behind every control on it.

  A plain shared class, not a Sass `@mixin` (`.graph-view-right-rail`/`.graph-view-filters` both
  carry `graph-panel` in the template) -- native CSS nesting has no mixin equivalent, and this is the
  only mixin the codebase had (docs/frontend-sass-removal-plan.md).
*/
.graph-panel {
  position: absolute;
  top: 16px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  padding: 14px;

  .body--light & {
    background-color: var(--color-white);
    border: 1px solid var(--color-hairline);
    color: var(--color-text-body);
  }
  .body--dark & {
    background-color: var(--color-dark-3);
    border: 1px solid var(--color-hairline-dark);
    color: var(--color-text-dark);
  }

  /*
    Both panels (`.graph-view-right-rail`, `.graph-view-filters`) draw their Cobalt edge through
    `--shadow-card` alone, not the `border` above -- `--radius-card`/`--shadow-card` are `0`/`none`
    under Ledger, so that border stays the only visible edge there. Under Cobalt `--shadow-card` is
    itself a hairline ring now (OpenProject #2856's matte pass), not the mockup's blurred
    `background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(16,25,74,.08)` glow.
  */
  body.body--cobalt & {
    border: 0;
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
  }
}

.graph-view-right-rail {
  right: 16px;
  gap: 14px;
  align-items: flex-end;
  width: 236px;
  max-height: calc(100% - 32px);
}

.graph-view-controls {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
}

.graph-view-control-group {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  width: 100%;
}

/*
  SIZE BY's two toggles (Unique/Total, then Edits/Visits) sitting side by side under their shared
  caption (OpenProject #2855/#2828 item 3). `flex-wrap` stays as a genuine fallback for a locale whose
  combined option labels run long, but a real headless-Chromium render at the panel's actual content
  width (236px panel, 14px padding + 1px border each side -> ~206px available) found the English
  default itself wrapping to two lines with `WBtnToggle`'s stock `px-3` segment padding -- ~229px
  combined, not a hypothetical (OpenProject #2892). The `:deep()` override below narrows just this
  row's segments (not `WBtnToggle`'s shared default, so no other caller of the component is affected)
  to fit with real headroom: the same measurement at 6px padding comes out to ~181px, a ~25px margin
  rather than a bare pass.
*/
.graph-view-control-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;

  :deep(.w-btn-toggle__segment) {
    padding-inline: 6px;
  }
}

/* -> The language's own control overline: mono, small, letter-spaced, in the caption tier */
.graph-view-control-caption {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;

  .body--light & {
    color: var(--color-text-caption);
  }
  .body--dark & {
    color: var(--color-text-caption-dark);
  }
}

.graph-view-filters {
  left: 16px;
  gap: 12px;
  width: 268px;
}

.graph-view-truncation-notice {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
  max-width: min(520px, calc(100% - 32px));
  padding: 6px 12px;
  font-size: 12px;
  text-align: center;

  .body--light & {
    background-color: var(--color-white);
    border: 1px solid var(--color-accent-fill);
    color: var(--color-slate);
  }
  .body--dark & {
    background-color: var(--color-dark-3);
    border: 1px solid var(--color-accent-dark);
    color: var(--color-text-secondary-dark);
  }

  /*
    Cobalt's own truncation pill drops the accent border entirely, closest existing tokens rather
    than a new one-off shadow: `--radius-card`/`--shadow-card`. The mockup drew this as a plain
    shadowed sheet (`background:#fff;border-radius:8px;box-shadow:0 4px 14px rgba(16,25,74,.14)`);
    under the matte pass (OpenProject #2856) `--shadow-card` is a hairline ring instead, so the pill
    now reads as a plain hairline-bordered plate rather than an accent-outlined or shadowed one.
  */
  body.body--cobalt & {
    border: 0;
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
  }
}

/* -> Inside the rail panel already, so a tint and a hairline are all this needs to read as its own block */
.graph-view-legend {
  display: flex;
  flex-direction: column;
  flex: none;
  gap: 4px;
  width: 100%;
  padding: 8px 10px;
  max-height: 240px;
  overflow-y: auto;

  .body--light & {
    background-color: var(--color-tint);
    border: 1px solid var(--color-hairline);
  }
  .body--dark & {
    background-color: var(--color-dark-2);
    border: 1px solid var(--color-hairline-dark);
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

  .body--light & {
    color: rgba(0, 0, 0, 0.8);
  }
  .body--dark & {
    color: #fff;
  }
}

.graph-view-fallback,
.graph-view-fallback ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

/*
  Solid ink rather than a black wash: the design's own tooltip plate. `var(--color-ink)`, not the
  `var(--color-ink)` literal it replaces: numerically identical under Ledger, and the Cobalt Graph mockup's own
  tooltip (`background:#10194a;color:#fff`) is exactly Cobalt's `--color-ink`, so this now matches
  it for free with no per-aesthetic branch.
*/
.graph-view-tooltip {
  position: absolute;
  z-index: 1;
  pointer-events: none;
  padding: 5px 9px;
  background-color: var(--color-ink);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
}
</style>
