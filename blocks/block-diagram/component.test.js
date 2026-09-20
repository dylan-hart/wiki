import { afterEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { BlockDiagramElement } from './component.js'
import { BlockKrokiElement } from '../block-kroki/component.js'
import { BlockPlantumlElement } from '../block-plantuml/component.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/*
  jsdom implements no SVG layout, and mermaid measures label text while it draws, so `render()`
  throws partway through without these. Constant sizes are enough: the assertions are about whether
  a diagram redraws, not about the pixels it comes out at.
*/
if (typeof SVGElement.prototype.getBBox !== 'function') {
  SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 })
}
if (typeof SVGElement.prototype.getComputedTextLength !== 'function') {
  SVGElement.prototype.getComputedTextLength = () => 60
}

// -> `settle: 1`: `_draw()` isn't awaited by `firstUpdated`, so give its promise a turn to resolve
const mountDiagram = (body = '', props = {}) =>
  mountBlock('block-diagram', { pre: body, props, settle: 1 })

const VALID_SOURCE = 'flowchart LR\n  A[Start] --> B{Ready?}'

describe('static definition', () => {
  it("names the block after the engine it draws, not the generic word 'Diagram'", () => {
    expect(BlockDiagramElement.definition.name).toBe('Mermaid')
  })

  it('is not confusable with its two sibling diagram blocks in the picker', () => {
    const names = [
      BlockDiagramElement.definition.name,
      BlockKrokiElement.definition.name,
      BlockPlantumlElement.definition.name
    ]
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toContain('Diagram')
  })

  it('uses a distinct icon from its two sibling diagram blocks', () => {
    const icons = [
      BlockDiagramElement.definition.icon,
      BlockKrokiElement.definition.icon,
      BlockPlantumlElement.definition.icon
    ]
    expect(new Set(icons).size).toBe(icons.length)
  })

  it("names Mermaid by name in its own description too, matching Kroki's and PlantUML's pattern of naming their own engine", () => {
    expect(BlockDiagramElement.definition.description).toContain('Mermaid')
  })
})

describe('block-diagram', () => {
  afterEach(resetBlockDom)

  it('draws the fenced mermaid source into an inline svg', async () => {
    const el = await mountDiagram(VALID_SOURCE)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('svg')).not.toBeNull()
  })

  it('shows an error, naming the fence, for a source markdown has already mangled', async () => {
    // -> No `<pre>` around it: the same shape an un-fenced body would leave behind
    const el = await mountBlock('block-diagram', { text: 'not a diagram', settle: 1 })

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('fenced code block')
  })

  describe('dark mode', () => {
    /*
     * Mermaid bakes its colours into the SVG, so `auto` needs a real second `_draw()` to repaint
     * rather than the CSS attribute flip every other block's dark mode is.
     */
    it('redraws when the app theme toggles and the diagram theme is auto', async () => {
      document.body.classList.remove('body--dark')
      const el = await mountDiagram(VALID_SOURCE, { theme: 'auto' })
      const drawSpy = vi.spyOn(el, '_draw')

      document.body.classList.add('body--dark')
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete
      await new Promise((resolve) => setTimeout(resolve, 0))
      await el.updateComplete

      expect(drawSpy).toHaveBeenCalled()
      expect(el.hasAttribute('dark')).toBe(true)
      expect(el.shadowRoot.querySelector('svg')).not.toBeNull()
    })

    it('does not redraw on a theme toggle when a named theme was requested', async () => {
      document.body.classList.remove('body--dark')
      const el = await mountDiagram(VALID_SOURCE, { theme: 'forest' })
      const drawSpy = vi.spyOn(el, '_draw')

      document.body.classList.add('body--dark')
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete

      // -> The `dark` attribute still follows the app, since the caption colour keys off it too
      expect(el.hasAttribute('dark')).toBe(true)
      expect(drawSpy).not.toHaveBeenCalled()
    })
  })
})
