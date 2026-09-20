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
      :data-node-id="n.id"
      :transform="`translate(${n.pos.x} ${n.pos.y})`">
      <!-- The hover scale/filter belongs on this inner <g>, never on the outer one carrying the
           positioning `transform` attribute: a CSS `transform` REPLACES an SVG
           presentation-attribute `transform` on the same element rather than composing with it, so
           sharing one <g> snaps every node to local origin on hover. -->
      <g class="storage-delivery-graph__node">
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
 * All layout math is `helpers/storageDeliveryGraph.js#generateGraph()`'s; this is a presentational
 * pass over its output. Every geometry constant below is scaled by the one NODE_SCALE factor, which
 * keeps their relative proportions while putting the node radius comfortably inside the 15-unit row
 * spacing `generateGraph()` lays adjacent nodes out on -- only the absolute unit changes, and
 * `viewBox` + `preserveAspectRatio` fit that to the card width with no JS of their own.
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

    // -> The axis the group spreads along comes from the pair's node ids in a fixed (sorted) order,
    //    not from any one edge's own source/target: a reversed edge would flip the offset's sign and
    //    collapse two "parallel" lines back onto one.
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

/* `transform-box: fill-box` scales the node around its own center rather than the SVG origin, and
   the hover highlight is a `filter` rather than a hardcoded color so it reads correctly against any
   node color in either theme. */
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
