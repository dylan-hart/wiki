import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  drawEdges,
  drawLabels,
  drawNodes,
  LABEL_GAP,
  paintGraph,
  resetLabelCache
} from './graphDraw.js'
import { computeHighlightedNodeIds } from './graphFilters.js'

/**
 * Real canvas pixel output isn't asserted anywhere in this suite (a project-wide limitation --
 * `Graph.rendering.test.js`'s own doc comment). These functions are plain, taking `ctx` as a
 * parameter rather than reaching for one, so a fake `ctx` recording which drawing calls happened
 * (and with what `fillStyle`/`strokeStyle`/`globalAlpha` at the time) is enough to verify both the
 * light/dark color choice (OpenProject #2412) and the highlight/dim logic (OpenProject #2480)
 * without a real canvas.
 */
function makeCtx() {
  const ctx = {
    strokeStyle: null,
    fillStyle: null,
    lineWidth: null,
    lineJoin: null,
    font: null,
    textAlign: null,
    textBaseline: null,
    globalAlpha: 1,
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    // -> Every character exactly `CHAR_WIDTH_PX` wide regardless of the font, so a suite can state
    //    "this title is 8 characters, this node holds 5" as arithmetic instead of depending on a
    //    real font's metrics. `drawLabels()`'s truncation (OpenProject #2593) is the only caller.
    measureText: vi.fn((text) => ({ width: String(text).length * CHAR_WIDTH_PX })),
    closePath: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn()
  }
  return ctx
}

const CHAR_WIDTH_PX = 4

describe('drawEdges', () => {
  const edges = [{ source: { x: 0, y: 0 }, target: { x: 10, y: 10 } }]

  it('strokes with the light-mode gray by default (falsy dark)', () => {
    const ctx = makeCtx()
    drawEdges(ctx, edges, false)
    expect(ctx.strokeStyle).toBe('rgba(128, 128, 128, 0.35)')
  })

  it('strokes with a lighter gray in dark mode', () => {
    const ctx = makeCtx()
    drawEdges(ctx, edges, true)
    expect(ctx.strokeStyle).toBe('rgba(200, 200, 200, 0.35)')
  })
})

const radiusFor = () => 5

describe('drawNodes (OpenProject #2480)', () => {
  it('with no highlightedIds, draws every node at full opacity and never strokes a ring', () => {
    const ctx = makeCtx()
    const nodes = [
      { path: 'a', locale: 'en', x: 1, y: 1 },
      { path: 'b', locale: 'en', x: 2, y: 2 }
    ]

    const fillAlphas = []
    ctx.fill.mockImplementation(() => fillAlphas.push(ctx.globalAlpha))

    drawNodes(ctx, nodes, radiusFor)

    expect(fillAlphas).toEqual([1, 1])
    expect(ctx.stroke).not.toHaveBeenCalled()
    expect(ctx.globalAlpha).toBe(1)
  })

  it('an empty highlightedIds Set behaves exactly like no highlightedIds at all', () => {
    const ctx = makeCtx()
    const nodes = [{ path: 'a', locale: 'en', x: 1, y: 1 }]

    const fillAlphas = []
    ctx.fill.mockImplementation(() => fillAlphas.push(ctx.globalAlpha))

    drawNodes(ctx, nodes, radiusFor, new Set())

    expect(fillAlphas).toEqual([1])
    expect(ctx.stroke).not.toHaveBeenCalled()
  })

  it('dims a non-matching node and draws a highlight ring on a matching one, once a highlight set is active', () => {
    const ctx = makeCtx()
    const nodes = [
      { path: 'match', locale: 'en', x: 1, y: 1 },
      { path: 'nomatch', locale: 'en', x: 2, y: 2 }
    ]

    const fillAlphas = []
    ctx.fill.mockImplementation(() => fillAlphas.push(ctx.globalAlpha))

    drawNodes(ctx, nodes, radiusFor, new Set(['en:match']))

    // -> One fill per node, in order: the match at full strength, the non-match dimmed.
    expect(fillAlphas).toEqual([1, expect.any(Number)])
    expect(fillAlphas[1]).toBeLessThan(1)
    expect(fillAlphas[1]).toBeGreaterThan(0)

    // -> Exactly one ring stroke -- the matching node only.
    expect(ctx.stroke).toHaveBeenCalledTimes(1)

    // -> Alpha is always reset to 1 once every node has been drawn, so a later, unrelated draw call
    //    (edges, hulls) sharing the same ctx never inherits a stale dimmed value.
    expect(ctx.globalAlpha).toBe(1)
  })

  it('still skips a node with no position, same as with no highlightedIds', () => {
    const ctx = makeCtx()
    const nodes = [{ path: 'pending', locale: 'en' }]

    drawNodes(ctx, nodes, radiusFor, new Set(['en:pending']))

    expect(ctx.arc).not.toHaveBeenCalled()
    expect(ctx.fill).not.toHaveBeenCalled()
  })

  it('dims a synthetic hub node like any other non-match -- its bare path can never equal a real locale:path id built by computeHighlightedNodeIds()', () => {
    const ctx = makeCtx()
    const nodes = [{ path: '__tag__foo', synthetic: true, x: 1, y: 1 }]
    const highlightedIds = computeHighlightedNodeIds([{ path: 'docs/intro', locale: 'en' }])

    const fillAlphas = []
    ctx.fill.mockImplementation(() => fillAlphas.push(ctx.globalAlpha))

    drawNodes(ctx, nodes, radiusFor, highlightedIds)

    expect(fillAlphas[0]).toBeLessThan(1)
    expect(ctx.stroke).not.toHaveBeenCalled()
  })
})

describe('drawNodes: root node marker (OpenProject #2563)', () => {
  it('strokes a distinct ring around a node.root node even with no highlightedIds at all', () => {
    const ctx = makeCtx()
    const nodes = [
      { path: '', locale: 'en', synthetic: true, root: true, x: 1, y: 1 },
      { path: 'docs', locale: 'en', synthetic: true, x: 2, y: 2 }
    ]

    drawNodes(ctx, nodes, radiusFor)

    // -> Exactly one ring stroke -- the root node only, not the plain synthetic folder node.
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
    expect(ctx.strokeStyle).toBe('#ff4081')
  })

  it('still strokes the root ring while a keyword search is active and the root is not the match, dimmed the same as its fill', () => {
    const ctx = makeCtx()
    const nodes = [{ path: '', locale: 'en', synthetic: true, root: true, x: 1, y: 1 }]

    const fillAlphas = []
    ctx.fill.mockImplementation(() => fillAlphas.push(ctx.globalAlpha))

    drawNodes(ctx, nodes, radiusFor, new Set(['en:some-other-page']))

    expect(fillAlphas[0]).toBeLessThan(1)
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
    expect(ctx.strokeStyle).toBe('#ff4081')
  })

  it('draws both rings, root and highlight, when the root node also matches the active keyword search', () => {
    const ctx = makeCtx()
    const nodes = [{ path: '', locale: 'en', synthetic: true, root: true, x: 1, y: 1 }]

    drawNodes(ctx, nodes, radiusFor, new Set(['en:']))

    expect(ctx.stroke).toHaveBeenCalledTimes(2)
    // -> Root ring strokes first (its own color), then the highlight ring overwrites strokeStyle
    //    with its own -- the last stroke call's color is what a final read of strokeStyle sees.
    expect(ctx.strokeStyle).toBe('#ffd600')
  })

  it('never rings a plain synthetic folder/tag-hub node that is not the root', () => {
    const ctx = makeCtx()
    const nodes = [
      { path: 'docs', locale: 'en', synthetic: true, x: 1, y: 1 },
      { path: '__tag__foo', synthetic: true, x: 2, y: 2 }
    ]

    drawNodes(ctx, nodes, radiusFor)

    expect(ctx.stroke).not.toHaveBeenCalled()
  })
})

describe('drawNodes: hovered-node tint', () => {
  it('fills a second time, with the white overlay tint, only for the node that is the hoveredNode', () => {
    const ctx = makeCtx()
    const hovered = { path: 'a', locale: 'en', x: 1, y: 1 }
    const other = { path: 'b', locale: 'en', x: 2, y: 2 }

    const fillStyles = []
    ctx.fill.mockImplementation(() => fillStyles.push(ctx.fillStyle))

    drawNodes(ctx, [hovered, other], radiusFor, null, hovered)

    // -> The hovered node fills twice (its own color, then the tint); the other node once.
    expect(fillStyles).toEqual(['#888', 'rgba(255, 255, 255, 0.3)', '#888'])
  })

  it('tints by object identity, not by matching id -- a same-id-shaped node that is not the actual hoveredNode reference gets no tint', () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 1, y: 1 }
    const lookalike = { path: 'a', locale: 'en', x: 1, y: 1 }

    drawNodes(ctx, [node], radiusFor, null, lookalike)

    expect(ctx.fill).toHaveBeenCalledTimes(1)
  })

  it('with no hoveredNode (null/undefined), never draws the tint fill', () => {
    const ctx = makeCtx()
    const nodes = [{ path: 'a', locale: 'en', x: 1, y: 1 }]

    drawNodes(ctx, nodes, radiusFor)

    expect(ctx.fill).toHaveBeenCalledTimes(1)
  })
})

/** A node big enough to hold a label inside it: at the `10px` base font, `insideNodeTextWidth(20,
 *  10)` is `2 * sqrt(400 - 25) * 0.9`, about `34.9px` -- eight `CHAR_WIDTH_PX` characters. */
const LABELLED_NODE_RADIUS = 20
const labelRadiusFor = () => LABELLED_NODE_RADIUS

/** The `minRadius` `drawLabels()` now requires (OpenProject #2993) -- stands in for `Graph.vue`'s own
 *  `MIN_NODE_RADIUS`. Deliberately equal to `LABELLED_NODE_RADIUS` above: a node drawn at exactly its
 *  own floor has `labelBaseFontFor()`'s `nodeGrowth` clamp at `1`, so it draws at the plain, unscaled
 *  `LABEL_BASE_FONT_PX` -- every pre-#2993 assertion in this file that assumed a flat `10px` base font
 *  stays correct unchanged once this is threaded through. */
const MIN_RADIUS = 20

describe('drawLabels', () => {
  const nodes = [{ x: 0, y: 0, title: 'Intro' }]
  const scale = 1

  beforeEach(resetLabelCache)

  it('fills with the original dark-gray in light mode', () => {
    const ctx = makeCtx()
    drawLabels(ctx, nodes, labelRadiusFor, scale, false, undefined, MIN_RADIUS)
    expect(ctx.fillStyle).toBe('#333')
  })

  it('fills with a near-white in dark mode', () => {
    const ctx = makeCtx()
    drawLabels(ctx, nodes, labelRadiusFor, scale, true, undefined, MIN_RADIUS)
    expect(ctx.fillStyle).toBe('#e8e8e8')
  })

  it('draws labels regardless of zoom scale -- there is no zoom-linked visibility cutoff any more (OpenProject #3027)', () => {
    // -> Every one of these used to be hidden outright: 0.5 and 0.59 sat below the old 0.6
    //    threshold, and 0.05 sits far below even the 0.6 -> 0.75 -> 1.1 values this constant was
    //    ever tuned to (OpenProject #2593, #2292, #1287/#1288). Now scale never suppresses the
    //    label layer -- only a node's own too-small-to-fit-any-text cutoff (`fitLabel()`) can.
    for (const testScale of [0.05, 0.5, 0.59, 0.6, 0.7]) {
      const ctx = makeCtx()
      drawLabels(ctx, nodes, labelRadiusFor, testScale, false, undefined, MIN_RADIUS)
      expect(ctx.fillText).toHaveBeenCalled()
    }
  })
})

/**
 * OpenProject #2593: the title moved from beside the node (`node.x + radius + LABEL_GAP`, unclipped
 * and untruncated) to inside its own circle, centered and cut to fit.
 *
 * What these can and cannot show: happy-dom's canvas is a call recorder, so "the halo stroked in the
 * surface color at the right width before the ink filled over it" is assertable, and "the resulting
 * text is legible on a mid-tone metric-colored fill" is NOT -- that judgement needs a human looking
 * at a real graph, the same caveat #2582's ring constants carry.
 */
describe('drawLabels inside the node (OpenProject #2593)', () => {
  const scale = 1

  beforeEach(resetLabelCache)

  it("centers a fitting title on the node's own position rather than offsetting it past the edge", () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 40, y: 25, title: 'Intro' }

    drawLabels(ctx, [node], labelRadiusFor, scale, false, undefined, MIN_RADIUS)

    expect(ctx.fillText).toHaveBeenCalledWith('Intro', 40, 25)
    expect(ctx.textAlign).toBe('center')
    expect(ctx.textBaseline).toBe('middle')
  })

  it('truncates a title too wide for the node and marks the cut with an ellipsis', () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 0, y: 0, title: 'An extremely long page title' }

    drawLabels(ctx, [node], labelRadiusFor, scale, false, undefined, MIN_RADIUS)

    const [text] = ctx.fillText.mock.calls[0]
    expect(text).not.toBe(node.title)
    expect(text.endsWith('…')).toBe(true)
    expect(node.title.startsWith(text.slice(0, -1))).toBe(true)
    // -> Fits the node, and is the LARGEST prefix that does: one more character would not.
    const maxWidth = 2 * Math.sqrt(LABELLED_NODE_RADIUS ** 2 - 25) * 0.9
    expect(text.length * CHAR_WIDTH_PX).toBeLessThanOrEqual(maxWidth)
    expect((text.length + 1) * CHAR_WIDTH_PX).toBeGreaterThan(maxWidth)
  })

  it('leaves a title that already fits untouched, with no ellipsis', () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 0, y: 0, title: 'Short' }

    drawLabels(ctx, [node], labelRadiusFor, scale, false, undefined, MIN_RADIUS)

    expect(ctx.fillText).toHaveBeenCalledWith('Short', 0, 0)
  })

  it('draws no label at all on a node too small for even one character plus the ellipsis', () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 0, y: 0, title: 'Intro' }

    // -> A radius below half the 10px font height leaves no text box of that height any width at
    //    all, so the cutoff falls out of the geometry rather than out of a copied radius constant.
    drawLabels(ctx, [node], () => 4, scale, false, undefined, MIN_RADIUS)

    expect(ctx.fillText).not.toHaveBeenCalled()
    expect(ctx.strokeText).not.toHaveBeenCalled()
  })

  it("keeps a synthetic node's label beside it, where its fixed 3px radius can never hold text", () => {
    const ctx = makeCtx()
    const node = { path: 'docs', locale: 'en', synthetic: true, x: 10, y: 20, title: 'docs' }

    drawLabels(ctx, [node], () => 3, scale, false)

    expect(ctx.fillText).toHaveBeenCalledWith('docs', 10 + 3 + LABEL_GAP, 20)
    expect(ctx.textAlign).toBe('left')
  })

  it('falls back to the path when a node carries no title, inside the node like any other', () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 5, y: 6 }

    drawLabels(ctx, [node], labelRadiusFor, scale, false, undefined, MIN_RADIUS)

    expect(ctx.fillText).toHaveBeenCalledWith('a', 5, 6)
  })

  it('strokes a light halo behind the ink in light mode, before filling, at a font-scaled width', () => {
    const ctx = makeCtx()
    const order = []
    ctx.strokeText.mockImplementation(() => order.push(['stroke', ctx.strokeStyle, ctx.lineWidth]))
    ctx.fillText.mockImplementation(() => order.push(['fill', ctx.fillStyle]))

    drawLabels(
      ctx,
      [{ path: 'a', locale: 'en', x: 0, y: 0, title: 'Intro' }],
      labelRadiusFor,
      scale,
      false,
      undefined,
      MIN_RADIUS
    )

    expect(order).toEqual([
      ['stroke', '#ffffff', 10 * 0.14],
      ['fill', '#333']
    ])
  })

  it('strokes a dark halo behind the near-white ink in dark mode', () => {
    const ctx = makeCtx()
    const order = []
    ctx.strokeText.mockImplementation(() => order.push(['stroke', ctx.strokeStyle]))
    ctx.fillText.mockImplementation(() => order.push(['fill', ctx.fillStyle]))

    drawLabels(
      ctx,
      [{ path: 'a', locale: 'en', x: 0, y: 0, title: 'Intro' }],
      labelRadiusFor,
      scale,
      true,
      undefined,
      MIN_RADIUS
    )

    expect(order).toEqual([
      ['stroke', '#101010'],
      ['fill', '#e8e8e8']
    ])
  })

  it('halos a flat-gray synthetic node the same way it halos a metric-colored real one', () => {
    const ctx = makeCtx()
    const nodes = [
      { path: 'a', locale: 'en', x: 0, y: 0, title: 'Real', color: '#1976d2' },
      { path: 'docs', locale: 'en', synthetic: true, x: 50, y: 0, title: 'docs', color: '#9e9e9e' }
    ]

    drawLabels(
      ctx,
      nodes,
      (node) => (node.synthetic ? 3 : LABELLED_NODE_RADIUS),
      scale,
      false,
      undefined,
      MIN_RADIUS
    )

    // -> Both halo, both fill: the mechanism is deliberately blind to the fill underneath, which is
    //    the whole reason it is a halo rather than a per-node contrast-switched ink.
    expect(ctx.strokeText).toHaveBeenCalledTimes(2)
    expect(ctx.fillText).toHaveBeenCalledTimes(2)
  })

  it('measures once per distinct (title, radius, font) rather than on every repaint', () => {
    const ctx = makeCtx()
    const nodes = [{ path: 'a', locale: 'en', x: 0, y: 0, title: 'An extremely long page title' }]

    drawLabels(ctx, nodes, labelRadiusFor, scale, false, undefined, MIN_RADIUS)
    const firstPass = ctx.measureText.mock.calls.length
    expect(firstPass).toBeGreaterThan(1)

    ctx.measureText.mockClear()
    drawLabels(ctx, nodes, labelRadiusFor, scale, false, undefined, MIN_RADIUS)
    drawLabels(ctx, nodes, labelRadiusFor, scale, false, undefined, MIN_RADIUS)
    expect(ctx.measureText).not.toHaveBeenCalled()

    // -> A different drawn font size is a different answer, so it must measure again.
    ctx.measureText.mockClear()
    drawLabels(ctx, nodes, labelRadiusFor, 8, false, undefined, MIN_RADIUS)
    expect(ctx.measureText).toHaveBeenCalled()
  })

  it('resetLabelCache() drops the memo, so a wholesale new graph re-measures', () => {
    const ctx = makeCtx()
    const nodes = [{ path: 'a', locale: 'en', x: 0, y: 0, title: 'An extremely long page title' }]

    drawLabels(ctx, nodes, labelRadiusFor, scale, false, undefined, MIN_RADIUS)
    resetLabelCache()
    ctx.measureText.mockClear()
    drawLabels(ctx, nodes, labelRadiusFor, scale, false, undefined, MIN_RADIUS)

    expect(ctx.measureText).toHaveBeenCalled()
  })
})

/**
 * OpenProject #2993: a real node's own base font now scales up with its drawn radius, at half the
 * node's own relative growth rate over `minRadius` -- so a real graph's smallest and largest ranked
 * nodes (drawn at `MIN_NODE_RADIUS`/`MAX_NODE_RADIUS`, `Graph.vue`) label at `10px`/`32.5px`
 * respectively. `ctx.font` is asserted directly rather than through `fitLabel()`'s truncation output,
 * since that is the one property this formula actually decides.
 */
describe('drawLabels: font scales with node radius (OpenProject #2993)', () => {
  const scale = 1

  beforeEach(resetLabelCache)

  it('draws a node at exactly minRadius with the plain, unscaled base font', () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 0, y: 0, title: 'Intro' }

    drawLabels(ctx, [node], () => MIN_RADIUS, scale, false, undefined, MIN_RADIUS)

    expect(ctx.font).toBe('10px sans-serif')
  })

  it('scales the base font up at half the node’s own relative growth rate over minRadius', () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 0, y: 0, title: 'Intro' }

    // -> 2x growth over minRadius (nodeGrowth) -> labelScale 1 + 0.5 * (2 - 1) = 1.5 -> 15px base,
    //    well under the LABEL_MAX_EFFECTIVE_FONT_PX zoom cap at this scale.
    drawLabels(ctx, [node], () => MIN_RADIUS * 2, scale, false, undefined, MIN_RADIUS)

    expect(ctx.font).toBe('15px sans-serif')
  })

  it('reaches 3.25x the base font at a 5.5x radius growth -- half the node’s own 5.5x growth, the real MAX_NODE_RADIUS/MIN_NODE_RADIUS ratio', () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 0, y: 0, title: 'Intro' }

    // -> A slightly-zoomed-out scale keeps LABEL_MAX_EFFECTIVE_FONT_PX's cap (32px at scale 1) from
    //    masking the uncapped 32.5px this test is actually about.
    drawLabels(ctx, [node], () => MIN_RADIUS * 5.5, 0.9, false, undefined, MIN_RADIUS)

    expect(ctx.font).toBe('32.5px sans-serif')
  })

  it('still applies the existing zoom cap on top of a radius-scaled font', () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 0, y: 0, title: 'Intro' }

    // -> At scale 1 the zoom cap is LABEL_MAX_EFFECTIVE_FONT_PX itself (32px), below the 32.5px this
    //    node's radius would otherwise scale its base font to.
    drawLabels(ctx, [node], () => MIN_RADIUS * 5.5, 1, false, undefined, MIN_RADIUS)

    expect(ctx.font).toBe('32px sans-serif')
  })

  it('a real node at or below minRadius still draws at the plain base font (defensive floor -- radiusFor never actually returns below minRadius in production)', () => {
    const ctx = makeCtx()
    const node = { path: 'a', locale: 'en', x: 0, y: 0, title: 'Intro' }

    drawLabels(ctx, [node], () => MIN_RADIUS / 2, scale, false, undefined, MIN_RADIUS)

    expect(ctx.font).toBe('10px sans-serif')
  })

  it('never scales a synthetic node’s label past the plain base font, regardless of minRadius', () => {
    const ctx = makeCtx()
    const node = { path: 'docs', locale: 'en', synthetic: true, x: 0, y: 0, title: 'docs' }

    drawLabels(ctx, [node], () => 3, scale, false, undefined, MIN_RADIUS)

    expect(ctx.font).toBe('10px sans-serif')
  })
})

describe('drawLabels (OpenProject #2480)', () => {
  const scale = 1

  it('dims a non-matching label along with its node, at the same threshold', () => {
    const ctx = makeCtx()
    const nodes = [
      { path: 'match', locale: 'en', x: 1, y: 1, title: 'Match' },
      { path: 'nomatch', locale: 'en', x: 2, y: 2, title: 'No match' }
    ]

    const textAlphas = []
    ctx.fillText.mockImplementation(() => textAlphas.push(ctx.globalAlpha))

    drawLabels(ctx, nodes, labelRadiusFor, scale, false, new Set(['en:match']), MIN_RADIUS)

    expect(textAlphas[0]).toBe(1)
    expect(textAlphas[1]).toBeLessThan(1)
    expect(ctx.globalAlpha).toBe(1)
  })

  it('with no highlightedIds, every label draws at full opacity', () => {
    const ctx = makeCtx()
    const nodes = [{ path: 'a', locale: 'en', x: 1, y: 1, title: 'A' }]

    const textAlphas = []
    ctx.fillText.mockImplementation(() => textAlphas.push(ctx.globalAlpha))

    drawLabels(ctx, nodes, labelRadiusFor, scale, false, undefined, MIN_RADIUS)

    expect(textAlphas).toEqual([1])
  })
})

describe('paintGraph', () => {
  it('forwards its dark flag into both drawEdges and drawLabels', () => {
    const ctx = makeCtx()
    const canvas = { width: 100, height: 100 }
    // -> The edge layer's own color has to be read AT ITS STROKE, not off `ctx` afterwards: since
    //    OpenProject #2593 the label layer sets `strokeStyle` too (its halo), so a trailing read
    //    would see the last writer rather than the layer this is about.
    const edgeStrokeStyles = []
    ctx.stroke.mockImplementation(() => edgeStrokeStyles.push(ctx.strokeStyle))
    paintGraph({
      ctx,
      canvas,
      transform: null,
      nodes: [{ x: 1, y: 1, title: 'A' }],
      edges: [{ source: { x: 0, y: 0 }, target: { x: 5, y: 5 } }],
      clusters: [],
      radiusFor: () => 5,
      minRadius: MIN_RADIUS,
      dark: true
    })
    // -> Edge layer ran with dark's stroke color, label layer with dark's fill color -- proof the
    //    one `dark` flag paintGraph() takes actually reaches both layers, not just one of them.
    expect(edgeStrokeStyles).toEqual(['rgba(200, 200, 200, 0.35)'])
    expect(ctx.fillStyle).toBe('#e8e8e8')
  })

  it('does nothing when handed no ctx (canvas not yet mounted)', () => {
    expect(() => paintGraph({ ctx: null, canvas: null, dark: true })).not.toThrow()
  })
})

describe('paintGraph (OpenProject #2480)', () => {
  it('forwards highlightedIds through to drawNodes/drawLabels with no error', () => {
    const ctx = makeCtx()
    const canvas = { width: 100, height: 100 }
    const nodes = [{ path: 'a', locale: 'en', x: 1, y: 1, title: 'A' }]

    expect(() =>
      paintGraph({
        ctx,
        canvas,
        transform: null,
        nodes,
        edges: [],
        clusters: [],
        radiusFor,
        minRadius: MIN_RADIUS,
        highlightedIds: new Set(['en:a'])
      })
    ).not.toThrow()

    expect(ctx.stroke).toHaveBeenCalledTimes(1)
  })

  it('omitting highlightedIds entirely draws exactly as before this WP', () => {
    const ctx = makeCtx()
    const canvas = { width: 100, height: 100 }
    const nodes = [{ path: 'a', locale: 'en', x: 1, y: 1, title: 'A' }]

    paintGraph({
      ctx,
      canvas,
      transform: null,
      nodes,
      edges: [],
      clusters: [],
      radiusFor,
      minRadius: MIN_RADIUS
    })

    expect(ctx.stroke).not.toHaveBeenCalled()
  })
})
