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
    </div>
    <div class="graph-view-controls">
      <w-btn-toggle
        v-model="groupBy"
        no-caps
        :options="[
          { label: 'Folder', value: 'folder' },
          { label: 'Tag', value: 'tag' }
        ]" />
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
        v-if="siteStore.locales.showMenu"
        v-model="activeFilters.locale"
        outlined
        dense
        options-dense
        :options="localeOptions"
        :label="t('graph.filters.locale')" />
    </div>
    <div class="graph-view-legend">
      <div v-for="entry in legendEntries" :key="entry.key" class="graph-view-legend-item">
        <span class="graph-view-legend-swatch" :style="{ backgroundColor: entry.color }" />
        <span class="graph-view-legend-label">{{ entry.key }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY
} from 'd3-force'
import { polygonHull } from 'd3-polygon'
import { quadtree as d3quadtree } from 'd3-quadtree'
import { select } from 'd3-selection'
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom'
import { localizedPagePath } from '@/helpers/pagePaths'
import { useSiteStore } from '@/stores/site'
import { computeVisibleSubset, deriveFilterOptions } from './graphFilters.js'

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

/** Drill-down filter state (OpenProject #875): the AND of whichever of these are non-empty narrows
 *  the visible node/edge subset -- see `graphFilters.js#computeVisibleSubset` (Task 25). `'site'` is
 *  deliberately not a field here, same reasoning as `groupBy` above: a single loaded graph has
 *  exactly one site value, so filtering by it would be a no-op. */
const activeFilters = reactive({
  tags: [],
  folderDepth: null,
  locale: null
})

/** The tag/locale values offered by the filter panel's `w-select`s, derived from `allNodes` (the
 *  full fetched graph, not the currently-filtered `nodes.value`) -- no separate endpoint
 *  (OpenProject #899). Deriving from `allNodes` rather than `nodes` matters once Task 26 (#901)
 *  redefines `nodes.value` as the currently-VISIBLE subset: options must stay the full universe of
 *  choices, or picking one filter (say, a locale) would shrink another filter's own dropdown (say,
 *  tags) down to whatever survived it, silently hiding tags the viewer could otherwise combine. */
const filterOptions = computed(() => deriveFilterOptions(allNodes.value))
const tagOptions = computed(() => filterOptions.value.tags)
const localeOptions = computed(() => filterOptions.value.locales)

function groupKeyFor(node) {
  if (groupBy.value === 'tag') {
    return node.tags?.[0] ?? '(untagged)'
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
  Node radius (5), edge stroke color/opacity, and the `scale < 1.5` label threshold below are
  starting points for visual tuning, not verified-correct constants -- adjust them against a real
  graph in the browser once there's data on screen.
*/
function drawEdges() {
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.35)'
  ctx.lineWidth = 1
  for (const edge of edges.value) {
    const source = edge.source
    const target = edge.target
    if (!source?.x || !target?.x) {
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
    ctx.arc(node.x, node.y, 5, 0, Math.PI * 2)
    ctx.fillStyle = node.color ?? '#888'
    ctx.fill()
  }
}

function drawLabels() {
  const scale = zoomTransform.value?.k ?? 1
  // -> Below this zoom level a label is unreadably small anyway; skipping the fillText calls
  //    entirely is also what keeps a dense graph's label layer from becoming visual noise.
  if (scale < 1.5) {
    return
  }
  ctx.font = '10px sans-serif'
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
  if (!node) {
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
  graph on screen (Task 13, #888), not here. `forceCollide(14)` is sized off a plausible node-dot
  radius, same caveat.
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
    .force('collide', forceCollide(14))
    .force('center', forceCenter(width / 2, height / 2))
    .on('tick', redraw)
}

/*
  Pulls each node toward a running centroid of its own group, layered on top of the link/charge/
  collision forces above -- those alone don't produce visually coherent clusters (per the spec).
  `0.05` is a starting point: low enough that the other forces still dominate local layout, this
  is meant to be a bias toward clustering, not the dominant force -- tune visually once there's a
  real graph on screen. Centroids are computed from the *previous* tick's settled positions (a
  "running" centroid) rather than recomputed some other way, matching how every other d3-force
  force reads node `x`/`y` mutated in place by the tick before it.
*/
function groupCentroids() {
  const sums = new Map()
  for (const node of nodes.value) {
    if (node.x === undefined) {
      continue
    }
    const key = groupKeyFor(node)
    const entry = sums.get(key) ?? { x: 0, y: 0, count: 0 }
    entry.x += node.x
    entry.y += node.y
    entry.count += 1
    sums.set(key, entry)
  }
  const centroids = new Map()
  for (const [key, { x, y, count }] of sums) {
    centroids.set(key, { x: x / count, y: y / count })
  }
  return centroids
}

let centroids = new Map()

function applyClusteringForce() {
  if (!simulation) {
    return
  }
  centroids = groupCentroids()
  simulation
    .force('clusterX', forceX((d) => centroids.get(groupKeyFor(d))?.x ?? 0).strength(0.05))
    .force('clusterY', forceY((d) => centroids.get(groupKeyFor(d))?.y ?? 0).strength(0.05))
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
    if (node.x === undefined) {
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
    node.color = colorForGroup(groupKeyFor(node))
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
    applyClusteringForce()
    attachZoom()
  } catch (err) {
    loadError.value = err
  } finally {
    isLoading.value = false
  }
}

/** Recomputes `nodes.value`/`edges.value` (the currently-visible subset the simulation runs on)
 *  from `allNodes`/`allEdges` against `activeFilters` -- called on initial load and by the
 *  `activeFilters` watcher below. Does not touch the live simulation itself; that's the watcher's
 *  job, since the initial call here runs before `startSimulation()` has created one. */
function applyFilters() {
  const { visibleNodes, visibleEdges } = computeVisibleSubset(
    allNodes.value,
    allEdges.value,
    activeFilters
  )
  nodes.value = visibleNodes
  edges.value = visibleEdges
}

watch(groupBy, () => {
  applyClusteringForce()
  recomputeClusters()
  simulation?.alpha(0.3).restart()
})

/*
  A node re-added after being filtered back in loses whatever `x`/`y`/velocity it had before removal
  (it is a fresh entry to `d3-force` as far as the simulation is concerned) -- accepted per the
  spec's own framing ("removed nodes exit the simulation so the remainder re-settles, rather than
  just being drawn hidden"): re-settling is the explicitly wanted behavior, not a bug to work around.
*/
watch(
  activeFilters,
  () => {
    applyFilters()
    if (simulation) {
      simulation.nodes(nodes.value)
      simulation.force('link')?.links(edges.value)
      recomputeClusters()
      simulation.alpha(0.5).restart()
    }
  },
  { deep: true }
)

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    sizeCanvas()
    redraw()
  })
  resizeObserver.observe(containerRef.value)
  loadGraph()
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

.graph-view-controls {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 1;
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
  position: absolute;
  top: 64px;
  right: 16px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  border-radius: 4px;
  backdrop-filter: blur(4px);
  max-height: calc(100% - 96px);
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
