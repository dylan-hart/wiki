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
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { quadtree as d3quadtree } from 'd3-quadtree'
import { select } from 'd3-selection'
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom'
import { localizedPagePath } from '@/helpers/pagePaths'
import { useSiteStore } from '@/stores/site'

/**
 * The knowledge graph view (OpenProject #848/#873): a full-viewport, canvas-rendered force graph
 * of every page the caller may read on this site. Fetched once on mount -- every filter and
 * re-cluster after that (#874/#875) runs against `nodes`/`edges` already in memory, no further
 * network round trip.
 */

const siteStore = useSiteStore()
const router = useRouter()

const containerRef = ref(null)
const canvasRef = ref(null)

/** Raw payload from `GET sites/{siteId}/graph` -- see `backend/api/graph.ts#Graph`. */
const nodes = ref([])
const edges = ref([])
const isLoading = ref(true)
const loadError = ref(null)

/** 'site' is deliberately not an option here -- see the spec's architecture note: a single loaded
 *  graph has exactly one site value, so grouping by it would be a no-op UI control. */
const groupBy = ref('folder')

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
    if (!cluster.hullPoints?.length) {
      continue
    }
    ctx.beginPath()
    ctx.moveTo(cluster.hullPoints[0][0], cluster.hullPoints[0][1])
    for (const point of cluster.hullPoints.slice(1)) {
      ctx.lineTo(point[0], point[1])
    }
    ctx.closePath()
    ctx.fillStyle = cluster.color
    ctx.globalAlpha = 0.12
    ctx.fill()
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

  for (const node of nodes.value) {
    node.color = colorForGroup(groupKeyFor(node))
  }

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
    nodes.value = graph.nodes ?? []
    edges.value = graph.edges ?? []
    sizeCanvas()
    startSimulation()
    attachZoom()
  } catch (err) {
    loadError.value = err
  } finally {
    isLoading.value = false
  }
}

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
