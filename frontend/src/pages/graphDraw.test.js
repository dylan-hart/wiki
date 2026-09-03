import { describe, expect, it, vi } from 'vitest'
import { drawLabels, drawNodes, paintGraph } from './graphDraw.js'
import { computeHighlightedNodeIds } from './graphFilters.js'

/**
 * Real canvas pixel output isn't asserted anywhere in this suite (a project-wide limitation --
 * `Graph.rendering.test.js`'s own doc comment). These functions are plain, taking `ctx` as a
 * parameter rather than reaching for one, so a fake `ctx` recording which drawing calls happened
 * (and with what `fillStyle`/`strokeStyle`/`globalAlpha` at the time) is enough to verify the
 * highlight/dim logic (OpenProject #2480) without a real canvas.
 */
function makeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    fillStyle: null,
    strokeStyle: null,
    lineWidth: null,
    font: null,
    globalAlpha: 1
  }
}

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

    drawLabels(ctx, nodes, radiusFor, scale, new Set(['en:match']))

    expect(textAlphas[0]).toBe(1)
    expect(textAlphas[1]).toBeLessThan(1)
    expect(ctx.globalAlpha).toBe(1)
  })

  it('with no highlightedIds, every label draws at full opacity', () => {
    const ctx = makeCtx()
    const nodes = [{ path: 'a', locale: 'en', x: 1, y: 1, title: 'A' }]

    const textAlphas = []
    ctx.fillText.mockImplementation(() => textAlphas.push(ctx.globalAlpha))

    drawLabels(ctx, nodes, radiusFor, scale)

    expect(textAlphas).toEqual([1])
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
        highlightedIds: new Set(['en:a'])
      })
    ).not.toThrow()

    expect(ctx.stroke).toHaveBeenCalledTimes(1)
  })

  it('omitting highlightedIds entirely draws exactly as before this WP', () => {
    const ctx = makeCtx()
    const canvas = { width: 100, height: 100 }
    const nodes = [{ path: 'a', locale: 'en', x: 1, y: 1, title: 'A' }]

    paintGraph({ ctx, canvas, transform: null, nodes, edges: [], clusters: [], radiusFor })

    expect(ctx.stroke).not.toHaveBeenCalled()
  })
})
