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

export function drawEdges(ctx, edges) {
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.35)'
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

export function drawNodes(ctx, nodes, radiusFor) {
  for (const node of nodes) {
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

/** Breathing room between a node's edge and the start of its label, on top of the node's own
 *  drawn radius (`radiusFor()`) -- matches the gap the old fixed `8` offset left beyond the
 *  smallest node (`MIN_CONTRIBUTOR_RADIUS`/`MIN_PAGEVIEW_RADIUS`, both `5`), but now scales with
 *  the node so a label never overlaps a larger node's fill (OpenProject #2297). */
export const LABEL_GAP = 3

export function drawLabels(ctx, nodes, radiusFor, scale) {
  if (scale < LABEL_VISIBILITY_ZOOM_THRESHOLD) {
    return
  }
  const fontPx = Math.min(LABEL_BASE_FONT_PX, LABEL_MAX_EFFECTIVE_FONT_PX / scale)
  ctx.font = `${fontPx}px sans-serif`
  ctx.fillStyle = '#333'
  for (const node of nodes) {
    if (node.x === undefined) {
      continue
    }
    ctx.fillText(node.title ?? node.path, node.x + radiusFor(node) + LABEL_GAP, node.y + 3)
  }
}

/** Paints the current layout to the canvas -- the `ctx` save/clear/transform/draw/restore sequence
 *  only, no layout recomputation. Safe to call on every zoom/pan frame since it draws the `nodes`,
 *  `edges` and `clusters` it is handed as they last stood rather than rebuilding any of them. */
export function paintGraph({ ctx, canvas, transform, nodes, edges, clusters, radiusFor }) {
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
  drawEdges(ctx, edges)
  drawClusterHulls(ctx, clusters)
  drawNodes(ctx, nodes, radiusFor)
  drawLabels(ctx, nodes, radiusFor, transform?.k ?? 1)
  ctx.restore()
}
