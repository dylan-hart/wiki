import { afterEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { BlockDiagramElement } from './component.js'
import { BlockKrokiElement } from '../block-kroki/component.js'
import { BlockPlantumlElement } from '../block-plantuml/component.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/*
  jsdom implements no SVG layout at all -- `getBBox`, `getComputedTextLength` and the rest of
  `SVGGraphicsElement` don't exist -- and mermaid's own layout engine calls them to measure label
  text while it draws. Real browsers, and `vitest.config.js`'s documented `@web/test-runner`
  fallback, have them; jsdom does not, so mermaid throws partway through `render()` without this. A
  targeted polyfill of the two calls this diagram's layout reaches for, not a different DOM emulator
  wholesale -- constant-size measurements are fine here, since the assertions below are about
  whether a diagram redraws, not about the pixels it comes out at.
*/
if (typeof SVGElement.prototype.getBBox !== 'function') {
  SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 })
}
if (typeof SVGElement.prototype.getComputedTextLength !== 'function') {
  SVGElement.prototype.getComputedTextLength = () => 60
}

/**
 * Appends a `<block-diagram>` carrying `body` inside a `<pre>` child, the way the wiki's own markdown
 * renderer leaves a fenced ```mermaid block, and waits both for Lit's first render and for the
 * component's own async `_draw()` (mermaid's `render()` is a promise) to settle.
 */
// -> `settle: 1`: `_draw()` isn't awaited by `firstUpdated`, so give its promise a turn to resolve
const mountDiagram = (body = '', props = {}) =>
  mountBlock('block-diagram', { pre: body, props, settle: 1 })

const VALID_SOURCE = 'flowchart LR\n  A[Start] --> B{Ready?}'

/**
 * The block picker's catalog (`BlockPickerOverlay.vue`) lists this block next to `block-kroki` and
 * `block-plantuml` with nothing but `name`, `description` and `icon` to tell someone who does not
 * already know which engine they want apart. "Diagram" as a *name* reads as a generic catch-all
 * sitting beside two engine-specific ones — Mermaid drawing exactly one family of diagram syntax is
 * no more "the" diagram block than Kroki (dozens of engines) or PlantUML is — even though the
 * description already says "Mermaid". Naming it after its engine, the same way its two neighbours
 * are named after theirs, is what actually removes the ambiguity for a first-time reader.
 */
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
    // -> Every name distinct, and none of them a bare, generic "Diagram"
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
     * `blocks/test/darkMode.js`'s `describeDarkMode` is the template for the mechanics (the
     * `DarkMode` controller reacts through a `MutationObserver` callback, a microtask away). What is
     * specific to this block is the assertion: unlike every other block, dark mode is not just a CSS
     * attribute here — mermaid bakes its colours into the SVG it draws, so a theme of `auto` has to
     * trigger a real second `_draw()` for the diagram to actually repaint, which is exactly what
     * `onChange` on the controller is wired to do (see the constructor comment in component.js).
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
