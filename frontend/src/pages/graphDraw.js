/**
 * The canvas layers `Graph.vue` paints, as plain functions over a 2D context with no DOM access of
 * their own: each takes what it draws rather than closing over the page's refs, which keeps every
 * layer independently checkable. Anything that depends on page state -- `radiusFor` (the current
 * "Size by" mode), a theme color resolved off a custom property -- is handed in.
 */

import { nodeId } from './graphFilters.js'

/** The dark value lightens the gray (128 -> 200) rather than raising alpha: on the app's near-black
 *  dark surface, 128-gray at 0.35 alpha blends down into the surface it sits on. */
const EDGE_COLOR = {
  light: 'rgba(128, 128, 128, 0.35)',
  dark: 'rgba(200, 200, 200, 0.35)'
}

/** Deliberately outside `Graph.vue`'s `CATEGORICAL_PALETTE`: a keyword match is a search-result
 *  state, not a group, and has to read the same whichever palette slot its group landed on. */
const HIGHLIGHT_RING_COLOR = '#ffd600'
const HIGHLIGHT_RING_WIDTH = 2
const HIGHLIGHT_RING_GAP = 2

/** The synthetic folder-hierarchy root is a permanent structural landmark -- the edge mode fans
 *  everything out from it -- not a search-result state, so its ring draws at all times. A different
 *  hue from `HIGHLIGHT_RING_COLOR` keeps the two from reading as one signal on a node where both
 *  apply. One value, not a light/dark pair: it reads on either canvas surface. */
const ROOT_RING_COLOR = '#ff4081'
const ROOT_RING_WIDTH = 2
const ROOT_RING_GAP = 3

/** A keyword search dims rather than filters: a non-matching node stays drawn and clickable. */
const DIMMED_ALPHA = 0.25

/** A white overlay filled on top of the hovered node's own color, rather than a per-color lightened
 *  hex: it lightens a group color and a synthetic node's flat gray equally. */
const HOVER_TINT_COLOR = 'rgba(255, 255, 255, 0.3)'

/** A mirror of the sidebar's selected row (`stores/graph.js#selectedPath`), never something a
 *  canvas click creates -- a canvas click only navigates. The gap clears the highlight ring's own
 *  outer edge, so on a node carrying both the two rings stack rather than overlap. */
const SELECTED_RING_GAP = 6
const SELECTED_RING_WIDTH = 3

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

/** Level-1 clusters keep their categorical color-coding; deeper nesting carries no grouping
 *  identity of its own, so every level-2/3 circle shares one mid-gray instead of a second palette.
 *  Not shared with `Graph.vue`'s identical `SYNTHETIC_NODE_COLOR`: they mark unrelated things. */
const NESTED_CLUSTER_FILL_COLOR = '#9e9e9e'

/** Circles despite the name, never convex-hull polygons: a uniform look across every grouping mode.
 *
 *  Painted outermost-to-innermost so a nested circle's tint stacks on top of its parent's, sorted
 *  explicitly rather than trusting `computeClusters()`'s iteration order, which guarantees none. */
export function drawClusterHulls(ctx, clusters) {
  const ordered = [...clusters].sort((a, b) => (a.level ?? 1) - (b.level ?? 1))
  for (const cluster of ordered) {
    if (!cluster.circle) {
      continue
    }
    const level = cluster.level ?? 1
    ctx.fillStyle = level >= 2 ? NESTED_CLUSTER_FILL_COLOR : cluster.color
    ctx.globalAlpha = 0.12
    ctx.beginPath()
    ctx.arc(cluster.circle.x, cluster.circle.y, cluster.circle.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }
}

/** `dimmingIds` defaults to `highlightedIds`, and `Graph.vue` is the one caller that passes the two
 *  apart: its `highlightedIds` is keyword matches UNION the route-focused anchor node, so the
 *  anchor draws its ring, while `dimmingIds` is keyword matches alone -- an anchor must never by
 *  itself dim every other node, only an active keyword filter may.
 *
 *  `hoveredNode` is compared by reference, being the same object this loop iterates; `selectedId`
 *  by id, since the caller resolves it from a bare path rather than holding the node.
 *  `selectedRingColor` is resolved by that caller, this module having no DOM to read tokens. */
export function drawNodes(
  ctx,
  nodes,
  radiusFor,
  highlightedIds,
  hoveredNode,
  dimmingIds = highlightedIds,
  selectedId = null,
  selectedRingColor = null
) {
  const hasHighlights = highlightedIds && highlightedIds.size > 0
  const hasDimming = dimmingIds && dimmingIds.size > 0
  for (const node of nodes) {
    if (node.x === undefined) {
      continue
    }
    const isMatch = hasHighlights && highlightedIds.has(nodeId(node))
    const radius = radiusFor(node)
    ctx.globalAlpha = hasDimming && !isMatch ? DIMMED_ALPHA : 1
    ctx.beginPath()
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = node.color ?? '#888'
    ctx.fill()
    if (node === hoveredNode) {
      ctx.fillStyle = HOVER_TINT_COLOR
      ctx.fill()
    }
    if (node.root) {
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius + ROOT_RING_GAP, 0, Math.PI * 2)
      ctx.lineWidth = ROOT_RING_WIDTH
      ctx.strokeStyle = ROOT_RING_COLOR
      ctx.stroke()
    }
    if (isMatch) {
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius + HIGHLIGHT_RING_GAP, 0, Math.PI * 2)
      ctx.lineWidth = HIGHLIGHT_RING_WIDTH
      ctx.strokeStyle = HIGHLIGHT_RING_COLOR
      ctx.stroke()
    }
    if (selectedId && selectedRingColor && nodeId(node) === selectedId) {
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius + SELECTED_RING_GAP, 0, Math.PI * 2)
      ctx.lineWidth = SELECTED_RING_WIDTH
      ctx.strokeStyle = selectedRingColor
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }
}

const LABEL_BASE_FONT_PX = 10

/** Caps how large a label ever draws on screen: the base font is drawn inside the canvas's
 *  `ctx.scale(k, k)` transform, so uncapped its effective size would be `LABEL_BASE_FONT_PX * k`,
 *  reaching 80px at the maximum zoom. The cap also trades characters against apparent size -- a
 *  smaller drawn font fits more of a title inside the same circle before truncation. */
export const LABEL_MAX_EFFECTIVE_FONT_PX = 32

/** Breathing room between a node's edge and its label -- SYNTHETIC nodes only, since a real node's
 *  title draws inside its own circle. A synthetic folder/root hub draws at a fixed radius too small
 *  to hold text, so it keeps the beside-the-node placement rather than losing its label. */
export const LABEL_GAP = 6

/** The dark value is the app's dark-mode primary ink, not an inverted `#333` or a gray picked for
 *  this canvas alone. */
const LABEL_COLOR = {
  light: '#333',
  dark: '#e8e8e8'
}

/** A label sits ON the node's own fill, which is not one known color: a categorical group color, a
 *  synthetic node's flat gray, both swapping in dark mode. Switching the ink per node by luminance
 *  would cost a contrast computation per node per frame and make one label layer read as two
 *  signals; a halo keeps ONE ink and puts a band of the surface color behind the glyphs. Inverted
 *  from `LABEL_COLOR`, so the halo always sits opposite the ink it backs. */
const LABEL_HALO_COLOR = {
  light: '#ffffff',
  dark: '#101010'
}

/** Halo thickness as a fraction of the drawn font size: `lineWidth` is the FULL stroke width and a
 *  stroked glyph is centered on its own outline, so only half of this lands outside the glyph.
 *  Scaled with the font rather than fixed in px, so the halo stays proportionate as the label
 *  shrinks under `LABEL_MAX_EFFECTIVE_FONT_PX` at high zoom. */
const LABEL_HALO_WIDTH_RATIO = 0.14

/** An inset on the exact inscribed chord, which would otherwise put the first and last glyph flush
 *  against the circle's edge. */
const LABEL_INSCRIBED_WIDTH_RATIO = 0.9

const LABEL_ELLIPSIS = '…'

/** The chord at +/- half the text's own height, inset by `LABEL_INSCRIBED_WIDTH_RATIO`. Exact
 *  circle geometry rather than a fraction-of-diameter approximation: it costs one `sqrt` and makes
 *  the "too small to label at all" case fall out for free -- a radius that does not exceed half the
 *  font height answers `0`, with no separate floor constant to keep in step. */
function insideNodeTextWidth(radius, fontPx) {
  const halfHeight = fontPx / 2
  const halfChordSquared = radius * radius - halfHeight * halfHeight
  if (halfChordSquared <= 0) {
    return 0
  }
  return 2 * Math.sqrt(halfChordSquared) * LABEL_INSCRIBED_WIDTH_RATIO
}

/** `ctx.measureText` is the one genuinely expensive call in this layer, `drawLabels()` runs per
 *  node on every zoom/pan frame, and truncation measures several times per node -- so `fitLabel()`
 *  memoizes on the only three inputs that change the answer. Cleared wholesale rather than evicted
 *  entry by entry: this is a frame-rate cache, not a correctness one, so a cold rebuild costs one
 *  frame of measuring and nothing else. */
const LABEL_CACHE_MAX = 4096
const labelCache = new Map()

export function resetLabelCache() {
  labelCache.clear()
}

/** `null` means the node cannot hold even one character plus the ellipsis -- this layer's "draw no
 *  label at all" answer.
 *
 *  That cutoff comes from truncation rather than from a minimum-radius constant on purpose: the
 *  radius floor is a non-exported `Graph.vue` local, so a copy here would silently stop agreeing
 *  the moment it is retuned. "Does a character fit?" stays correct by construction. */
function fitLabel(ctx, text, maxWidth, fontPx) {
  if (!text || maxWidth <= 0) {
    return null
  }
  const key = `${Math.round(fontPx * 100)}|${Math.floor(maxWidth)}|${text}`
  const cached = labelCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const fitted = measureFit(ctx, text, maxWidth)
  if (labelCache.size >= LABEL_CACHE_MAX) {
    labelCache.clear()
  }
  labelCache.set(key, fitted)
  return fitted
}

function measureFit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) {
    return text
  }
  if (ctx.measureText(`${text.slice(0, 1)}${LABEL_ELLIPSIS}`).width > maxWidth) {
    return null
  }
  //    Binary-search the prefix length rather than walking it down a character at a time: a long
  //    title in a small node would otherwise cost dozens of measurements for the one answer.
  let low = 1
  let high = text.length - 1
  let best = 1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (ctx.measureText(`${text.slice(0, mid)}${LABEL_ELLIPSIS}`).width <= maxWidth) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return `${text.slice(0, best)}${LABEL_ELLIPSIS}`
}

/** A node's drawn-radius growth over `minRadius` carries into its label's font at HALF that rate: a
 *  node at `minRadius` draws the plain `LABEL_BASE_FONT_PX`, one at `5.5x` the floor draws `3.25x`.
 *  `Math.max(1, …)` floors the growth, so a radius below `minRadius` -- which the caller's own
 *  clamp never produces, but a test harness can hand in -- answers the base font, not a smaller. */
function labelBaseFontFor(radius, minRadius) {
  const nodeGrowth = Math.max(1, radius / minRadius)
  const labelScale = 1 + 0.5 * (nodeGrowth - 1)
  return LABEL_BASE_FONT_PX * labelScale
}

/** A real node's title draws inside its own circle, centered and truncated to fit; the full title
 *  stays reachable through `Graph.vue`'s DOM hover tooltip, so this layer adds none of its own.
 *
 *  A SYNTHETIC node draws at a fixed radius with no inside to write in, so it keeps the
 *  beside-the-node placement. It is not part of "Size by" either, so it is excluded from the
 *  radius-based font scaling and draws at the plain, zoom-capped `LABEL_BASE_FONT_PX`.
 *
 *  A label dims with its node rather than staying full strength while its dot fades, which would
 *  read as two disagreeing signals for the same node. */
export function drawLabels(
  ctx,
  nodes,
  radiusFor,
  scale,
  dark,
  highlightedIds,
  minRadius,
  dimmingIds = highlightedIds
) {
  const hasHighlights = highlightedIds && highlightedIds.size > 0
  const hasDimming = dimmingIds && dimmingIds.size > 0
  const zoomCappedFontPx = LABEL_MAX_EFFECTIVE_FONT_PX / scale
  const fillColor = dark ? LABEL_COLOR.dark : LABEL_COLOR.light
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.fillStyle = fillColor
  ctx.strokeStyle = dark ? LABEL_HALO_COLOR.dark : LABEL_HALO_COLOR.light
  for (const node of nodes) {
    if (node.x === undefined) {
      continue
    }
    const title = node.title ?? node.path
    const radius = radiusFor(node)
    const baseFontPx = node.synthetic ? LABEL_BASE_FONT_PX : labelBaseFontFor(radius, minRadius)
    const fontPx = Math.min(baseFontPx, zoomCappedFontPx)
    ctx.font = `${fontPx}px sans-serif`
    ctx.fillStyle = fillColor
    ctx.lineWidth = fontPx * LABEL_HALO_WIDTH_RATIO
    let text = title
    let x = node.x
    if (node.synthetic) {
      ctx.textAlign = 'left'
      x = node.x + radius + LABEL_GAP
    } else {
      ctx.textAlign = 'center'
      text = fitLabel(ctx, title, insideNodeTextWidth(radius, fontPx), fontPx)
      if (text === null) {
        continue
      }
    }
    const isMatch = hasHighlights && highlightedIds.has(nodeId(node))
    ctx.globalAlpha = hasDimming && !isMatch ? DIMMED_ALPHA : 1
    //    Halo first, fill second -- stroking after the fill would eat into the glyphs' own edges.
    ctx.strokeText(text, x, node.y)
    ctx.fillText(text, x, node.y)
  }
  ctx.globalAlpha = 1
}

/** The `ctx` save/clear/transform/draw/restore sequence only, with no layout recomputation: it
 *  draws the `nodes`, `edges` and `clusters` it is handed as they last stood, so it is safe to call
 *  on every zoom/pan frame. */
export function paintGraph({
  ctx,
  canvas,
  transform,
  nodes,
  edges,
  clusters,
  radiusFor,
  minRadius,
  dark,
  highlightedIds,
  hoveredNode,
  dimmingIds = highlightedIds,
  selectedId = null,
  selectedRingColor = null
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
  drawNodes(
    ctx,
    nodes,
    radiusFor,
    highlightedIds,
    hoveredNode,
    dimmingIds,
    selectedId,
    selectedRingColor
  )
  drawLabels(ctx, nodes, radiusFor, transform?.k ?? 1, dark, highlightedIds, minRadius, dimmingIds)
  ctx.restore()
}
