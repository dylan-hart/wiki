/**
 * Everything `Graph.vue` paints onto its canvas, as plain functions over a 2D context.
 *
 * They were closures over the page's own refs, which is the only reason they read `nodes.value` /
 * `clusters.value` / `zoomTransform.value` rather than taking them. Taking them makes each layer
 * independently checkable and keeps the page to the one call it actually makes -- `paintGraph()`,
 * which is the save/clear/transform/draw/restore sequence in the order the layers stack.
 *
 * `radiusFor` is passed in rather than recomputed here: how large a node draws depends on the
 * page's current "Size by" mode, which is the page's question, not the canvas's.
 */

import { nodeId } from './graphFilters.js'

/** Edge stroke color, light/dark (OpenProject #2412) -- the light value is the original hardcoded
 *  `rgba(128, 128, 128, 0.35)`. The dark value lightens the gray (128 -> 200) rather than just
 *  raising alpha: on the app's near-black dark surface, 128-gray at 0.35 alpha blends down to
 *  roughly the same near-black it sits on, which is exactly the illegibility this fixes. */
const EDGE_COLOR = {
  light: 'rgba(128, 128, 128, 0.35)',
  dark: 'rgba(200, 200, 200, 0.35)'
}

/** Highlight ring drawn around a keyword-matched node (OpenProject #2480), on top of its own
 *  group-colored fill -- a fixed color kept independent of `Graph.vue`'s `CATEGORICAL_PALETTE` on
 *  purpose, since a match is a search-result state, not a group, and needs to read the same
 *  regardless of which palette slot the node's own group landed on. */
const HIGHLIGHT_RING_COLOR = '#ffd600'
const HIGHLIGHT_RING_WIDTH = 2
const HIGHLIGHT_RING_GAP = 2

/** Opacity for a real node/label that does NOT match the active keyword search, while one is active
 *  -- dimmed, not hidden. OpenProject #2480 is explicitly the non-filtering half of Feature #2414:
 *  every node stays drawn (and clickable), just visually de-emphasized relative to a match. */
const DIMMED_ALPHA = 0.25

export function drawEdges(ctx, edges, dark) {
  ctx.strokeStyle = dark ? EDGE_COLOR.dark : EDGE_COLOR.light
  ctx.lineWidth = 1
  for (const edge of edges) {
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

export function drawClusterHulls(ctx, clusters) {
  for (const cluster of clusters) {
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

/** `highlightedIds` (OpenProject #2480) is an optional `Set` of composite node ids -- omitted, `null`
 *  or empty, every node draws exactly as before. Non-empty: a matching node gets a highlight ring on
 *  top of its normal fill; every other node dims (see `DIMMED_ALPHA`) rather than being skipped, so
 *  the "non-filtering" requirement holds at the paint layer too, not just in what `nodes` contains. */
export function drawNodes(ctx, nodes, radiusFor, highlightedIds) {
  const hasHighlights = highlightedIds && highlightedIds.size > 0
  for (const node of nodes) {
    if (node.x === undefined) {
      continue
    }
    const isMatch = hasHighlights && highlightedIds.has(nodeId(node))
    const radius = radiusFor(node)
    ctx.globalAlpha = hasHighlights && !isMatch ? DIMMED_ALPHA : 1
    ctx.beginPath()
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = node.color ?? '#888'
    ctx.fill()
    if (isMatch) {
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius + HIGHLIGHT_RING_GAP, 0, Math.PI * 2)
      ctx.lineWidth = HIGHLIGHT_RING_WIDTH
      ctx.strokeStyle = HIGHLIGHT_RING_COLOR
      ctx.stroke()
    }
    ctx.globalAlpha = 1
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

/** Breathing room between a node's edge and the start of its label, on top of the node's own
 *  drawn radius (`radiusFor()`) -- matches the gap the old fixed `8` offset left beyond the
 *  smallest node (`MIN_NODE_RADIUS`, `5` -- one shared floor for both sizing metrics since
 *  OpenProject #2561), but now scales with the node so a label never overlaps a larger node's fill
 *  (OpenProject #2297). */
export const LABEL_GAP = 3

/** Label fill color, light/dark (OpenProject #2412) -- the light value is the original hardcoded
 *  `#333`. The dark value is a near-white rather than a plain invert, matching this app's dark-mode
 *  primary-ink convention (`composables/dark.js`'s surfaces, and the dataviz skill's own
 *  light/dark "Primary ink" pair) rather than a bespoke gray picked just for this canvas. */
const LABEL_COLOR = {
  light: '#333',
  dark: '#e8e8e8'
}

/** `highlightedIds` (OpenProject #2480), same optional-`Set` contract as `drawNodes` above: a
 *  non-matching label dims along with its node rather than staying full-strength while its dot
 *  fades, which would read as two disagreeing signals for the same node. */
export function drawLabels(ctx, nodes, radiusFor, scale, dark, highlightedIds) {
  if (scale < LABEL_VISIBILITY_ZOOM_THRESHOLD) {
    return
  }
  const hasHighlights = highlightedIds && highlightedIds.size > 0
  const fontPx = Math.min(LABEL_BASE_FONT_PX, LABEL_MAX_EFFECTIVE_FONT_PX / scale)
  ctx.font = `${fontPx}px sans-serif`
  ctx.fillStyle = dark ? LABEL_COLOR.dark : LABEL_COLOR.light
  for (const node of nodes) {
    if (node.x === undefined) {
      continue
    }
    const isMatch = hasHighlights && highlightedIds.has(nodeId(node))
    ctx.globalAlpha = hasHighlights && !isMatch ? DIMMED_ALPHA : 1
    ctx.fillText(node.title ?? node.path, node.x + radiusFor(node) + LABEL_GAP, node.y + 3)
  }
  ctx.globalAlpha = 1
}

/** Paints the current layout to the canvas -- the `ctx` save/clear/transform/draw/restore sequence
 *  only, no layout recomputation. Safe to call on every zoom/pan frame since it draws the `nodes`,
 *  `edges` and `clusters` it is handed as they last stood rather than rebuilding any of them. */
export function paintGraph({
  ctx,
  canvas,
  transform,
  nodes,
  edges,
  clusters,
  radiusFor,
  dark,
  highlightedIds
}) {
  if (!ctx) {
    return
  }
  const dpr = window.devicePixelRatio || 1
  ctx.save()
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
  if (transform) {
    ctx.translate(transform.x, transform.y)
    ctx.scale(transform.k, transform.k)
  }
  drawEdges(ctx, edges, dark)
  drawClusterHulls(ctx, clusters)
  drawNodes(ctx, nodes, radiusFor, highlightedIds)
  drawLabels(ctx, nodes, radiusFor, transform?.k ?? 1, dark, highlightedIds)
  ctx.restore()
}
