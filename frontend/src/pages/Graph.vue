<template>
  <div ref="containerRef" class="graph-view">
    <canvas ref="canvasRef" class="graph-view-canvas" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import { useSiteStore } from '@/stores/site'

/**
 * The knowledge graph view (OpenProject #848/#873): a full-viewport, canvas-rendered force graph
 * of every page the caller may read on this site. Fetched once on mount -- every filter and
 * re-cluster after that (#874/#875) runs against `nodes`/`edges` already in memory, no further
 * network round trip.
 */

const siteStore = useSiteStore()

const containerRef = ref(null)
const canvasRef = ref(null)

/** Raw payload from `GET sites/{siteId}/graph` -- see `backend/api/graph.ts#Graph`. */
const nodes = ref([])
const edges = ref([])
const isLoading = ref(true)
const loadError = ref(null)

let simulation = null
let ctx = null
let resizeObserver = null

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

async function loadGraph() {
  isLoading.value = true
  loadError.value = null
  try {
    const graph = await API_CLIENT.get(`sites/${siteStore.id}/graph`).json()
    nodes.value = graph.nodes ?? []
    edges.value = graph.edges ?? []
    sizeCanvas()
    startSimulation()
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
</style>
