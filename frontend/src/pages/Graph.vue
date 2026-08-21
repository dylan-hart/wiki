<template>
  <div ref="containerRef" class="graph-view">
    <canvas ref="canvasRef" class="graph-view-canvas" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
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

async function loadGraph() {
  isLoading.value = true
  loadError.value = null
  try {
    const graph = await API_CLIENT.get(`sites/${siteStore.id}/graph`).json()
    nodes.value = graph.nodes ?? []
    edges.value = graph.edges ?? []
  } catch (err) {
    loadError.value = err
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  loadGraph()
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
