import { describe, expect, it, vi } from 'vitest'

import { drawEdges, drawLabels, paintGraph } from './graphDraw.js'

/**
 * OpenProject #2412: `drawEdges()`/`drawLabels()` used to hardcode a single light-surface stroke/
 * fill string with no dark-mode variant, which is exactly why they read illegibly against the
 * app's dark canvas surface. Pixel-level assertions aren't practical for a canvas (same limitation
 * `Graph.rendering.test.js` documents) -- these assert on the `ctx.strokeStyle`/`ctx.fillStyle`
 * string actually set for each mode instead.
 */
function makeCtx() {
  return {
    strokeStyle: null,
    fillStyle: null,
    lineWidth: null,
    font: null,
    globalAlpha: 1,
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    closePath: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn()
  }
}

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

describe('drawLabels', () => {
  const nodes = [{ x: 0, y: 0, title: 'Intro' }]
  const radiusFor = () => 5
  // -> Above LABEL_VISIBILITY_ZOOM_THRESHOLD (0.75) so the label layer actually draws.
  const scale = 1

  it('fills with the original dark-gray in light mode', () => {
    const ctx = makeCtx()
    drawLabels(ctx, nodes, radiusFor, scale, false)
    expect(ctx.fillStyle).toBe('#333')
  })

  it('fills with a near-white in dark mode', () => {
    const ctx = makeCtx()
    drawLabels(ctx, nodes, radiusFor, scale, true)
    expect(ctx.fillStyle).toBe('#e8e8e8')
  })

  it('still skips drawing below the zoom threshold regardless of mode', () => {
    const ctx = makeCtx()
    drawLabels(ctx, nodes, radiusFor, 0.5, true)
    expect(ctx.fillText).not.toHaveBeenCalled()
  })
})

describe('paintGraph', () => {
  it('forwards its dark flag into both drawEdges and drawLabels', () => {
    const ctx = makeCtx()
    const canvas = { width: 100, height: 100 }
    paintGraph({
      ctx,
      canvas,
      transform: null,
      nodes: [{ x: 1, y: 1, title: 'A' }],
      edges: [],
      clusters: [],
      radiusFor: () => 5,
      dark: true
    })
    // -> Edge layer ran with dark's stroke color, label layer with dark's fill color -- proof the
    //    one `dark` flag paintGraph() takes actually reaches both layers, not just one of them.
    expect(ctx.strokeStyle).toBe('rgba(200, 200, 200, 0.35)')
    expect(ctx.fillStyle).toBe('#e8e8e8')
  })

  it('does nothing when handed no ctx (canvas not yet mounted)', () => {
    expect(() => paintGraph({ ctx: null, canvas: null, dark: true })).not.toThrow()
  })
})
