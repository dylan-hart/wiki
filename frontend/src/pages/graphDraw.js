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

/** Ring drawn permanently around the synthetic folder-hierarchy root node (`node.root`, OpenProject
 *  #2563) -- unlike the highlight ring above, this one does not depend on an active keyword search:
 *  the root is a fixed structural landmark in the graph (folder-hierarchy edge mode fans everything
 *  out from it), so it needs to read distinctly at all times, not only while it happens to match a
 *  search. A different hue from `HIGHLIGHT_RING_COLOR` keeps the two rings from reading as the same
 *  signal on the rare node where both apply at once. Like `HIGHLIGHT_RING_COLOR` and
 *  `SYNTHETIC_NODE_COLOR`, a single value reads clearly enough on both the light and dark canvas
 *  surface that it needs no light/dark pair of its own. */
const ROOT_RING_COLOR = '#ff4081'
const ROOT_RING_WIDTH = 2
const ROOT_RING_GAP = 3

/** Opacity for a real node/label that does NOT match the active keyword search, while one is active
 *  -- dimmed, not hidden. OpenProject #2480 is explicitly the non-filtering half of Feature #2414:
 *  every node stays drawn (and clickable), just visually de-emphasized relative to a match. */
const DIMMED_ALPHA = 0.25

/** A white overlay at this alpha, filled on top of the moused-over node's own color, is what "a
 *  lighter tint of the node's own color" means here -- lightening whatever the underlying fill is
 *  (a real node's group color, a synthetic node's flat gray) equally, rather than computing a
 *  per-color lightened hex. `paintGraph()` runs on every animation frame with no transition of its
 *  own, so this reads as instant on/off exactly by not doing anything special for it. */
const HOVER_TINT_COLOR = 'rgba(255, 255, 255, 0.3)'

/** Ring/label treatment for the graph's currently-SELECTED node (OpenProject #3364, Feature #3362's
 *  "highlight both the current anchor node and the currently-selected node") -- the click-driven
 *  `selectedNodeId` state OpenProject #3363 added to `Graph.vue`, distinct from both `hoveredNode`
 *  (mouse-over only) and the anchor's own permanent `HIGHLIGHT_RING_COLOR` ring.
 *
 *  Unlike every other color in this file, `selectedRingColor`/`selectedLabelColor` (`drawNodes`/
 *  `drawLabels` below) are NOT a literal pair declared here: they are resolved by `Graph.vue` itself,
 *  fresh, off the exact CSS custom properties the nav sidebar's own "current row" style
 *  (`.router-link-exact-active`, `NavSidebar.vue` lines 248-304) resolves against --
 *  `--color-accent-fill`/`--color-ink` under Ledger light (and Cobalt light, which redefines both on
 *  `body.body--cobalt`), `--color-accent-dark`/`--color-text-dark` under dark (Ledger or Cobalt, same
 *  reason, via `body.body--cobalt.body--dark`). This file stays a plain function over a `ctx` with no
 *  DOM access of its own (see the file's own top-of-file doc comment), so it takes the resolved
 *  strings as plain arguments rather than reaching for `getComputedStyle` itself -- a hardcoded pair
 *  here would silently drift out of sync with the sidebar the moment either token's value changed.
 *
 *  `SELECTED_RING_GAP`/`_WIDTH` place this ring OUTSIDE the anchor/highlight ring's own outer edge
 *  (`HIGHLIGHT_RING_GAP` + `HIGHLIGHT_RING_WIDTH` / 2 = 3px out from the node's own radius) so a node
 *  that is simultaneously anchored and selected draws two concentric, visually distinguishable rings
 *  rather than one overdrawing the other -- the acceptance criterion this Task exists to satisfy. */
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

/** Shared, mode-independent fill for level-2/3 cluster circles (OpenProject #3340). Level-1 clusters
 *  keep today's categorical color-coding (`colorForGroup()`, `Graph.vue`) -- nesting depth beyond
 *  that doesn't carry its own semantic grouping identity, so every level-2/3 circle shares one fill
 *  instead of a second categorical palette. Follows the existing `SYNTHETIC_NODE_COLOR` (`#9e9e9e`,
 *  `Graph.vue`) precedent: a mid-gray reads clearly enough on both the light and dark canvas surface
 *  that it needs no light/dark pair of its own. Not imported from `Graph.vue` -- that constant isn't
 *  exported, and the two are allowed to drift independently since they mark unrelated things (a
 *  synthetic node vs. a nesting-depth circle) that only happen to want the same neutral today. */
const NESTED_CLUSTER_FILL_COLOR = '#9e9e9e'

/** Draws each group's tint as a circle (OpenProject #2836: always a circle, never a convex-hull
 *  polygon, for a uniform look across every grouping). `computeClusters()` is the only producer of
 *  `clusters`, and it now populates `circle` unconditionally.
 *
 *  Draws outermost-to-innermost -- level-1 circles first, then level-2, then level-3 (OpenProject
 *  #3340) -- so a nested circle's tint visibly stacks on top of its parent's instead of being
 *  painted underneath it. Sorted explicitly by each entry's own `level` field on a copy of
 *  `clusters`, rather than trusting the producer's (`computeClusters()`, OpenProject #3339) `Map`/
 *  array iteration order, which carries no ordering guarantee and isn't this function's contract to
 *  rely on. An entry with no `level` (today's tag/classification grouping modes, which stay
 *  single-level) sorts and paints as level 1. Level-2/3 entries always fill with
 *  `NESTED_CLUSTER_FILL_COLOR` regardless of `cluster.color`/whatever palette slot their key landed
 *  on -- level-1 is the only level colored per-group. */
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

/** `highlightedIds` (OpenProject #2480) is an optional `Set` of composite node ids -- omitted, `null`
 *  or empty, every node draws exactly as before. Non-empty: a matching node gets a highlight ring on
 *  top of its normal fill.
 *
 *  `dimmingIds` (OpenProject #3312's revert) is a SEPARATE optional `Set` gating which nodes dim
 *  (see `DIMMED_ALPHA`) -- defaulting to `highlightedIds` so a caller that only ever had one set (every
 *  test in this file included) keeps behaving exactly as before. `Graph.vue` is the one caller that
 *  passes the two apart: `highlightedIds` there is keyword matches UNION the route-focused "anchor"
 *  node (so the anchor still draws its ring), but `dimmingIds` is keyword matches ALONE -- the anchor
 *  being set must never by itself dim every other node, only an active keyword filter may. The
 *  "non-filtering" requirement (a keyword search highlights, never hides) still holds either way: a
 *  dimmed node stays drawn and clickable, just de-emphasized.
 *
 *  `node.root` (OpenProject #2563) gets its own ring, drawn independently of `highlightedIds` --
 *  the folder-hierarchy root is a permanent landmark, not a search-result state, so it strokes every
 *  time this function draws it (dimmed the same as any other non-matching node while a keyword
 *  search is active, same as the rest of `node`'s own draw). A root node that also happens to match
 *  the active keyword search draws both rings, one just outside the other.
 *
 *  `hoveredNode` (the object `Graph.vue#findNodeAt()` returns, or `null`) gets the white-overlay
 *  tint above -- compared by reference, not by id, since it is the very same node object this
 *  function is already iterating.
 *
 *  `selectedId` (OpenProject #3364, see `SELECTED_RING_GAP`'s own doc comment above) is an optional
 *  composite `${locale}:${path}` id -- compared by id, unlike `hoveredNode`, since `selectedNodeId`
 *  in `Graph.vue` holds an id rather than a node reference (it must survive the node object being
 *  replaced by a later reload). `selectedRingColor` is the resolved color string to stroke it with;
 *  omitted, `null` or a falsy `selectedId`/`selectedRingColor` draws no ring at all, same
 *  no-op-by-default convention `highlightedIds` follows. A selected node still draws its OWN ring
 *  even while dimmed by an unrelated keyword search, same as the root ring above. */
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

/** Caps how large a label ever draws on screen, regardless of zoom -- without this, the base font is
 *  drawn inside the canvas's `ctx.scale(k, k)` transform, so effective on-screen size is
 *  `LABEL_BASE_FONT_PX * k` uncapped, reaching 80px at the max zoom (`k = 8`, see `attachZoom()`'s
 *  `scaleExtent`). Raised from `24` to `32` (OpenProject #2562): a node's own drawn radius can now
 *  reach `110` (vs. the old `22`, OpenProject #2561), and at the old `24`px cap a label read small
 *  relative to the circle it labels once zoomed in close enough to matter -- `32` keeps it legibly
 *  proportionate at the new max node size. Since OpenProject #2593 the cap also decides how much of
 *  a title survives truncation at high zoom, not only how big the label looks: a smaller drawn font
 *  fits more characters inside the same circle, so this constant now trades characters against
 *  apparent size rather than only setting the latter. Exported (like `LABEL_GAP` below) so a test
 *  can assert against the live constant rather than a duplicated literal. */
export const LABEL_MAX_EFFECTIVE_FONT_PX = 32

/** Breathing room between a node's edge and the start of its label, on top of the node's own drawn
 *  radius (`radiusFor()`). Since OpenProject #2593 this applies to SYNTHETIC nodes only: a real
 *  node's title now draws inside its own circle, so it has no gap beside it to leave. A synthetic
 *  folder/root hub draws at a fixed radius of `3` (`Graph.vue`'s `radiusFor()`) and could never hold
 *  text inside it, so it keeps the original beside-the-node placement rather than losing its label
 *  -- see `drawLabels()`. Deliberately no longer restates `MIN_NODE_RADIUS`'s value: that constant
 *  is a `Graph.vue`-local that has been retuned more than once, and a hand-copied value of it in a
 *  comment over here is exactly the thing that goes stale. Raised from `3` to `6` in OpenProject
 *  #2562, when the radius it once sat beside grew `5x`. */
export const LABEL_GAP = 6

/** Label fill color, light/dark (OpenProject #2412) -- the light value is the original hardcoded
 *  `#333`. The dark value is a near-white rather than a plain invert, matching this app's dark-mode
 *  primary-ink convention (`composables/dark.js`'s surfaces, and the dataviz skill's own
 *  light/dark "Primary ink" pair) rather than a bespoke gray picked just for this canvas. */
const LABEL_COLOR = {
  light: '#333',
  dark: '#e8e8e8'
}

/** Halo stroked behind the label fill (OpenProject #2593). A label now sits ON the node's own fill,
 *  and that fill is not one known color: a real node is colored by its group out of the categorical
 *  palette (anything from a pale yellow to a mid-tone blue), a synthetic one is flat gray, and both
 *  palettes swap wholesale in dark mode. Switching the ink per node by luminance would mean a
 *  contrast computation per node per frame AND would make one graph's label layer read as two
 *  different signals; a halo instead keeps ONE ink color and puts a thin band of the surface color
 *  between the glyphs and whatever is underneath, which is what makes the same ink legible over
 *  every fill. The pair is `LABEL_COLOR`'s two surfaces inverted, so the halo always sits at the far
 *  end of the contrast range from the ink it backs. */
const LABEL_HALO_COLOR = {
  light: '#ffffff',
  dark: '#101010'
}

/** Halo thickness as a fraction of the drawn font size -- `lineWidth` is the FULL stroke width and a
 *  stroked glyph is centered on its own outline, so only half of this lands outside the glyph.
 *  Scaling it with the font rather than fixing it in px keeps the halo proportionate as the label
 *  shrinks under `LABEL_MAX_EFFECTIVE_FONT_PX` at high zoom. Halved from `0.28` per Dylan's
 *  hands-on review (OpenProject #2900) -- the thicker halo was crowding the glyph strokes. */
const LABEL_HALO_WIDTH_RATIO = 0.14

/** How much of a node's inscribed text width a label may actually occupy. The chord
 *  `insideNodeTextWidth()` computes is the exact widest a font-height box could be inside the
 *  circle, which would put the first and last glyph flush against the edge -- this inset keeps a
 *  little of the node's own fill visible around the text instead. */
const LABEL_INSCRIBED_WIDTH_RATIO = 0.9

const LABEL_ELLIPSIS = '…'

/** The widest a line of `fontPx`-tall text can be and still sit inside a circle of `radius`,
 *  centered on it: the chord at +/- half the text's own height, `2 * sqrt(r^2 - (fontPx / 2)^2)`,
 *  inset by `LABEL_INSCRIBED_WIDTH_RATIO`. Exact circle geometry rather than a fraction-of-diameter
 *  approximation because it costs one `sqrt` and is what makes the "too small to label at all" case
 *  fall out for free: a node whose radius does not even exceed half the font height has no room for
 *  a text box of that height at any width, and this answers `0` for it rather than needing a
 *  separate floor constant to say so. */
function insideNodeTextWidth(radius, fontPx) {
  const halfHeight = fontPx / 2
  const halfChordSquared = radius * radius - halfHeight * halfHeight
  if (halfChordSquared <= 0) {
    return 0
  }
  return 2 * Math.sqrt(halfChordSquared) * LABEL_INSCRIBED_WIDTH_RATIO
}

/** Memo for `fitLabel()` (OpenProject #2593). `ctx.measureText` is the one genuinely expensive call
 *  in this layer, `drawLabels()` runs per node on every zoom/pan frame, and truncation measures
 *  several times per node -- so a dense graph would otherwise re-derive, dozens of times a second, a
 *  result that only changes when the title, the node's radius, the drawn font size, or -- since
 *  OpenProject #3364's bold selected-node title -- whether THIS fit is bold, does. `bold` is folded
 *  into the key for exactly that last reason: a bold face measures wider than the same text/fontPx in
 *  the regular weight, so the same node's fit can genuinely differ (a title that fit unselected may
 *  truncate one character shorter once bolded) and reusing a regular-weight entry for a bold pass (or
 *  vice versa, once the node is deselected again) would silently draw the wrong truncation. Keyed on
 *  exactly those four (the width floored to a whole px, so a continuously-varying zoom still hits),
 *  and cleared wholesale rather than evicted entry-by-entry once past `LABEL_CACHE_MAX`: this is a
 *  frame-rate cache, not a correctness one, so a cold rebuild costs one frame of measuring and
 *  nothing else. `resetLabelCache()` is exported for a caller that wants to drop it outright on a
 *  wholesale new graph, the same lifecycle `Graph.vue`'s `syntheticNodeCache` has. */
const LABEL_CACHE_MAX = 4096
const labelCache = new Map()

export function resetLabelCache() {
  labelCache.clear()
}

/** The largest prefix of `text` that fits `maxWidth` at the context's current font, with an ellipsis
 *  appended when anything was cut -- or `null` when the node cannot hold even one character plus
 *  that ellipsis, which is this layer's "draw no label at all" answer.
 *
 *  Deriving that cutoff from truncation rather than from a minimum-radius constant is deliberate:
 *  the radius floor lives in `Graph.vue` as a non-exported `<script setup>` local
 *  (`MIN_NODE_RADIUS`) and only the `radiusFor` FUNCTION crosses into this module, so a floor here
 *  would be a hand-copied duplicate that silently stops agreeing the moment that constant is
 *  retuned -- which it has been, more than once. "Does a character fit?" needs no such copy and
 *  stays correct by construction. */
function fitLabel(ctx, text, maxWidth, fontPx, bold = false) {
  if (!text || maxWidth <= 0) {
    return null
  }
  const key = `${bold ? 'b' : 'r'}|${Math.round(fontPx * 100)}|${Math.floor(maxWidth)}|${text}`
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

/** How much a real node's own drawn-radius growth (relative to `minRadius`, the floor every real
 *  node is lerped from -- `Graph.vue`'s `MIN_NODE_RADIUS`) carries over into its label's font size,
 *  at HALF the node's own relative growth rate (OpenProject #2993): a node at `minRadius` draws its
 *  label at the plain `LABEL_BASE_FONT_PX`, and a node at `5.5x` that floor (the real-graph
 *  `MAX_NODE_RADIUS`/`MIN_NODE_RADIUS` ratio as of this writing) draws its label at `3.25x` --
 *  `1 + 0.5 * (5.5 - 1)`. `Math.max(1, …)` floors `nodeGrowth` at `1` rather than letting it run
 *  negative-relative-scale below `minRadius`: no real node ever draws smaller than `minRadius`
 *  (`lerpRadius()` clamps to `[MIN_NODE_RADIUS, MAX_NODE_RADIUS]`), so this only matters for a caller
 *  that hands in an out-of-range radius directly (a test harness), and it is what makes THIS
 *  function's own floor answer exactly today's flat `LABEL_BASE_FONT_PX`, matching `drawLabels()`'s
 *  pre-#2993 behavior at `minRadius` and below rather than shrinking past it. */
function labelBaseFontFor(radius, minRadius) {
  const nodeGrowth = Math.max(1, radius / minRadius)
  const labelScale = 1 + 0.5 * (nodeGrowth - 1)
  return LABEL_BASE_FONT_PX * labelScale
}

/** Draws each node's title -- since OpenProject #2593 INSIDE the node's own circle, centered and
 *  truncated to fit, rather than unclipped to the right of its edge. The full, untruncated title is
 *  still reachable through `Graph.vue`'s existing DOM hover tooltip, unchanged; this layer
 *  deliberately introduces no second tooltip mechanism of its own.
 *
 *  A SYNTHETIC node keeps the original beside-the-node placement (`radius + LABEL_GAP`): it draws at
 *  a fixed radius of `3`, so it has no inside to draw in, and silently dropping the folder-hub
 *  basenames and the `(root)` marker from the static view would lose real structure -- the
 *  folder-hierarchy edge mode fans the whole graph out from exactly those nodes, and #2563 just gave
 *  the root its own ring to make it MORE identifiable, not less. Since a synthetic node's fixed `3`
 *  radius sits well outside the real-node `minRadius`/`MAX_NODE_RADIUS` range entirely and is not
 *  part of "Size by" at all, it is excluded from the radius-based font scaling below (OpenProject
 *  #2993) and keeps drawing at the plain, zoom-capped `LABEL_BASE_FONT_PX`.
 *
 *  A REAL node's own base font grows with its drawn radius -- see `labelBaseFontFor()` -- before the
 *  existing zoom cap (`LABEL_MAX_EFFECTIVE_FONT_PX / scale`) is applied on top, so `minRadius` (the
 *  same floor `radiusFor` lerps real nodes from -- `Graph.vue`'s `MIN_NODE_RADIUS`) is a required
 *  parameter here for exactly the reason `fitLabel()`'s own doc comment gives: that floor is a
 *  `Graph.vue`-local, retuned more than once, and only the value the caller actually hands in stays
 *  correct by construction rather than by a hand-copied duplicate silently drifting out of step.
 *
 *  `highlightedIds`/`dimmingIds` (OpenProject #2480, #3312's revert), same optional-`Set` contract as
 *  `drawNodes` above: a non-matching label dims along with its node rather than staying full-strength
 *  while its dot fades, which would read as two disagreeing signals for the same node.
 *
 *  `selectedId`/`selectedLabelColor` (OpenProject #3364, see `SELECTED_RING_GAP`'s doc comment above)
 *  bold the matching node's own title and recolor it with the resolved ink/text-dark token, mirroring
 *  the nav sidebar's own "current row" bold-title treatment -- same no-op-by-default contract as
 *  `drawNodes`'s selected ring: a falsy `selectedId`/`selectedLabelColor`, or no node matching it,
 *  draws every label exactly as before. Applied BEFORE `fitLabel()`'s own `ctx.measureText` calls for
 *  a real node, so truncation measures the actual (wider) bold glyphs it will draw, not the plain
 *  ones. */
export function drawLabels(
  ctx,
  nodes,
  radiusFor,
  scale,
  dark,
  highlightedIds,
  minRadius,
  dimmingIds = highlightedIds,
  selectedId = null,
  selectedLabelColor = null
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
    const isSelected = Boolean(selectedId && selectedLabelColor && nodeId(node) === selectedId)
    ctx.font = isSelected ? `bold ${fontPx}px sans-serif` : `${fontPx}px sans-serif`
    ctx.fillStyle = isSelected ? selectedLabelColor : fillColor
    ctx.lineWidth = fontPx * LABEL_HALO_WIDTH_RATIO
    let text = title
    let x = node.x
    if (node.synthetic) {
      ctx.textAlign = 'left'
      x = node.x + radius + LABEL_GAP
    } else {
      ctx.textAlign = 'center'
      text = fitLabel(ctx, title, insideNodeTextWidth(radius, fontPx), fontPx, isSelected)
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

/** Paints the current layout to the canvas -- the `ctx` save/clear/transform/draw/restore sequence
 *  only, no layout recomputation. Safe to call on every zoom/pan frame since it draws the `nodes`,
 *  `edges` and `clusters` it is handed as they last stood rather than rebuilding any of them.
 *
 *  `selectedId`/`selectedRingColor`/`selectedLabelColor` (OpenProject #3364) are optional and forward
 *  straight through to `drawNodes`/`drawLabels` -- see `SELECTED_RING_GAP`'s own doc comment above for
 *  why the two colors are resolved by the caller (`Graph.vue`) rather than owned here. */
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
  selectedRingColor = null,
  selectedLabelColor = null
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
  drawLabels(
    ctx,
    nodes,
    radiusFor,
    transform?.k ?? 1,
    dark,
    highlightedIds,
    minRadius,
    dimmingIds,
    selectedId,
    selectedLabelColor
  )
  ctx.restore()
}
