<template>
  <svg
    class="storage-delivery-graph"
    :viewBox="viewBox"
    preserveAspectRatio="xMidYMid meet"
    role="img"
    :aria-label="ariaLabel">
    <rect
      class="storage-delivery-graph__background"
      :x="viewBoxRect.x"
      :y="viewBoxRect.y"
      :width="viewBoxRect.width"
      :height="viewBoxRect.height"
      :fill="backgroundColor" />
    <line
      v-for="e in renderedEdges"
      :key="e.id"
      class="storage-delivery-graph__edge"
      :class="{ 'storage-delivery-graph__edge--animated': e.animate }"
      :x1="e.x1"
      :y1="e.y1"
      :x2="e.x2"
      :y2="e.y2"
      :stroke="e.color"
      :stroke-width="EDGE_WIDTH"
      :stroke-dasharray="e.dasharray"
      :style="
        e.animate
          ? {
              animationDuration: e.duration + 's',
              /* OpenProject #3134: this custom property MUST carry an explicit unit. Passed as a
                 bare number, `calc(-2 * var(--sdg-dash-len, 1px))` resolves to an untyped <number>,
                 while the keyframe's implicit `from` state (the property's own current value) is a
                 <length> -- Chromium can't interpolate across that type mismatch and silently falls
                 back to a discrete jump at the 50% mark instead of a continuous flow, confirmed live
                 (`getAnimations()` showed the animation running throughout, but
                 `getComputedStyle().strokeDashoffset` only ever read two fixed values, flipping
                 partway through each cycle rather than sweeping between them). `px` here resolves to
                 the SVG user-unit coordinate system this element already draws in, matching every
                 other unitless SVG length in this component. */
              '--sdg-dash-len': e.dasharray + 'px'
            }
          : null
      " />
    <line
      v-for="p in renderedPaths"
      :key="p.id"
      class="storage-delivery-graph__path"
      :x1="p.x1"
      :y1="p.y1"
      :x2="p.x2"
      :y2="p.y2"
      :stroke="p.color"
      :stroke-width="PATH_WIDTH"
      stroke-linecap="square" />
    <g
      v-for="n in nodeList"
      :key="n.id"
      class="storage-delivery-graph__node"
      :data-node-id="n.id"
      :transform="`translate(${n.pos.x} ${n.pos.y})`">
      <rect
        :x="-NODE_RADIUS"
        :y="-NODE_RADIUS"
        :width="NODE_RADIUS * 2"
        :height="NODE_RADIUS * 2"
        :rx="n.borderRadius"
        :fill="n.color" />
      <image
        v-if="n.iconHref"
        :x="-(NODE_RADIUS - ICON_INSET)"
        :y="-(NODE_RADIUS - ICON_INSET)"
        :width="(NODE_RADIUS - ICON_INSET) * 2"
        :height="(NODE_RADIUS - ICON_INSET) * 2"
        :href="n.iconHref" />
    </g>
    <text
      v-for="n in nodeList"
      :key="`${n.id}-label`"
      class="storage-delivery-graph__label"
      :data-node-id="n.id"
      :x="n.pos.x"
      :y="n.pos.y + NODE_RADIUS + LABEL_MARGIN"
      text-anchor="middle"
      dominant-baseline="hanging"
      :font-size="FONT_SIZE"
      :fill="labelColor">
      {{ n.node.name }}
    </text>
  </svg>
</template>

<script setup>
import { computed } from 'vue'

/**
 * Replaces `v-network-graph` (OpenProject #3116/#3084): a small purpose-built SVG renderer over
 * `helpers/storageDeliveryGraph.js#generateGraph()`'s `{ nodes, edges, layouts, paths }` output,
 * which does all the actual layout math (fixed x/y per node on a 15-unit grid) -- this component is
 * a pure presentational pass over it, with no dependency, no zoom/pan, and no dead selection state.
 *
 * The geometry constants below (node radius, edge margin/gap/width, label margin, icon inset, the
 * border-radius fallback, the static dash length) are v-network-graph's own former config values,
 * uniformly rescaled by NODE_SCALE so the default node radius becomes 3.75 -- comfortably smaller
 * than the 15-unit row spacing `generateGraph()` lays adjacent content-type nodes out on. Rescaling
 * everything by the same factor preserves the original proportions (trim distance relative to node
 * size, parallel-edge spacing relative to edge width, ...) exactly; only the absolute unit changes,
 * which `viewBox` + `preserveAspectRatio` below fit to the actual card width with no JS of its own.
 * These ratios were confirmed by rendering the real library (with the config this page used to pass
 * it) against representative `generateGraph()` output in real headless Chromium and reading back its
 * rendered SVG geometry -- including the "edges sharing a node pair spread into evenly-spaced
 * parallel lines" behaviour the streaming-delivery branch's three wiki<->target-module edges exercise.
 */

const NODE_SCALE = 3.75 / 16
const NODE_RADIUS = 16 * NODE_SCALE
const DEFAULT_CORNER_RADIUS = 5 * NODE_SCALE
const EDGE_MARGIN = 4 * NODE_SCALE
const EDGE_GAP = 7 * NODE_SCALE
const EDGE_WIDTH = 3 * NODE_SCALE
const LABEL_MARGIN = 8 * NODE_SCALE
const ICON_INSET = 5 * NODE_SCALE
const STATIC_DASH = 20 * NODE_SCALE
const FONT_SIZE = 11 * NODE_SCALE
const PATH_WIDTH = 7 * NODE_SCALE
const ANIMATION_BASE_SECONDS = 1.5
const LABEL_HEIGHT = FONT_SIZE * 1.6
const VIEW_PADDING = NODE_RADIUS

const props = defineProps({
  nodes: { type: Object, required: true },
  edges: { type: Object, required: true },
  layouts: { type: Object, required: true },
  paths: { type: Array, default: () => [] },
  dark: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' }
})

const backgroundColor = computed(() => (props.dark ? 'var(--color-dark-3)' : '#fff'))
const labelColor = computed(() => (props.dark ? '#e8eaed' : '#000000'))

function positionOf(nodeId) {
  return props.layouts.nodes?.[nodeId] || { x: 0, y: 0 }
}

const nodeList = computed(() =>
  Object.entries(props.nodes).map(([id, node]) => ({
    id,
    node,
    pos: positionOf(id),
    color: node.color || '#1976D2',
    borderRadius:
      node.borderRadius != null ? node.borderRadius * NODE_SCALE : DEFAULT_CORNER_RADIUS,
    iconHref: node.icon && node.icon.endsWith('.svg') ? node.icon : null
  }))
)

/** Groups edge ids sharing the same unordered node pair, in `edges`' own insertion order -- the
 *  only shape that matters for the parallel-offset formula below. */
const edgeGroups = computed(() => {
  const groups = new Map()
  for (const [id, edge] of Object.entries(props.edges)) {
    const key = [edge.source, edge.target].sort().join('|')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ id, edge })
  }
  return [...groups.values()]
})

const renderedEdges = computed(() => {
  const result = []
  for (const group of edgeGroups.value) {
    const n = group.length

    // -> The perpendicular axis edges sharing this node pair are spread along is computed once per
    //    group, off the pair's two node ids in a fixed (sorted) order -- not off any one edge's own
    //    source/target, which can point either way. Using each edge's own direction here would flip
    //    the offset's sign for a reversed edge and collapse two "parallel" lines back onto one.
    const [nodeA, nodeB] =
      group[0].edge.source < group[0].edge.target
        ? [group[0].edge.source, group[0].edge.target]
        : [group[0].edge.target, group[0].edge.source]
    const posA = positionOf(nodeA)
    const posB = positionOf(nodeB)
    const groupLen = Math.hypot(posB.x - posA.x, posB.y - posA.y)
    if (groupLen === 0) continue
    const perpX = -(posB.y - posA.y) / groupLen
    const perpY = (posB.x - posA.x) / groupLen

    group.forEach(({ id, edge }, k) => {
      const source = positionOf(edge.source)
      const target = positionOf(edge.target)
      const dx = target.x - source.x
      const dy = target.y - source.y
      const len = Math.hypot(dx, dy)
      if (len === 0) return

      const ux = dx / len
      const uy = dy / len
      // -> Evenly-spaced parallel offset for edges sharing this node pair: 0 for a lone edge, and
      //    symmetric +/-(width+gap) multiples centered on the source-target line otherwise.
      const offset = ((n - 1) / 2 - k) * (EDGE_WIDTH + EDGE_GAP)

      const trim = NODE_RADIUS + EDGE_MARGIN
      const x1 = source.x + perpX * offset + ux * trim
      const y1 = source.y + perpY * offset + uy * trim
      const x2 = target.x + perpX * offset - ux * trim
      const y2 = target.y + perpY * offset - uy * trim

      const animate = edge.animate !== false
      const animationSpeed = edge.animationSpeed || 50

      result.push({
        id,
        x1,
        y1,
        x2,
        y2,
        color: edge.color || '#1976D2',
        dasharray: animate ? EDGE_WIDTH : STATIC_DASH,
        animate,
        duration: ANIMATION_BASE_SECONDS * (50 / animationSpeed)
      })
    })
  }
  return result
})

/** The missing-origin overlay: a thicker, translucent line reusing an already-trimmed edge's own
 *  computed endpoints rather than re-deriving its own geometry. */
const renderedPaths = computed(() => {
  const byId = new Map(renderedEdges.value.map((e) => [e.id, e]))
  const result = []
  for (const [pathIndex, path] of props.paths.entries()) {
    for (const edgeId of path.edges) {
      const edge = byId.get(edgeId)
      if (!edge) continue
      result.push({
        id: `${pathIndex}-${edgeId}`,
        x1: edge.x1,
        y1: edge.y1,
        x2: edge.x2,
        y2: edge.y2,
        color: path.color
      })
    }
  }
  return result
})

const viewBoxRect = computed(() => {
  const positions = Object.keys(props.nodes).map((id) => positionOf(id))
  if (positions.length === 0) return { x: 0, y: 0, width: 10, height: 10 }

  const xs = positions.map((p) => p.x)
  const ys = positions.map((p) => p.y)
  const minX = Math.min(...xs) - NODE_RADIUS - VIEW_PADDING
  const maxX = Math.max(...xs) + NODE_RADIUS + VIEW_PADDING
  const minY = Math.min(...ys) - NODE_RADIUS - VIEW_PADDING
  const maxY = Math.max(...ys) + NODE_RADIUS + LABEL_MARGIN + LABEL_HEIGHT + VIEW_PADDING

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
})

const viewBox = computed(() => {
  const r = viewBoxRect.value
  return `${r.x} ${r.y} ${r.width} ${r.height}`
})
</script>

<style scoped>
.storage-delivery-graph {
  display: block;
  width: 100%;
  height: 600px;
}

.storage-delivery-graph__edge--animated {
  animation-name: storage-delivery-graph-flow;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

@keyframes storage-delivery-graph-flow {
  to {
    stroke-dashoffset: calc(-2 * var(--sdg-dash-len, 1px));
  }
}

/* Restores the node hover affordance `v-network-graph` drew by default (OpenProject #3134) --
   dropped outright when #3116 replaced it with this plain SVG renderer. There is no old custom
   config to transcribe (AdminStorage.vue never overrode `node.hover`), so this is a fresh,
   theme-agnostic restatement: scale the node around its own center rather than the SVG origin, and
   brighten its fill via `filter` rather than a hardcoded color so it reads correctly against any
   node color and either theme. */
.storage-delivery-graph__node {
  cursor: pointer;
  transform-box: fill-box;
  transform-origin: center;
  transition: transform 0.1s linear;
}

.storage-delivery-graph__node:hover {
  transform: scale(1.15);
}

.storage-delivery-graph__node:hover rect {
  filter: brightness(1.2);
  transition: filter 0.1s linear;
}
</style>
