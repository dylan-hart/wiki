<template>
  <div ref="containerRef" class="graph-view">
    <canvas
      ref="canvasRef"
      class="graph-view-canvas"
      @click="onCanvasClick"
      @mousemove="onCanvasMouseMove" />
    <div
      v-if="hoveredNode"
      class="graph-view-tooltip"
      :style="{ left: `${tooltipPos.x + 12}px`, top: `${tooltipPos.y + 12}px` }">
      {{ hoveredNode.title ?? hoveredNode.path }}
      <template v-if="sizeBy === 'edits' && !hoveredNode.synthetic">
        · {{ contributorCountFor(hoveredNode) }}
        {{ tooltipNounFor(contributorCountFor(hoveredNode)) }}
      </template>
      <template v-if="sizeBy === 'visits' && !hoveredNode.synthetic">
        · {{ pageviewCountFor(hoveredNode) }} {{ tooltipNounFor(pageviewCountFor(hoveredNode)) }}
      </template>
    </div>
    <div class="graph-view-right-rail">
      <div class="graph-view-controls">
        <div class="graph-view-control-group">
          <span class="graph-view-control-caption">Group by</span>
          <w-btn-toggle
            v-model="groupBy"
            no-caps
            aria-label="Group by"
            :options="[
              { label: 'Folder', value: 'folder' },
              { label: 'Tag', value: 'tag' },
              { label: 'Classification', value: 'classification' }
            ]" />
        </div>
        <div class="graph-view-control-group">
          <span class="graph-view-control-caption">Connect by</span>
          <w-btn-toggle
            v-model="edgeMode"
            no-caps
            aria-label="Connect by"
            :options="[
              { label: 'Paths', value: 'paths' },
              { label: 'Tags', value: 'tags' },
              { label: 'Classification', value: 'classification' }
            ]" />
        </div>
        <div class="graph-view-control-group">
          <span class="graph-view-control-caption">Size by</span>
          <w-btn-toggle v-model="sizeBy" no-caps aria-label="Size by" :options="sizeByOptions" />
        </div>
        <div class="graph-view-control-group">
          <span class="graph-view-control-caption">Count</span>
          <w-btn-toggle
            v-model="sizeCountMode"
            no-caps
            aria-label="Unique or total"
            :options="[
              { label: 'Unique', value: 'unique' },
              { label: 'Total', value: 'total' }
            ]" />
        </div>
        <GraphClientTypeFilter
          v-if="sizeBy === 'edits'"
          v-model="contributorTypes"
          label="Count edits by"
          :options="[
            { value: 'editor', label: 'Editor' },
            { value: 'mcp', label: 'MCP' }
          ]" />
        <div v-if="sizeBy === 'visits'" class="graph-view-control-group">
          <span class="graph-view-control-caption">Over</span>
          <w-btn-toggle
            v-model="pageviewsWindow"
            no-caps
            aria-label="Time window"
            :options="[
              { label: '30 days', value: 'last30d' },
              { label: '6 months', value: 'last6mo' },
              { label: '2 years', value: 'last2yr' }
            ]" />
        </div>
        <GraphClientTypeFilter
          v-if="sizeBy === 'visits'"
          v-model="pageviewClientTypes"
          label="Count visits by"
          :options="[
            { value: 'browser', label: 'Browser' },
            { value: 'api', label: 'API' },
            { value: 'mcp', label: 'MCP' }
          ]" />
      </div>
    </div>
    <div class="graph-view-filters">
      <w-select
        v-model="activeFilters.tags"
        multiple
        use-chips
        outlined
        dense
        options-dense
        :options="tagOptions"
        :label="t('graph.filters.tags')" />
      <w-input
        v-model.number="activeFilters.folderDepth"
        type="number"
        min="0"
        outlined
        dense
        :label="t('graph.filters.folderDepth')" />
      <w-select
        v-if="showLocaleFilter"
        v-model="activeFilters.locale"
        outlined
        dense
        options-dense
        :options="localeOptions"
        :label="t('graph.filters.locale')" />
      <w-btn
        v-if="
          activeFilters.tags.length || activeFilters.folderDepth != null || activeFilters.locale
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
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { polygonHull } from 'd3-polygon'
import { quadtree as d3quadtree } from 'd3-quadtree'
import { select } from 'd3-selection'
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom'
import { localizedPagePath } from '@/helpers/pagePaths'
import { useSiteStore } from '@/stores/site'
import GraphClientTypeFilter from '@/components/GraphClientTypeFilter.vue'
import {
  buildClassificationHubEdges,
  buildPathHierarchyEdges,
  buildTagHubEdges,
  computeVisibleSubset,
  deriveFilterOptions
} from './graphFilters.js'
import { clusterForce } from './graphForces.js'

/**
 * The knowledge graph view (OpenProject #848/#873): a full-viewport, canvas-rendered force graph
 * of every page the caller may read on this site. Fetched once on mount -- every filter and
 * re-cluster after that (#874/#875) runs against `nodes`/`edges` already in memory, no further
 * network round trip.
 */

const siteStore = useSiteStore()
const router = useRouter()
const { t } = useI18n()

const containerRef = ref(null)
const canvasRef = ref(null)

/** Raw payload from `GET sites/{siteId}/graph` -- see `backend/api/graph.ts#Graph`. */
const nodes = ref([])
const edges = ref([])
const isLoading = ref(true)
const loadError = ref(null)

/** The full, unfiltered graph as fetched -- kept separate from `nodes.value`/`edges.value`, which
 *  after Task 26 (#901) are the CURRENTLY VISIBLE subset the simulation actually runs on. */
const allNodes = ref([])
const allEdges = ref([])

/** 'site' is deliberately not an option here -- see the spec's architecture note: a single loaded
 *  graph has exactly one site value, so grouping by it would be a no-op UI control. */
const groupBy = ref('folder')

/** Which zero-authoring edge source drives the graph's connections (OpenProject #997): `paths`
 *  (default) chains every page to its parent path segment up to a synthetic root; `tags` connects
 *  every page to a synthetic hub per tag it carries. The 872 endpoint's `relation`/`link` edges
 *  (`allEdges` below) are still fetched but not wired into either mode's rendering. */
const edgeMode = ref('paths')

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
  const options = [{ label: 'Edits', value: 'edits' }]
  if (pageviewsTrackingEnabled.value) {
    options.push({ label: 'Visits', value: 'visits' })
  }
  return options
})

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
  folderDepth: null,
  locale: null
})

/** Resets every filter to its default -- the `activeFilters` watcher (Task 26/#901) fires
 *  automatically once these change, no separate wiring needed here. */
function clearFilters() {
  activeFilters.tags = []
  activeFilters.folderDepth = null
  activeFilters.locale = null
}

/** The tag/locale values offered by the filter panel's `w-select`s, derived from `allNodes` (the
 *  full fetched graph, not the currently-filtered `nodes.value`) -- no separate endpoint
 *  (OpenProject #899). Deriving from `allNodes` rather than `nodes` matters once Task 26 (#901)
 *  redefines `nodes.value` as the currently-VISIBLE subset: options must stay the full universe of
 *  choices, or picking one filter (say, a locale) would shrink another filter's own dropdown (say,
 *  tags) down to whatever survived it, silently hiding tags the viewer could otherwise combine. */
const filterOptions = computed(() => deriveFilterOptions(allNodes.value))
const tagOptions = computed(() => filterOptions.value.tags)
const localeOptions = computed(() => filterOptions.value.locales)

/** Whether the locale filter control is worth showing at all (OpenProject #2294): gated on both the
 *  reader-facing locale-switcher setting AND there being more than one locale actually represented
 *  among the loaded nodes -- `showMenu` alone says nothing about how many locales the site has, so a
 *  single-locale site with the menu enabled would otherwise render a `w-select` whose one option is
 *  always a no-op, the same class of dead control `groupBy` already avoids for site grouping (see
 *  that const's own doc comment above). Derived from `localeOptions`, not site config, so the
 *  control also disappears once the current filter set leaves only one locale represented. */
const showLocaleFilter = computed(
  () => siteStore.locales.showMenu && localeOptions.value.length > 1
)

function groupKeyFor(node) {
  if (groupBy.value === 'tag') {
    return node.tags?.[0] ?? '(untagged)'
  }
  if (groupBy.value === 'classification') {
    return node.classification ?? '(unclassified)'
  }
  return node.folder || '(root)'
}

/*
  The `dataviz` skill's validated 8-slot categorical theme (references/palette.md), light-surface
  hex values, in the skill's own fixed (CVD-safe adjacent-pair) order -- assigned in that order as
  new group keys are first seen, never reordered per group. Graph.vue's canvas rendering has no
  dark-mode color swap anywhere yet (drawEdges'/drawLabels' stroke/fill strings are hardcoded the
  same way), so this palette isn't threaded through a light/dark variant either -- revisit together
  if dark-mode canvas theming is ever added.
*/
const CATEGORICAL_PALETTE = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948' // red
]

/** Fixed neutral color for every synthetic node (OpenProject #997/#1001) -- deliberately outside
 *  `CATEGORICAL_PALETTE` so a synthetic folder/tag-hub marker never gets mistaken for a real group. */
const SYNTHETIC_NODE_COLOR = '#9e9e9e'

const groupColors = new Map()

/** Assigns the palette's next unused slot to a not-yet-seen group key, then always returns that
 *  same color for that key going forward -- stable across redraws within a session, and stable
 *  across a reload too since the backend returns nodes in a consistent order (insertion order
 *  drives slot assignment). Past 8 distinct groups the palette wraps rather than leaving a group
 *  undrawn -- a graph view has no "fold into Other" fallback the way a chart legend would. */
function colorForGroup(key) {
  if (!groupColors.has(key)) {
    groupColors.set(key, CATEGORICAL_PALETTE[groupColors.size % CATEGORICAL_PALETTE.length])
  }
  return groupColors.get(key)
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

let simulation = null
let ctx = null
let resizeObserver = null
let nodeQuadtree = null
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

/** Sqrt scaling (OpenProject #1141), not linear: a node's drawn AREA should read as proportional to
 *  its contributor count, the standard convention for encoding a magnitude in a circle's size --
 *  linear radius scaling would make a 4x-more-contributed page look ~16x more prominent by area,
 *  overwhelming the rest of the graph. `MIN`/`MAX` are starting points for visual tuning, same
 *  caveat as the constants above -- `MIN` matches the pre-#1270 'uniform' mode's fixed radius so an
 *  untouched page's dot is no smaller than it used to be. */
const MIN_CONTRIBUTOR_RADIUS = 5
const MAX_CONTRIBUTOR_RADIUS = 22
const CONTRIBUTOR_RADIUS_SCALE = 3

/** Same sqrt-scaling reasoning as the contributor constants above, for 'visits' sizing (OpenProject
 *  #1140) -- same starting values too, so switching between the two sizing modes doesn't itself
 *  make the graph look dramatically different at a glance. */
const MIN_PAGEVIEW_RADIUS = 5
const MAX_PAGEVIEW_RADIUS = 22
const PAGEVIEW_RADIUS_SCALE = 3

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

/** The hover tooltip's noun for `count`, per the active `sizeBy`/`sizeCountMode` combination
 *  (OpenProject #2293). The noun must follow `sizeCountMode` as well as `sizeBy`: 'total' reads the
 *  raw, non-distinct row counts (an edit or visit tally), while 'unique' reads the distinct-identity
 *  figures (a contributor or visitor tally) -- so "Edits + Total" and "Visits + Unique" need a
 *  different noun than "Edits + Unique" and "Visits + Total" use, even though all four share the same
 *  `sizeBy` pair. Keeps the existing singular/plural behaviour. */
function tooltipNounFor(count) {
  const plural = count === 1 ? '' : 's'
  if (sizeBy.value === 'edits') {
    return sizeCountMode.value === 'total' ? `edit${plural}` : `contributor${plural}`
  }
  return sizeCountMode.value === 'total' ? `visit${plural}` : `unique visitor${plural}`
}

/** A node's drawn radius: synthetic nodes are always the fixed `3`; a real node scales with
 *  `contributorCountFor()` when `sizeBy` is 'edits', or `pageviewCountFor()` when it's 'visits' --
 *  the only two values `sizeBy` can hold now that 'uniform' is gone (OpenProject #1270). */
function radiusFor(node) {
  if (node.synthetic) {
    return 3
  }
  if (sizeBy.value === 'edits') {
    const count = contributorCountFor(node)
    return Math.min(
      MAX_CONTRIBUTOR_RADIUS,
      MIN_CONTRIBUTOR_RADIUS + Math.sqrt(count) * CONTRIBUTOR_RADIUS_SCALE
    )
  }
  const count = pageviewCountFor(node)
  return Math.min(
    MAX_PAGEVIEW_RADIUS,
    MIN_PAGEVIEW_RADIUS + Math.sqrt(count) * PAGEVIEW_RADIUS_SCALE
  )
}

/** `d3-force`'s `forceCollide` caches a function radius per node at `initialize()` time (same
 *  one-time-evaluation shape as the `forceX`/`forceY` pair #1158 replaced), so this is re-read only
 *  by re-attaching the force -- the sizing-related watcher below does that on toggle; it needs no
 *  per-tick recompute the way #1158's cluster centroids did, since a node's own contributor/pageview
 *  count never changes mid-session. */
function collideRadiusFor(node) {
  return radiusFor(node) + 2
}

function drawEdges() {
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.35)'
  ctx.lineWidth = 1
  for (const edge of edges.value) {
    const source = edge.source
    const target = edge.target
    if (source?.x === undefined || target?.x === undefined) {
      continue
    }
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.lineTo(target.x, target.y)
    ctx.stroke()
  }
}

function drawClusterHulls() {
  for (const cluster of clusters.value) {
    ctx.fillStyle = cluster.color
    ctx.globalAlpha = 0.12
    if (cluster.hullPoints?.length) {
      ctx.beginPath()
      ctx.moveTo(cluster.hullPoints[0][0], cluster.hullPoints[0][1])
      for (const point of cluster.hullPoints.slice(1)) {
        ctx.lineTo(point[0], point[1])
      }
      ctx.closePath()
      ctx.fill()
    } else if (cluster.circle) {
      ctx.beginPath()
      ctx.arc(cluster.circle.x, cluster.circle.y, cluster.circle.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
}

function drawNodes() {
  for (const node of nodes.value) {
    if (node.x === undefined) {
      continue
    }
    ctx.beginPath()
    ctx.arc(node.x, node.y, radiusFor(node), 0, Math.PI * 2)
    ctx.fillStyle = node.color ?? '#888'
    ctx.fill()
  }
}

/** Below this zoom level a label is unreadably small anyway; skipping the fillText calls entirely
 *  is also what keeps a dense graph's label layer from becoming visual noise. Lowered from `1.1`
 *  to `0.75` (OpenProject #2292, a follow-up to #1287/#1288) so labels persist further into a
 *  zoomed-out view: at the `10px` base font, `1.1` hid labels at 11px effective -- still
 *  comfortably readable -- while `0.75` now hides them at 7.5px effective. */
const LABEL_BASE_FONT_PX = 10
const LABEL_VISIBILITY_ZOOM_THRESHOLD = 0.75

/** Caps how large a label ever draws on screen, regardless of zoom -- without this, the base font is
 *  drawn inside the canvas's `ctx.scale(k, k)` transform, so effective on-screen size is
 *  `LABEL_BASE_FONT_PX * k` uncapped, reaching 80px at the max zoom (`k = 8`, see `attachZoom()`'s
 *  `scaleExtent`). `24` reads as roughly what a label already looks like comfortably zoomed in. */
const LABEL_MAX_EFFECTIVE_FONT_PX = 24

function drawLabels() {
  const scale = zoomTransform.value?.k ?? 1
  if (scale < LABEL_VISIBILITY_ZOOM_THRESHOLD) {
    return
  }
  const fontPx = Math.min(LABEL_BASE_FONT_PX, LABEL_MAX_EFFECTIVE_FONT_PX / scale)
  ctx.font = `${fontPx}px sans-serif`
  ctx.fillStyle = '#333'
  for (const node of nodes.value) {
    if (node.x === undefined) {
      continue
    }
    ctx.fillText(node.title ?? node.path, node.x + 8, node.y + 3)
  }
}

function redraw() {
  nodeQuadtree = d3quadtree(
    nodes.value,
    (d) => d.x,
    (d) => d.y
  )

  recomputeClusters()

  if (!ctx) {
    return
  }
  const canvas = canvasRef.value
  const dpr = window.devicePixelRatio || 1
  ctx.save()
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
  if (zoomTransform.value) {
    ctx.translate(zoomTransform.value.x, zoomTransform.value.y)
    ctx.scale(zoomTransform.value.k, zoomTransform.value.k)
  }
  drawEdges()
  drawClusterHulls()
  drawNodes()
  drawLabels()
  ctx.restore()
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

function onCanvasClick(event) {
  const node = findNodeAt(event.clientX, event.clientY)
  if (!node || node.synthetic) {
    return
  }
  router.push(
    localizedPagePath(node.path, node.locale, {
      useLocales: siteStore.useLocales,
      primary: siteStore.locales.primary,
      forcePrefix: siteStore.locales.forcePrefix
    })
  )
}

function onCanvasMouseMove(event) {
  hoveredNode.value = findNodeAt(event.clientX, event.clientY)
  const containerRect = containerRef.value.getBoundingClientRect()
  tooltipPos.x = event.clientX - containerRect.left
  tooltipPos.y = event.clientY - containerRect.top
}

/*
  `d3.forceLink`'s distance (60) and `d3.forceManyBody`'s charge strength (-120) are starting
  points, not verified-correct constants -- exploratory visual tuning happens once there's a real
  graph on screen (Task 13, #888), not here. `forceCollide`'s radius (`collideRadiusFor`, OpenProject
  #1141) is sized off a plausible node-dot radius, same caveat.

  The `cluster` force (`graphForces.js#clusterForce`, OpenProject #1158) pulls each node toward a
  running centroid of its own group, layered on top of the forces above -- those alone don't
  produce visually coherent clusters (per the spec). `0.05` is a starting point: low enough that
  the other forces still dominate local layout, this is meant to be a bias toward clustering, not
  the dominant force -- tune visually once there's a real graph on screen. It is attached once,
  here, rather than re-attached on every `groupBy` change: unlike the `forceX`/`forceY` pair it
  replaced (which cached their target at force-initialize time -- the root cause of #1158's frozen-
  origin bug), this force recomputes group centroids from the *current* tick's `x`/`y` every time
  d3-force calls it, so a `groupBy` change needs no re-attachment to take effect on the next tick.
*/
function startSimulation() {
  const { width, height } = containerRef.value.getBoundingClientRect()

  simulation = forceSimulation(nodes.value)
    .force(
      'link',
      forceLink(edges.value)
        .id((d) => d.path)
        .distance(60)
    )
    .force('charge', forceManyBody().strength(-120))
    .force('collide', forceCollide(collideRadiusFor))
    .force('center', forceCenter(width / 2, height / 2))
    .force('cluster', clusterForce(groupKeyFor, 0.05))
    .on('tick', redraw)
}

/*
  `16`px is a starting point sized against the `5`px node-dot radius in `drawNodes()` -- tune
  visually so the hull clearly contains the dots without ballooning past neighboring clusters.
*/
const HULL_PADDING = 16

/** Pads a hull outward from its own centroid so the fill visually contains the node dots rather
 *  than passing through their centers, per the spec's "Obsidian-style" sector requirement. */
function padHull(points, padding) {
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length
  return points.map(([x, y]) => {
    const dx = x - cx
    const dy = y - cy
    const len = Math.hypot(dx, dy) || 1
    return [x + (dx / len) * padding, y + (dy / len) * padding]
  })
}

/** Populates `clusters.value` -- one entry per visible group with `hullPoints` (>=3 nodes) or a
 *  fallback `circle` (1-2 nodes, or a degenerate >=3-node group `polygonHull` can't hull, e.g.
 *  every point collinear). */
function computeClusters() {
  const byGroup = new Map()
  for (const node of nodes.value) {
    if (node.x === undefined || node.synthetic) {
      continue
    }
    const key = groupKeyFor(node)
    const list = byGroup.get(key) ?? []
    list.push(node)
    byGroup.set(key, list)
  }

  const result = []
  for (const [key, groupNodes] of byGroup) {
    const color = colorForGroup(key)
    if (groupNodes.length >= 3) {
      const hull = polygonHull(groupNodes.map((n) => [n.x, n.y]))
      if (hull) {
        result.push({ key, color, hullPoints: padHull(hull, HULL_PADDING) })
        continue
      }
      // -> `polygonHull` returns null for degenerate input (e.g. every point collinear) even with
      //    >=3 nodes; fall through to the circle case below rather than drawing nothing.
    }
    const cx = groupNodes.reduce((s, n) => s + n.x, 0) / groupNodes.length
    const cy = groupNodes.reduce((s, n) => s + n.y, 0) / groupNodes.length
    const maxDist = Math.max(...groupNodes.map((n) => Math.hypot(n.x - cx, n.y - cy)), 0)
    result.push({ key, color, circle: { x: cx, y: cy, r: maxDist + HULL_PADDING } })
  }
  clusters.value = result
}

/** Single entry point Task 18's coloring and Task 20's hull computation both funnel through --
 *  called every tick (from `redraw()`) so hulls/colors stay in step with the live layout, and
 *  whenever the grouping dimension or the visible node set changes. */
function recomputeClusters() {
  for (const node of nodes.value) {
    node.color = node.synthetic ? SYNTHETIC_NODE_COLOR : colorForGroup(groupKeyFor(node))
  }
  computeClusters()
}

/*
  `scaleExtent([0.1, 8])` is a starting point (wide enough to read a single node's label at max
  zoom and see the whole graph at min zoom on a typical viewport) -- tune visually once there's
  real data to zoom around in.
*/
function attachZoom() {
  const selection = select(canvasRef.value)
  const behavior = d3zoom()
    .scaleExtent([0.1, 8])
    .on('zoom', (event) => {
      zoomTransform.value = event.transform
      redraw()
    })
  selection.call(behavior)
  zoomTransform.value = zoomIdentity
}

async function loadGraph() {
  isLoading.value = true
  loadError.value = null
  try {
    const graph = await API_CLIENT.get(`sites/${siteStore.id}/graph`).json()
    allNodes.value = graph.nodes ?? []
    allEdges.value = graph.edges ?? []
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
 *  against `activeFilters`, then layers on the current `edgeMode`'s synthetic nodes/edges -- the 872
 *  endpoint's `relation`/`link` edges (`computeVisibleSubset`'s `visibleEdges`) are deliberately not
 *  used here; see OpenProject #997. Called on initial load, by the `activeFilters` watcher, and by
 *  the `edgeMode` watcher below. Does not touch the live simulation itself; that's
 *  `syncSimulationToVisibleSet`'s job, since the initial call here runs before `startSimulation()`
 *  has created one. */
function applyFilters() {
  const { visibleNodes } = computeVisibleSubset(allNodes.value, allEdges.value, activeFilters)
  const { syntheticNodes, edges: syntheticEdges } =
    edgeMode.value === 'tags'
      ? buildTagHubEdges(visibleNodes)
      : edgeMode.value === 'classification'
        ? buildClassificationHubEdges(visibleNodes)
        : buildPathHierarchyEdges(visibleNodes)
  nodes.value = [...visibleNodes, ...syntheticNodes]
  edges.value = syntheticEdges
}

watch(groupBy, () => {
  recomputeClusters()
  simulation?.alpha(0.3).restart()
})

/** Re-attaching `collide` (rather than mutating it in place) is what makes `forceCollide` re-read
 *  every node's radius through `collideRadiusFor()` -- see that function's own doc comment on why a
 *  plain in-place change wouldn't be picked up. No `applyFilters()`/`syncSimulationToVisibleSet()`
 *  call needed: neither the visible node set nor any edge changes here, only how big each dot
 *  draws and how much room `collide` gives it. */
watch([sizeBy, sizeCountMode, contributorTypes, pageviewsWindow, pageviewClientTypes], () => {
  simulation?.force('collide', forceCollide(collideRadiusFor))
  simulation?.alpha(0.3).restart()
  redraw()
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
  A node re-added after being filtered back in loses whatever `x`/`y`/velocity it had before removal
  (it is a fresh entry to `d3-force` as far as the simulation is concerned) -- accepted per the
  spec's own framing ("removed nodes exit the simulation so the remainder re-settles, rather than
  just being drawn hidden"): re-settling is the explicitly wanted behavior, not a bug to work around.
  Synthetic nodes (OpenProject #997) are freshly constructed objects on every `applyFilters()` call
  too, so they re-settle on every `edgeMode`/`activeFilters` change alike, for the same reason.
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

watch(edgeMode, () => {
  applyFilters()
  syncSimulationToVisibleSet()
})

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    sizeCanvas()
    redraw()
  })
  resizeObserver.observe(containerRef.value)
  loadGraph()
  loadPageviewsTrackingState()
})

onBeforeUnmount(() => {
  simulation?.stop()
  resizeObserver?.disconnect()
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
  }
  @at-root .body--dark & {
    background: rgba(0, 0, 0, 0.55);
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
