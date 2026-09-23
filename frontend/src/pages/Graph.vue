<template>
  <div ref="containerRef" class="graph-view">
    <canvas
      ref="canvasRef"
      class="graph-view-canvas"
      :class="{ 'graph-view-canvas--hover': showsPointerCursor }"
      role="img"
      :aria-label="graphAccessibleName"
      @click="onCanvasClick"
      @mousemove="onCanvasMouseMove"
      @mouseleave="onCanvasMouseLeave">
      <!--
        Canvas fallback content: a focusable text alternative to the painted graph, built from the
        same `nodes`/`edges` the canvas draws so it always describes what is on screen. A synthetic
        folder/root node has no page to link to, so it appears only as a neighbor.
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
      The graph caps how many nodes it draws, and the filters below act on that cap rather than on
      the whole site -- said plainly rather than left for the reader to notice.
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
          Both toggles share one "SIZE BY" caption, so the count toggle keeps an `aria-label` of its
          own -- its accessible name still differs from the row's visible caption.
        -->
        <div class="graph-view-control-group">
          <span class="graph-view-control-caption">{{ t('graph.controls.sizeByLabel') }}</span>
          <div class="graph-view-control-row">
            <w-btn-toggle
              v-model="sizeCountMode"
              :aria-label="t('graph.controls.countAriaLabel')"
              :options="sizeCountModeOptions"
              :style="{ '--option-count': sizeCountModeOptions.length }" />
            <w-btn-toggle
              v-model="sizeBy"
              :aria-label="t('graph.controls.sizeByLabel')"
              :options="sizeByOptions"
              :style="{ '--option-count': sizeByOptions.length }" />
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
  childCountsFor,
  computeClusters as buildClusters,
  linkDistanceFor,
  startSimulation as runSimulation
} from './graphSimulation.js'

/**
 * A canvas-rendered force graph of every page the caller may read on this site. Fetched once on
 * mount: every filter and re-cluster after that runs against `nodes`/`edges` already in memory,
 * with no further network round trip.
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
 *  `shallowRef` plus `markRaw()` on every element keeps these arrays and the objects inside them
 *  out of Vue's reactivity entirely: d3-force writes `x`/`y`/`vx`/`vy` on every node every tick and
 *  reads node fields constantly inside its quadtrees, none of which anything subscribes to. Every
 *  assignment must therefore reassign `.value` wholesale rather than mutate in place, or the
 *  consumers never update. */
const nodes = shallowRef([])
const edges = shallowRef([])
const isLoading = ref(true)
const loadError = ref(null)

/** The full, unfiltered graph as fetched -- `nodes`/`edges` above hold only the currently VISIBLE
 *  subset the simulation actually runs on. */
const allNodes = shallowRef([])
const allEdges = shallowRef([])

/** Server-side truncation signal: `assembleGraph` caps the node set at `GRAPH_NODE_CAP` and
 *  reports whether it had to. `totalNodes` stays the true readable-page count even when truncated,
 *  so the notice can say how much was cut rather than just that some was. */
const graphTruncated = ref(false)
const totalNodes = ref(0)

/** 'site' is deliberately not an option: a loaded graph has exactly one site value, so grouping by
 *  it would be a no-op control. */
const groupBy = ref('folder')

/** Node-sizing dimension: 'edits' scales a node's radius by its contributor count, 'visits' by its
 *  pageview count. The REAL default is 'visits' when pageview tracking is on, but it is declared
 *  'edits' regardless: `pageviewsTrackingEnabled` reads `false` until its own async check resolves,
 *  and 'edits' is the one value `sizeByOptions` always offers, so 'visits' here would briefly
 *  select an option that isn't there yet. `reconcileSizeByForTracking()` applies the real default
 *  once it is known, unless `loadGraphPrefs()` has already overwritten this with a saved one. */
const sizeBy = ref('edits')

/** Set by `loadGraphPrefs()` the moment a persisted `sizeBy` is found, whatever its value:
 *  `reconcileSizeByForTracking()`'s `sizeBy.value === 'edits'` check cannot otherwise tell a reader
 *  who deliberately saved 'edits' from one who has never touched the control. Plain module state --
 *  nothing templates or watches off it. */
let hasPersistedSizeBy = false

/** Set once `loadPageviewsTrackingState()` has resolved, whatever the outcome: says that
 *  `pageviewsTrackingEnabled` now holds a REAL result rather than its untouched initial `false`.
 *  `loadGraphPrefs()` must not reconcile before this is true -- the profile load ordinarily settles
 *  first, and reconciling against a not-yet-checked `false` would force a persisted
 *  `sizeBy: 'visits'` back to 'edits'. Plain module state, same as `hasPersistedSizeBy`. */
let pageviewsTrackingResolved = false

/** Whether 'edits'/'visits' sizing (and the hover tooltip's count) reads the unique-identity figure
 *  ('unique') or the raw row-count figure ('total'). */
const sizeCountMode = ref('total')

/** Which of `pageHistory.via`'s buckets count toward 'edits' sizing. Irrelevant while `sizeBy` is
 *  'visits', but kept rather than reset so switching back remembers the last filter chosen. */
const contributorTypes = ref(['editor', 'mcp'])

/** Whether pageview tracking is on at all (the admin opt-out). While off nothing is being logged,
 *  so `sizeByOptions` omits 'visits' entirely rather than offering a control over data that does
 *  not exist. Defaults to `false` until the check resolves: hidden-until-proven-on, not
 *  shown-until-proven-off. */
const pageviewsTrackingEnabled = ref(false)

const sizeByOptions = computed(() => {
  const options = []
  if (pageviewsTrackingEnabled.value) {
    options.push({ label: t('graph.controls.sizeByVisits'), value: 'visits' })
  }
  options.push({ label: t('graph.controls.sizeByEdits'), value: 'edits' })
  return options
})

/** Computed, not module-level constants, so each label re-resolves through `t()` if the active
 *  locale changes at runtime. */
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

/** Which of the pageview log's fixed trailing windows 'visits' sizing reads -- must stay in step
 *  with `backend/models/pageviews.ts#pageviewWindows`. */
const pageviewsWindow = ref('last30d')

const pageviewClientTypes = ref(['browser', 'api', 'mcp'])

/** Drill-down filter state: the AND of whichever of these are non-empty narrows the visible
 *  node/edge subset -- see `graphFilters.js#computeVisibleSubset`. */
const activeFilters = reactive({
  tags: [],
  /** A concrete depth, never a `null`-means-"All" sentinel: `loadGraph()` seeds it to
   *  `actualMaxFolderDepth`. `0` here is only the brief pre-load placeholder. */
  folderDepth: 0,
  locale: null
})

/** The filter panel's keyword box, and the single source ref driving the whole keyword-search
 *  pipeline. Deliberately OUTSIDE `activeFilters`: that object drives `computeVisibleSubset()`'s
 *  AND-narrowing, while a keyword match HIGHLIGHTS matching nodes without hiding the rest. */
const keywordQuery = ref('')

/** `keywordQuery` is deliberately not reset here: it is not one of the narrowing filters this
 *  action targets, and its own `w-input`'s `clearable` affordance already covers it. */
function clearFilters() {
  activeFilters.tags = []
  activeFilters.folderDepth = actualMaxFolderDepth.value
  activeFilters.locale = null
}

/** Keyword search results driving the graph's highlight. Each entry needs only `path`/`locale`, the
 *  shape `GET sites/:siteId/pages/search` returns per result. `shallowRef` for the same reason as
 *  `allNodes`/`allEdges`, so every assignment must be a new array rather than a mutation or the
 *  watchers downstream never fire. */
const keywordMatches = shallowRef([])

/** The composite `${locale}:${path}` id of the node resolved from the `?path=` query param, or
 *  `null` when there is none. Set by `applyRouteFocus()`. */
const focusNodeId = ref(null)

/** The composite `${locale}:${path}` id of the graph node matching whatever sidebar row the reader
 *  has SELECTED, or `null` when nothing qualifies. Selection is written to
 *  `stores/graph.js#selectedPath` (a bare path) by the sidebar
 *  (`composables/navSidebarDestination.js`) and by the header's graph button on entry from a page;
 *  the canvas has no click state of its own. This is the one place that resolves that bare path, plus
 *  the current locale, into the composite id the draw layer keys on.
 *
 *  ANCHOR TRUMPS SELECTED, mirroring the sidebar's own `isSelected()` guard: a clicked EMPTY folder
 *  anchors on itself and sets `selectedPath` to that same path, so resolving it here anyway would
 *  ring a node the sidebar is deliberately NOT marking as selected. */
const selectedNodeId = computed(() => {
  const path = graphStore.selectedPath
  if (!path) {
    return null
  }
  const anchorRawPath = route.query.path
  const anchorPath = Array.isArray(anchorRawPath) ? anchorRawPath[0] : anchorRawPath
  if (path === anchorPath) {
    return null
  }
  const node = nodes.value.find((n) => n.path === path && n.locale === pageStore.locale)
  return node ? nodeId(node) : null
})

/** The color `repaint()` rings `selectedNodeId` with: the same custom property the nav sidebar's
 *  "current row" style uses, read live off `document.body` rather than hardcoded, so it tracks each
 *  aesthetic's own redefinition with no aesthetic-name branch here. Keyed on `dark.isActive` alone
 *  rather than re-read per animation frame -- the token changes only across a light/dark flip. */
const selectedNodeColor = computed(() => {
  const style = getComputedStyle(document.body)
  return (
    dark.isActive
      ? style.getPropertyValue('--color-accent-dark')
      : style.getPropertyValue('--color-accent-fill')
  ).trim()
})

/** The `{ path, locale }` of the currently-anchored node, or `null` when no anchor is active -- set
 *  by `applyRouteFocus()` and read by `applyFilters()` to restrict the rendered set to the anchor
 *  plus its descendants. A plain object of primitives rather than the node itself: the node is a
 *  `markRaw()`'d entry d3-force mutates every tick, and this has to stay a reactive value the
 *  watchers can key off without pulling that churn into Vue's reactivity. */
const routeFocusAnchor = ref(null)

/** A second, purely CLIENT-SIDE highlight pass alongside the backend full-text search: the
 *  backend's `websearch_to_tsquery` matches stemmed lexemes, not substrings, so a partial word
 *  typed mid-token never reliably highlights a page whose TITLE plainly contains it. Synchronous
 *  off `allNodes`, already in memory, so it needs no debounce or request of its own. */
const titleMatchNodeIds = computed(() =>
  computeTitleMatchNodeIds(allNodes.value, keywordQuery.value)
)

/** Every node to draw with a highlight ring: the backend keyword matches, the client-side
 *  title-contains pass, and the `?path=` focus target. None of the three narrows
 *  `computeVisibleSubset`'s node set; they only mark already-visible nodes. An empty set draws
 *  every node at full strength. */
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

/** `repaint()`'s `dimmingIds`: the same union as `highlightedNodeIds` MINUS `focusNodeId`. A
 *  resolved anchor earns a ring but is not itself a reason to dim everything around it, so landing
 *  on `/_graph?path=...` with no keyword typed leaves every node at full strength. */
const keywordHighlightedNodeIds = computed(
  () => new Set([...computeHighlightedNodeIds(keywordMatches.value), ...titleMatchNodeIds.value])
)

/** Derived from `allNodes`, not the currently-visible `nodes`: options must stay the full universe
 *  of choices, or picking one filter would shrink another's dropdown down to whatever survived it,
 *  silently hiding combinations the viewer could otherwise reach. */
const filterOptions = computed(() => deriveFilterOptions(allNodes.value))
const tagOptions = computed(() => filterOptions.value.tags)
const localeOptions = computed(() => filterOptions.value.locales)

/** The deepest folder present in the loaded graph, already capped at `graphFilters.js`'s
 *  `MAX_DEPTH`, so the depth control sizes its own `max` off this directly.
 *
 *  Before the initial fetch resolves this reads `0`, indistinguishable from a real, fully-flat
 *  graph: gate on `isLoading` rather than treating `0` as "no folders", or the control renders with
 *  no steps while the graph is still loading. */
const actualMaxFolderDepth = computed(() => deriveMaxFolderDepth(allNodes.value))

/** The slider and its adjacent number field share this one v-model. Clamping here, rather than
 *  trusting the `w-input`'s `min`/`max` attributes alone, is what keeps `activeFilters.folderDepth`
 *  valid against a hand-typed out-of-range or non-numeric entry. */
const folderDepthSlider = computed({
  get: () => activeFilters.folderDepth,
  set: (value) => {
    activeFilters.folderDepth = Math.min(
      actualMaxFolderDepth.value,
      Math.max(0, Math.round(Number(value) || 0))
    )
  }
})

/** Gated on the locale-switcher setting AND more than one locale being represented: `showMenu`
 *  alone says nothing about how many locales a site has, so a single-locale site with the menu on
 *  would render a `w-select` whose one option is always a no-op. Keyed off `localeOptions` (the
 *  full graph), so narrowing a filter never makes the control vanish under the reader. */
const showLocaleFilter = computed(
  () => siteStore.locales.showMenu && localeOptions.value.length > 1
)

const KEYWORD_SEARCH_DEBOUNCE_MS = 300

/** The search endpoint's own maximum `limit`. A keyword matching more pages than this has only its
 *  top 100 by relevancy highlighted -- accepted, the same way the node cap is, rather than
 *  paginating a highlight overlay. */
const KEYWORD_SEARCH_LIMIT = 100

/** Bumped on every keyword fetch started or invalidated, so a slower earlier request landing after
 *  a faster later one cannot clobber fresher results. */
let keywordSearchToken = 0

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

watch(keywordQuery, (newKeyword) => {
  const query = (newKeyword ?? '').trim()
  if (!query) {
    debouncedSearchKeyword.cancel()
    // -> Invalidates any request already in flight for the since-cleared keyword.
    keywordSearchToken++
    keywordMatches.value = []
    return
  }
  debouncedSearchKeyword(query)
})

/** Every directory segment of a node's `path`, excluding its trailing page segment -- e.g.
 *  `guides/deep/two` -> `['guides', 'deep']`. Needed because `node.folder` (backend `folderOf()`)
 *  is capped at the first segment and so cannot distinguish `guides/one` from `guides/deep/two`,
 *  which a level-2/3 clustering key has to. */
function directorySegmentsOf(node) {
  return node.path.split('/').slice(0, -1)
}

/** How many of a path's leading directory segments belong to the current anchor -- `0` with no
 *  anchor or a root one, keeping root-anchored identical to unanchored. Every node the callers
 *  below see is already restricted to the anchor plus its descendants, so the anchor's segments are
 *  always a strict leading prefix and safe to subtract outright. */
function anchorSegmentCount() {
  const anchor = routeFocusAnchor.value
  return anchor && anchor.path !== '' ? anchor.path.split('/').length : 0
}

/** Passed to both `computeClusters()` and `clusterForce()` so the simulation's centroid pull and
 *  the drawn circles bucket on the exact same set of nesting levels. */
const CLUSTER_LEVELS = [1, 2, 3]

/** A node's group key at a given nesting `level`. Tag and classification grouping stay
 *  single-level -- neither has a genuine second level to nest -- so any `level` above 1 returns
 *  `null`, which `computeClusters`/`clusterForce` read as "exclude this node from this level".
 *
 *  Un-anchored folder level 1 reads `node.folder`, not `directorySegmentsOf(node)[0]`: `.folder` is
 *  a backend-computed field a caller may stamp independently of `.path`, so the path-derived form
 *  is used only once there is an anchor depth to subtract. With a non-root anchor, grouping
 *  restarts at the anchor's own children -- anchored on A, a page in A/B groups under `'B'`, not
 *  `'A'` -- matching the anchor-restricted node set already on screen. A node without enough
 *  segments for a level returns `null` and simply gets no circle or centroid pull at it. */
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

/** A synthetic folder/root node's own MEMBERSHIP key: which circle it belongs to as a member of its
 *  PARENT folder's grouping, never the key it would itself produce for its own children. That is
 *  what keeps a folder out of the circle it is the namer of. Only folder mode needs real path
 *  logic -- a folder node carries no `tags`/`classification`, so `groupKeyFor()` already answers
 *  correctly for the other two modes. A top-level folder's parent IS the anchor, which has no
 *  folder key, so it reads `'(root)'` the same way a folder-less real page does. */
function parentGroupKeyFor(node) {
  if (groupBy.value !== 'folder') {
    return groupKeyFor(node)
  }
  const segments = (node.path === '' ? [] : node.path.split('/')).slice(anchorSegmentCount())
  return segments.length > 1 ? segments[0] : '(root)'
}

/** A live summary of what is currently drawn: with no `role`/label, a screen reader announces the
 *  canvas as nothing. Synthetic folder/root nodes are excluded from the page count -- they are
 *  never real pages. Three i18n keys rather than one interpolated template because the sentence
 *  carries two independently-pluralized counts. */
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
  The `dataviz` skill's validated 8-slot categorical theme, kept in that skill's own fixed
  (CVD-safe adjacent-pair) order and assigned in that order as new group keys are first seen. The
  two arrays are the same eight hues stepped for each surface, not separate palettes, so a slot
  index means the same hue in either -- which is what lets `colorForGroup()` swap columns live.
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

/** Deliberately outside both palettes, so a synthetic folder/tag-hub marker is never mistaken for a
 *  real group. A mid-gray reads clearly on either canvas surface, so it needs no dark variant. */
const SYNTHETIC_NODE_COLOR = '#9e9e9e'

/** Keyed on the group's palette SLOT INDEX, never the resolved hex, so a mode flip repaints every
 *  already-assigned group instead of freezing it at whichever mode first assigned it. */
const groupColorSlots = new Map()

/** Slot assignment follows first-seen order, which is stable across a reload too since the backend
 *  returns nodes in a consistent order. Past 8 distinct groups the palette wraps rather than
 *  leaving a group undrawn -- a graph has no "fold into Other" fallback the way a chart legend
 *  does. `dark.isActive` is read on every call, not just at assignment: that is both what repaints
 *  existing groups on a mode flip and what makes the mode a tracked dependency of every caller. */
function colorForGroup(key) {
  if (!groupColorSlots.has(key)) {
    groupColorSlots.set(key, groupColorSlots.size % CATEGORICAL_PALETTE_LIGHT.length)
  }
  const palette = dark.isActive ? CATEGORICAL_PALETTE_DARK : CATEGORICAL_PALETTE_LIGHT
  return palette[groupColorSlots.get(key)]
}

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

const nodesByPath = computed(() => new Map(nodes.value.map((n) => [n.path, n])))

/** `forceLink`'s `id()` resolution mutates `edge.source`/`edge.target` in place from a plain path
 *  string into a node reference the moment it initializes, so an endpoint may be either shape
 *  depending on whether the simulation has reached this edge yet. */
function resolveEndpoint(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null
    ? endpoint
    : nodesByPath.value.get(endpoint)
}

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

const fallbackNodes = computed(() =>
  nodes.value
    .filter((node) => !node.synthetic)
    .map((node) => ({ node, links: fallbackLinksFor(node) }))
)

let simulation = null
let ctx = null
let resizeObserver = null
let nodeQuadtree = null
/** Identity cache for `applyFilters()`'s synthetic folder/root nodes: a node still visible across
 *  an `activeFilters` change reuses the same object, and so keeps whatever `x`/`y`/`vx`/`vy`
 *  d3-force has assigned it, instead of jittering in from the origin-centered default placement.
 *  Reset in `loadGraph()` -- a fresh fetch must not carry positions forward from another graph. */
let syntheticNodeCache = new Map()
const hoveredNode = ref(null)
const showsPointerCursor = computed(() =>
  Boolean(hoveredNode.value && !hoveredNode.value.synthetic)
)
let lastPointer = null
/** Relative to `containerRef`, not the viewport. */
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
const clusters = ref([])

/** The one shared radius floor/ceiling for BOTH sizing metrics. The floor has to leave room for a
 *  legible page title rendered INSIDE the node rather than beside it; a synthetic folder/root hub
 *  keeps its own fixed `3` (see `radiusFor()`), deliberately below it. A ceiling this far above the
 *  floor is only workable because `radiusFor()` normalizes against the loaded graph's own observed
 *  range: just its single highest-ranked node ever draws at the ceiling. */
const MIN_NODE_RADIUS = 20
const MAX_NODE_RADIUS = 110

/** How many contributors count toward a node's 'edits'-mode size. `'total'` reads the raw,
 *  not-distinct row counts nested under `.total`; `'unique'` the distinct figures at the top level.
 *  Both types checked reads the backend's pre-summed `all` rather than `editor + mcp`: for the
 *  unique figures a contributor who used both channels would otherwise be counted twice. */
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

/** How many visitors count toward a node's 'visits'-mode size. A plain sum of the checked buckets
 *  is exact for any subset here, unlike `contributorCountFor()`'s union: each client type hashes a
 *  disjoint identity space for the unique figures, and a raw row count carries no identity to
 *  double-count at all. */
function pageviewCountFor(node) {
  const windowCounts = node.pageviews?.[pageviewsWindow.value]
  if (!windowCounts) {
    return 0
  }
  const counts = sizeCountMode.value === 'total' ? windowCounts.total : windowCounts
  return pageviewClientTypes.value.reduce((sum, type) => sum + (counts[type] ?? 0), 0)
}

/** The tooltip noun must follow `sizeCountMode` as well as `sizeBy`: 'total' tallies raw
 *  edits/visits, 'unique' tallies contributors/visitors, so all four combinations need their own
 *  key. Each key carries its own singular/plural form. */
function tooltipKeyFor() {
  if (sizeBy.value === 'edits') {
    return sizeCountMode.value === 'total' ? 'graph.tooltip.edits' : 'graph.tooltip.contributors'
  }
  return sizeCountMode.value === 'total' ? 'graph.tooltip.visits' : 'graph.tooltip.uniqueVisitors'
}

function metricCountFor(node) {
  return sizeBy.value === 'edits' ? contributorCountFor(node) : pageviewCountFor(node)
}

/** The active metric's sqrt-space `[min, max]` across every REAL node currently loaded, which
 *  `radiusFor()` normalizes its lerp against. A plain variable, deliberately not a `computed`: node
 *  objects are kept out of Vue's reactivity, so a computed would never invalidate when a node's own
 *  `contributors`/`pageviews` field is written in place. */
let currentMetricRange = { min: 0, max: 0 }

/** Stands in for the dependency tracking `currentMetricRange` gives up. One O(n) pass over the
 *  visible nodes, cheap enough to re-run before every force attachment that snapshots radii. */
function refreshMetricRange() {
  const counts = []
  for (const node of nodes.value) {
    if (!node.synthetic) {
      counts.push(metricCountFor(node))
    }
  }
  currentMetricRange = sqrtRangeOf(counts)
}

/** A real node's radius is interpolated in sqrt(count) space and normalized against this graph's
 *  own observed range, so a drawn size expresses RANK within the loaded graph rather than an
 *  absolute scale. */
function radiusFor(node) {
  if (node.synthetic) {
    return 3
  }
  return lerpRadius(metricCountFor(node), currentMetricRange, MIN_NODE_RADIUS, MAX_NODE_RADIUS)
}

/** `forceCollide` caches a function radius per node at `initialize()` time, so this is re-read only
 *  by RE-ATTACHING the force -- which the sizing watcher below does on every toggle. */
function collideRadiusFor(node) {
  return radiusFor(node) + 2
}

/** Recomputes everything derived from node POSITION. Call whenever nodes may have moved or the
 *  visible set may have changed -- never for a pan/zoom alone, where only the canvas transform
 *  changed and this O(n log n) rebuild would run at wheel frequency for identical geometry. Always
 *  `repaint()` afterwards to draw the result. */
function relayout() {
  nodeQuadtree = d3quadtree(
    nodes.value,
    (d) => d.x,
    (d) => d.y
  )

  recomputeClusters()
  refreshHoverFromPointer()
}

/** Safe to call on every zoom/pan frame: it recomputes no layout. */
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
    hoveredNode: hoveredNode.value,
    selectedId: selectedNodeId.value,
    selectedRingColor: selectedNodeColor.value
  })
}

function toGraphSpace(clientX, clientY) {
  const rect = canvasRef.value.getBoundingClientRect()
  const t = zoomTransform.value ?? zoomIdentity
  return {
    x: (clientX - rect.left - t.x) / t.k,
    y: (clientY - rect.top - t.y) / t.k
  }
}

/** Hit-tests against each candidate's OWN rendered size, so a node's hit area tracks its drawn
 *  radius across the whole range. `d3-quadtree#find(x, y, radius)` supports only one flat search
 *  radius, hence the hand-written `visit()`: a quadrant is pruned only when it cannot contain a
 *  point within `MAX_NODE_RADIUS` -- the largest any hit radius can be -- and each survivor is then
 *  checked against its own radius, nearest wins. A leaf chains coincident nodes via `.next`, so the
 *  whole chain is checked, not just the first. */
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

/** A node's in-app link, shared by the canvas click handler and every fallback-list `<a>`. An
 *  active keyword filter is carried forward as `?highlight=` so the loaded page can offer an
 *  in-page find for it. This is the ONE place that decides whether the param is added, so the real
 *  `<a href>` and `navigateToNode()`'s `router.push()` target cannot disagree. */
function fallbackHref(node) {
  const path = localizedPagePath(node.path, node.locale, siteStore.localeRouting)
  const keyword = keywordQuery.value.trim()
  return keyword ? `${path}?highlight=${encodeURIComponent(keyword)}` : path
}

function navigateToNode(node) {
  if (!node || node.synthetic) {
    return
  }
  router.push(fallbackHref(node))
}

/** A graph click has no state of its own -- it always just navigates. Selection is a SIDEBAR
 *  concept, mirrored onto the graph only as a read-only ring (`selectedNodeId` above). */
function onCanvasClick(event) {
  navigateToNode(findNodeAt(event.clientX, event.clientY))
}

/** Small on purpose: the settle after a hover push should read as a brief pulse, not the whole
 *  layout visibly reworking itself the way a filter change's own higher alpha does. */
const HOVER_PUSH_ALPHA = 0.15

/** The ONE release path for every way a hover can end, including the pointer leaving the canvas
 *  outright -- that fires no further `mousemove`, so without `onCanvasMouseLeave` the node stays
 *  pinned forever. Deliberately does NOT repaint: each caller paints once after finishing its own
 *  changes, so a hover-change (release plus pin) is one paint rather than two. */
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
  lastPointer = null
  if (releaseHoveredNode()) {
    repaint()
  }
}

function setHoveredNode(nextHovered) {
  if (nextHovered === hoveredNode.value) {
    return false
  }
  // -> Must run before the pin below: the helper reads `hoveredNode.value`, which is reassigned
  //    at the end of this function.
  releaseHoveredNode()
  if (nextHovered) {
    // -> A defined fx/fy freezes a d3-force node against every force each tick, holding the
    //    hovered node still while the rest of the layout keeps moving.
    nextHovered.fx = nextHovered.x
    nextHovered.fy = nextHovered.y
    applyHoverPushImpulse(nodes.value, nextHovered)
    simulation?.alpha(HOVER_PUSH_ALPHA).restart()
  }
  hoveredNode.value = nextHovered
  return true
}

function refreshHoverFromPointer() {
  if (hoveredNode.value && !nodes.value.includes(hoveredNode.value)) {
    releaseHoveredNode()
  }
  if (lastPointer) {
    setHoveredNode(findNodeAt(lastPointer.clientX, lastPointer.clientY))
  }
}

function onCanvasMouseMove(event) {
  lastPointer = { clientX: event.clientX, clientY: event.clientY }
  if (setHoveredNode(findNodeAt(event.clientX, event.clientY))) {
    repaint()
  }
  const containerRect = containerRef.value.getBoundingClientRect()
  tooltipPos.x = event.clientX - containerRect.left
  tooltipPos.y = event.clientY - containerRect.top
}

function childCountAccessor() {
  const counts = childCountsFor(edges.value)
  return (node) => counts.get(nodeId(node)) ?? 0
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
      clusterLevels: CLUSTER_LEVELS,
      childCountFor: childCountAccessor()
    }
  )
}

function recomputeClusters() {
  for (const node of nodes.value) {
    node.color = node.synthetic ? SYNTHETIC_NODE_COLOR : colorForGroup(groupKeyFor(node))
  }
  computeClusters()
}

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
    // -> Only the canvas transform changed, no node moved -- repaint, never relayout.
    refreshHoverFromPointer()
    repaint()
  })
  zoomTransform.value = zoomIdentity
}

/** The node object `applyRouteFocus()` has pinned to the viewport center, not merely its id. Kept
 *  so a live re-focus can release the previous target's `fx`/`fy` before handing the center point
 *  to the new one; without it the old target stays pinned forever, stacked on the new one. Reset in
 *  `loadGraph()`, where a fresh fetch leaves no pinned identity to release. */
let pinnedFocusNode = null

/** Centers and highlights the anchor the reader arrived from, addressed by `/_graph`'s `path` query
 *  param. Called from `loadGraph()` on mount and again by the `route.query.path` watch below: the
 *  sidebar's in-graph re-root updates that param via `router.replace()` while `/_graph` stays
 *  mounted, so `onMounted` never re-fires on its own.
 *
 *  Locale resolution: `route.query.path` is a bare, un-prefixed path, which is ambiguous on a
 *  multi-locale site (two locales' translations of a page share a `path` by design), and `/_graph`
 *  carries no locale segment of its own. The match is therefore scoped to `pageStore.locale` -- the
 *  locale of whatever page the reader came from -- matching what the nav tree builds its own links
 *  in. A guest who lands here with no page loaded gets `pageStore`'s default.
 *
 *  Resolves against a freshly-computed UN-anchored node set rather than `nodes.value`: on a live
 *  re-focus the latter may already be narrowed to a PREVIOUS anchor's descendants, which would make
 *  a perfectly valid new anchor outside that subtree permanently unresolvable. `includeSynthetic`
 *  is what lets a folder/root anchor resolve at all. `computeVisibleSubset` filters rather than
 *  clones, so a match is still the exact object the simulation runs on.
 *
 *  Centering reuses the hover pin's `fx`/`fy` mechanic, pinning the node to the same point
 *  `forceCenter` targets so d3-force settles the layout around it. Unlike a hover pin it is never
 *  released on its own -- only replaced by a later call. `routeFocusAnchor` is set alongside
 *  `focusNodeId`, and a no-match leaves both untouched rather than clearing one of them. */
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
  // -> A no-match is silent, so a transient or bad query value never releases an already-good pin;
  //    an unchanged match is a no-op, which is what keeps the two call sites from double-running.
  if (!focusNode || focusNode === pinnedFocusNode) {
    return
  }
  // -> Release the previous target before handing the center point to the new one, or both stay
  //    pinned at the same point forever.
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
  // -> Only a live re-focus needs the nudge: the mount-time call runs before `startSimulation()`,
  //    so `simulation` is still `null` and this correctly no-ops. A later call runs against an
  //    already-settled layout, which would otherwise never move toward the new center point.
  simulation?.alpha(0.4).restart()
}

/** `sizing` asks the backend to attach each node's `contributors`/`pageviews` count objects, which
 *  otherwise dominate the payload. The backend gates on the param's presence alone and returns both
 *  objects regardless of its value -- the "Size by" toggle switches modes client-side with no
 *  refetch, so both dimensions have to be on hand either way. */
async function loadGraph() {
  isLoading.value = true
  loadError.value = null
  // -> A fresh fetch is a wholesale new graph: neither stale synthetic node positions nor a pin on
  //    a node object that is about to be replaced may leak into it.
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
    // -> The depth filter defaults to "everything" for the graph actually loaded. This is the one
    //    call site, so it is a real one-time default rather than a reset on every reload.
    activeFilters.folderDepth = actualMaxFolderDepth.value
    applyFilters()
    // -> Must precede `startSimulation()`: d3-force seeds a node's initial `x`/`y` from its
    //    `fx`/`fy` when set, so pinning the focus node here is what lets it spawn already at center
    //    instead of jittering in from the default phyllotaxis placement.
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

/** A failed check is treated as "off", the safer default. Called after `loadGraph()` rather than
 *  raced with it, so the graph fetch stays the first `API_CLIENT.get` call. */
async function loadPageviewsTrackingState() {
  try {
    const resp = await API_CLIENT.get('system/pageviews').json()
    pageviewsTrackingEnabled.value = resp?.isEnabled === true
  } catch {
    pageviewsTrackingEnabled.value = false
  }
  pageviewsTrackingResolved = true
  // -> The watch below fires only on an actual value CHANGE, and this ref starts at `false`, so a
  //    check resolving to `false` would never reconcile a persisted `sizeBy: 'visits'`. Calling it
  //    explicitly covers that case whichever load finishes first, and no-ops otherwise.
  reconcileSizeByForTracking(pageviewsTrackingEnabled.value)
}

/** Applies whichever saved preferences are present; a control the reader never touched keeps its
 *  own default. `sizeBy` is applied unconditionally rather than gated on `pageviewsTrackingEnabled`
 *  (which may not have resolved) and reconciled afterwards, so whichever of the two async loads
 *  settles last leaves it in the correct state either way. Skipped for a guest, who has no profile
 *  to have saved one onto. */
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
  // -> The mirror image of `loadPageviewsTrackingState()`'s own call: if the tracking check settled
  //    before the persisted `sizeBy` above was applied, that call ran too early to see it and the
  //    watch will not fire again. Guarded, because reconciling against a not-yet-checked value
  //    would force a persisted 'visits' back to 'edits'.
  if (pageviewsTrackingResolved) {
    reconcileSizeByForTracking(pageviewsTrackingEnabled.value)
  }
}

/** The profile route replaces the whole `graph` key rather than merging into it, so every save
 *  sends all five controls regardless of which one changed. A failure is logged and swallowed:
 *  losing a preference save is not worth interrupting the reader's actual task. */
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

const GRAPH_PREFS_SAVE_DEBOUNCE_MS = 500

const debouncedSaveGraphPrefs = debounce(saveGraphPrefs, GRAPH_PREFS_SAVE_DEBOUNCE_MS)

/** Guards the save watch against firing off the load itself: `loadGraphPrefs()` and
 *  `reconcileSizeByForTracking()` both assign the refs it watches, and neither reflects a reader's
 *  action. Flipped only once both loads have settled -- earlier, a save would race them and could
 *  persist a still-resolving `sizeBy`. */
let graphPrefsReady = false

/** The trailing `nextTick()` is load-bearing: Vue flushes watcher callbacks as queued jobs, so a
 *  ref either load assigned has already scheduled the save watch. Without the extra tick
 *  `graphPrefsReady` could read `true` by the time that queued callback runs, which is the very
 *  race the flag exists to prevent. */
async function initializeGraphPrefs() {
  await Promise.all([loadGraphPrefs(), loadPageviewsTrackingState()])
  await nextTick()
  graphPrefsReady = true
}

/** Recomputes what the simulation runs on. `buildPathHierarchyEdges`'s synthetic folder/root edges
 *  are the graph's SOLE edge source -- every non-root node has exactly one incoming `type: 'path'`
 *  edge, a strict tree -- so the endpoint's own `relation`/`link` edges are deliberately unused.
 *  Deliberately does not touch the live simulation (`syncSimulationToVisibleSet`'s job): the
 *  initial call runs before `startSimulation()` has created one.
 *
 *  `routeFocusAnchor` goes to `computeVisibleSubset()`, which restricts the rendered set to the
 *  anchor plus its descendants and reinterprets `folderDepth` as hops from the anchor. It goes to
 *  `buildPathHierarchyEdges()` as well, because that call would otherwise climb each node's
 *  ancestor chain to the TRUE root and re-synthesize everything the restriction exists to exclude. */
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
  // -> Synthetic nodes/edges are built fresh for any genuinely new key and have never been through
  //    `markRaw()`. Marking the whole assembled list keeps everything the simulation sees out of
  //    Vue's reactivity whichever builder produced it; re-marking an already-marked object is free.
  nodes.value = [...visibleNodes, ...syntheticNodes].map((n) => markRaw(n))
  edges.value = syntheticEdges.map((e) => markRaw(e))
  // -> Must run before `startSimulation()`'s first `forceCollide(collideRadiusFor)` attachment,
  //    which snapshots every node's radius once: the range has to be correct already, not by
  //    whichever later `computeClusters()` call happens to run first.
  refreshMetricRange()
}

watch(groupBy, () => {
  recomputeClusters()
  simulation?.alpha(0.3).restart()
})

/** Nothing moved and the visible set is unchanged, only which palette column every color comes
 *  from, so this re-derives colors and redraws without restarting the simulation. The legend
 *  updates on its own, through `legendEntries`' read of `colorForGroup()`. */
watch(
  () => dark.isActive,
  () => {
    recomputeClusters()
    repaint()
  }
)

/** d3-force evaluates both `collide`'s radius and `link`'s `.distance()` once, at attach time, so
 *  each has to be handed over again or every link's resting distance stays frozen at whatever radii
 *  existed when the simulation last started. `link` needs no fresh `forceLink` instance the way
 *  `collide` does -- re-calling `.distance()` re-initializes it against the current edges without
 *  re-resolving endpoints from ids. Neither the node nor the edge set changes here, only how big
 *  each dot draws, so no `applyFilters()`/`syncSimulationToVisibleSet()` is needed. */
watch([sizeBy, sizeCountMode, contributorTypes, pageviewsWindow, pageviewClientTypes], () => {
  // -> Before re-attaching `collide`/`link`, which snapshot radii immediately off whichever
  //    metric just became active. `relayout()`'s own refresh below runs too late for that moment.
  refreshMetricRange()
  simulation?.force('collide', forceCollide(collideRadiusFor))
  const childCountFor = childCountAccessor()
  simulation
    ?.force('link')
    ?.distance((link) => linkDistanceFor(link, collideRadiusFor, childCountFor))
  simulation?.alpha(0.3).restart()
  relayout()
  repaint()
})

/** Where `sizeBy`'s REAL default gets applied, once tracking resolves either way:
 *  - on: promote 'edits' -> 'visits', but only while `sizeBy` still holds its untouched literal AND
 *    nothing was persisted, so a deliberately chosen 'edits' survives.
 *  - off: fall back to 'edits' even from a persisted 'visits' -- there is nothing to size by while
 *    tracking is off, and the option is not even offered.
 *
 *  A named function rather than an inline watch callback because both loads call it directly too:
 *  the watch fires only on an actual value change, and neither load knows if it settled last. */
function reconcileSizeByForTracking(enabled) {
  if (enabled && sizeBy.value === 'edits' && !hasPersistedSizeBy) {
    sizeBy.value = 'visits'
  } else if (!enabled && sizeBy.value === 'visits') {
    sizeBy.value = 'edits'
  }
}

watch(pageviewsTrackingEnabled, reconcileSizeByForTracking)

/** Saves only -- `groupBy`'s own watch above still handles re-clustering. Not `{ deep: true }`:
 *  `pageviewClientTypes` is always reassigned wholesale by its control, never mutated in place. */
watch([groupBy, sizeBy, sizeCountMode, pageviewsWindow, pageviewClientTypes], () => {
  if (!graphPrefsReady) {
    return
  }
  debouncedSaveGraphPrefs()
})

/** Once the locale filter control disappears, clear any value chosen on it -- otherwise a locale
 *  picked beforehand keeps filtering the graph with no visible control left to clear it from. */
watch(showLocaleFilter, (visible) => {
  if (!visible && activeFilters.locale !== null) {
    activeFilters.locale = null
  }
})

/*
  A real page node filtered back in loses whatever position and velocity it had -- it is a fresh
  entry as far as d3-force is concerned -- and that re-settling is wanted, not a bug to work
  around: removed nodes exit the simulation so the remainder re-settles rather than being drawn
  hidden. A synthetic folder/root node is the exception, kept identical across calls by
  `syntheticNodeCache`, since re-settling markers flash-jitter the whole hierarchy on every filter
  change for no benefit.
*/
function syncSimulationToVisibleSet() {
  if (!simulation) {
    return
  }
  simulation.nodes(nodes.value)
  const childCountFor = childCountAccessor()
  simulation
    .force('link')
    ?.links(edges.value)
    .distance((link) => linkDistanceFor(link, collideRadiusFor, childCountFor))
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

/** Re-runs the same anchor-plus-descendants restriction `activeFilters`'s watcher runs for a filter
 *  change, so a live re-focus actually moves the restriction rather than only the highlight. */
watch(focusNodeId, () => {
  applyFilters()
  syncSimulationToVisibleSet()
})

/** A keyword match changes only which already-visible nodes draw highlighted, so this repaints
 *  against the current layout without restarting the simulation. Watches the unioned set, not
 *  `keywordMatches`: the title-contains pass never touches that ref, so a title-only match would
 *  otherwise compute correctly and never repaint. */
watch(highlightedNodeIds, () => {
  repaint()
})

/** Same repaint-only shape as the watcher above, and needed because the simulation may already be
 *  at rest -- no further `onTick()` repaints -- by the time a sidebar click lands. */
watch(selectedNodeId, () => {
  repaint()
})

/** Not `immediate: true` -- `loadGraph()` already handles the initial value. A getter source, not
 *  the route object, so this fires only on the one field the focus depends on. */
watch(() => route.query.path, applyRouteFocus)

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    sizeCanvas()
    relayout()
    repaint()
  })
  resizeObserver.observe(containerRef.value)
  loadGraph()
  // -> Ordering is load-bearing and stable: both calls inside `initializeGraphPrefs()` run
  //    synchronously up to their first `await`, in argument order, so the graph fetch above stays
  //    the first request, `GET profile` lands second and `system/pageviews` third.
  initializeGraphPrefs()
})

onBeforeUnmount(() => {
  simulation?.stop()
  resizeObserver?.disconnect()
  debouncedSearchKeyword.cancel()
  debouncedSaveGraphPrefs.cancel()
  // -> The nav sidebar's graph-selection indicator has nothing left to highlight once this page is
  //    gone; without this, a selection made just before navigating away marks that row forever.
  graphStore.clearSelection()
})
</script>

<style scoped>
.graph-view {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 480px;
}

.graph-view-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: default;
}

.graph-view-canvas--hover {
  cursor: pointer;
}

/*
  Both floating panels carry this class in the template. A plain shared class rather than a mixin:
  native CSS nesting has no mixin equivalent. The surface is opaque by design -- a translucent wash
  puts the graph's own edges behind every control sitting on it.
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
    Under Cobalt the edge comes from `--shadow-card` alone. Dropping the border is safe only here:
    `--radius-card`/`--shadow-card` are `0`/`none` under Ledger, where that border is the only
    visible edge.
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
  align-items: stretch;
  gap: 5px;
  width: 100%;

  :deep(.w-btn-toggle__segment) {
    flex: 1 1 0;
    justify-content: center;
    padding-inline: 6px;
  }
}

/*
  `flex-wrap` is a genuine fallback for a locale whose combined option labels run long. The
  `:deep()` override exists because `WBtnToggle`'s stock segment padding wraps even the English
  labels at this panel's content width; it is scoped to this row so no other caller is affected.
*/
.graph-view-control-row {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 6px;

  /*
    `--option-count` (set in the template) grows each toggle in proportion to its option count, so
    every option across both toggles ends up the same width; the zero basis lets that count, not
    the labels' natural widths, decide the split.
  */
  > .w-btn-toggle {
    flex: var(--option-count, 1) 1 0;
  }
}

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

  /* Cobalt's pill drops the accent border, reusing the card tokens rather than a one-off shadow. */
  body.body--cobalt & {
    border: 0;
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
  }
}

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
  Solid ink rather than a black wash. `--color-ink` already resolves to each aesthetic's own ink,
  so the plate tracks Cobalt with no per-aesthetic branch of its own.
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
