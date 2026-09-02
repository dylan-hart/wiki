import { afterEach, describe, expect, it } from 'vitest'
import { deflateRaw } from 'pako'

import './component.js'
import { BlockDrawioElement } from './component.js'
import { BlockDiagramElement } from '../block-diagram/component.js'
import { BlockKrokiElement } from '../block-kroki/component.js'
import { BlockPlantumlElement } from '../block-plantuml/component.js'
import { drawioToSvg, extractModelXml, layout, parseCells, parseStyle } from './mxgraph.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/**
 * A diagram with two layers, a group, a swimlane, an `<object>`-wrapped cell, a floating edge and a
 * hidden layer — the shape upstream's bug report (requarks/wiki#6881) was about: a complex,
 * multi-layer diagram losing elements on render. Every visible cell below (11 of them: 9 vertices, 2
 * edges) must show up wrapped in its own `data-cell-id` group; the hidden layer's rectangle (id 30)
 * must not.
 */
const MULTI_LAYER_SOURCE = `<mxGraphModel>
  <root>
    <mxCell id="0" />
    <mxCell id="1" value="Layer 1" parent="0" />
    <mxCell id="2" value="Layer 2" parent="0" />
    <mxCell id="3" value="Hidden Layer" parent="0" visible="0" />

    <mxCell id="10" value="Start" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;" vertex="1" parent="1">
      <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />
    </mxCell>
    <mxCell id="11" value="Decision" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1">
      <mxGeometry x="220" y="30" width="120" height="80" as="geometry" />
    </mxCell>
    <mxCell id="12" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" source="10" target="11" parent="1">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>
    <mxCell id="13" style="group" vertex="1" connectable="0" parent="1">
      <mxGeometry x="400" y="40" width="160" height="100" as="geometry" />
    </mxCell>
    <mxCell id="14" value="A" style="ellipse;whiteSpace=wrap;html=1;" vertex="1" parent="13">
      <mxGeometry x="10" y="10" width="60" height="40" as="geometry" />
    </mxCell>
    <mxCell id="15" value="B" style="triangle;whiteSpace=wrap;html=1;" vertex="1" parent="13">
      <mxGeometry x="80" y="10" width="60" height="40" as="geometry" />
    </mxCell>
    <mxCell id="16" value="Pool" style="swimlane;startSize=20;" vertex="1" parent="1">
      <mxGeometry x="40" y="160" width="300" height="150" as="geometry" />
    </mxCell>
    <mxCell id="17" value="Step" style="hexagon;whiteSpace=wrap;html=1;" vertex="1" parent="16">
      <mxGeometry x="20" y="40" width="100" height="50" as="geometry" />
    </mxCell>

    <mxCell id="20" value="Note" style="text;html=1;align=left;" vertex="1" parent="2">
      <mxGeometry x="400" y="200" width="100" height="30" as="geometry" />
    </mxCell>
    <object id="21" label="Wrapped">
      <mxCell style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="2">
        <mxGeometry x="600" y="40" width="100" height="50" as="geometry" />
      </mxCell>
    </object>
    <mxCell id="22" style="html=1;" edge="1" source="20" target="21" parent="2">
      <mxGeometry relative="1" as="geometry">
        <Array as="points">
          <mxPoint x="500" y="215" />
        </Array>
      </mxGeometry>
    </mxCell>

    <mxCell id="30" value="Never shown" style="rounded=0;" vertex="1" parent="3">
      <mxGeometry x="700" y="700" width="80" height="40" as="geometry" />
    </mxCell>
  </root>
</mxGraphModel>`

/** draw.io's own compression, reproduced for the `<mxfile>` fixture below: see `mxgraph.js`'s `decompress`. */
function compress(xml) {
  const bytes = deflateRaw(new TextEncoder().encode(encodeURIComponent(xml)))
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

const mountDrawio = (body = '', props = {}) => mountBlock('block-drawio', { pre: body, props })

describe('static definition', () => {
  it("names the block for the format it draws, not a bare 'Diagram'", () => {
    expect(BlockDrawioElement.definition.name).toBe('draw.io Diagram')
  })

  it('is not confusable with its diagram-block siblings in the picker', () => {
    const names = [
      BlockDrawioElement.definition.name,
      BlockDiagramElement.definition.name,
      BlockKrokiElement.definition.name,
      BlockPlantumlElement.definition.name
    ]
    expect(new Set(names).size).toBe(names.length)
  })

  it('uses a distinct icon from its diagram-block siblings', () => {
    const icons = [
      BlockDrawioElement.definition.icon,
      BlockDiagramElement.definition.icon,
      BlockKrokiElement.definition.icon,
      BlockPlantumlElement.definition.icon
    ]
    expect(new Set(icons).size).toBe(icons.length)
  })
})

describe('block-drawio', () => {
  afterEach(resetBlockDom)

  it('draws a simple diagram into an inline svg with no error', async () => {
    const el = await mountDrawio(
      BlockDrawioElement.definition.template.replace(/```drawio\n|```$/g, '')
    )

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('svg')).not.toBeNull()
  })

  it('draws every visible cell of a multi-layer, multi-shape diagram, and none of a hidden layer', async () => {
    const el = await mountDrawio(MULTI_LAYER_SOURCE)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const groups = el.shadowRoot.querySelectorAll('svg [data-cell-id]')
    expect(groups.length).toBe(11)
    const ids = [...groups].map((g) => g.getAttribute('data-cell-id'))
    expect(ids).not.toContain('30')
    expect(ids).toContain('21') // -> the <object>-wrapped cell
    expect(el.shadowRoot.querySelector('ellipse')).not.toBeNull()
    expect(el.shadowRoot.querySelectorAll('polygon').length).toBeGreaterThan(0)
  })

  it('draws an <mxfile>-wrapped, compressed <diagram> the same as the raw model', async () => {
    const xml = BlockDrawioElement.definition.template.replace(/```drawio\n|```$/g, '')
    const wrapped = `<mxfile><diagram name="Page-1">${compress(xml)}</diagram></mxfile>`
    const el = await mountDrawio(wrapped)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('svg')).not.toBeNull()
  })

  it('shows an error, naming the fence, for a source markdown has already mangled', async () => {
    // -> `settle: 1`: `_error` is set synchronously inside `firstUpdated()`, but the resulting
    //    re-render is a second update cycle Lit schedules as a side effect — give it a turn before
    //    reading the DOM, the same way `block-diagram/component.test.js` does for its own no-fence
    //    case.
    const el = await mountBlock('block-drawio', { text: 'not xml at all <<<', settle: 1 })

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('fenced code block')
  })

  it('shows a clear error for well-formed XML that is not an mxGraphModel/mxfile', async () => {
    const el = await mountDrawio('<not-a-diagram/>')

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('mxGraphModel')
  })

  it('renders the caption and honours the align prop', async () => {
    const el = await mountDrawio(MULTI_LAYER_SOURCE, { caption: 'Order flow', align: 'center' })

    expect(el.shadowRoot.querySelector('.caption').textContent).toBe('Order flow')
    expect(el.shadowRoot.querySelector('.diagram').classList.contains('is-center')).toBe(true)
  })

  describeDarkMode(() => mountDrawio(MULTI_LAYER_SOURCE))
})

describe('mxgraph.js', () => {
  it('extracts a bare <mxGraphModel> unchanged', () => {
    const xml = '<mxGraphModel><root><mxCell id="0" /></root></mxGraphModel>'
    expect(extractModelXml(xml)).toBe(xml)
  })

  it('decompresses a compressed <mxfile><diagram> the same way draw.io compresses one', () => {
    const xml =
      '<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel>'
    const wrapped = `<mxfile><diagram>${compress(xml)}</diagram></mxfile>`
    expect(extractModelXml(wrapped)).toBe(xml)
  })

  it('rejects empty input with a message about the fence, not a stack trace', () => {
    expect(() => extractModelXml('   ')).toThrow('empty')
  })

  it('rejects a document that is neither mxGraphModel nor mxfile', () => {
    expect(() => extractModelXml('<svg></svg>')).toThrow('mxGraphModel')
  })

  it('parses a style string into its base shape and its key/value properties', () => {
    expect(parseStyle('rhombus;whiteSpace=wrap;html=1;fillColor=#fff;')).toEqual({
      shape: 'rhombus',
      props: { whiteSpace: 'wrap', html: '1', fillColor: '#fff' }
    })
    expect(parseStyle('shape=hexagon;html=1;')).toEqual({
      shape: 'hexagon',
      props: { shape: 'hexagon', html: '1' }
    })
  })

  it('unwraps an <object>-wrapped cell, taking its id and label from the wrapper', () => {
    const xml = `<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <object id="5" label="Custom"><mxCell style="rounded=0;" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="10" height="10" as="geometry" />
      </mxCell></object>
    </root></mxGraphModel>`
    const cells = parseCells(xml)
    expect(cells.get('5').label).toBe('Custom')
    expect(cells.get('5').vertex).toBe(true)
  })

  it('offsets a group child by the group’s own absolute position', () => {
    const cells = parseCells(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="g" style="group" vertex="1" parent="1">
        <mxGeometry x="100" y="50" width="80" height="80" as="geometry" />
      </mxCell>
      <mxCell id="c" style="ellipse" vertex="1" parent="g">
        <mxGeometry x="10" y="10" width="20" height="20" as="geometry" />
      </mxCell>
    </root></mxGraphModel>`)
    const { shapes } = layout(cells)
    const child = shapes.find((s) => s.cell.id === 'c')
    expect(child.box).toEqual({ x: 110, y: 60, width: 20, height: 20 })
  })

  it('resolves a floating edge (no source/target cell) from its explicit points', () => {
    const cells = parseCells(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="e" edge="1" parent="1">
        <mxGeometry relative="1" as="geometry">
          <mxPoint x="0" y="0" as="sourcePoint" />
          <mxPoint x="100" y="100" as="targetPoint" />
        </mxGeometry>
      </mxCell>
    </root></mxGraphModel>`)
    const { edges } = layout(cells)
    expect(edges).toHaveLength(1)
    expect(edges[0].start).toEqual({ x: 0, y: 0 })
    expect(edges[0].end).toEqual({ x: 100, y: 100 })
  })

  it('never drops a cell for having a style this renderer does not specifically know how to draw', () => {
    const { svg, cellCount } = drawioToSvg(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="x" value="AWS Lambda" style="shape=mxgraph.aws4.lambda;" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="60" height="60" as="geometry" />
      </mxCell>
    </root></mxGraphModel>`)
    expect(cellCount).toBe(1)
    expect(svg).toContain('data-cell-id="x"')
    // -> Fell back to the plain rectangle, not nothing
    expect(svg).toContain('<rect')
    expect(svg).toContain('AWS Lambda')
  })

  it('throws a friendly error for a diagram with nothing visible to draw', () => {
    expect(() =>
      drawioToSvg(
        '<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel>'
      )
    ).toThrow('nothing visible')
  })

  it('strips embedded markup out of an html=1 label instead of rendering it', () => {
    const { svg } = drawioToSvg(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="x" value="&lt;img src=x onerror=alert(1)&gt;" style="rounded=0;html=1;" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="60" height="30" as="geometry" />
      </mxCell>
    </root></mxGraphModel>`)
    expect(svg).not.toContain('<img')
    expect(svg).not.toContain('onerror')
  })

  /*
    OpenProject #2143 / #1360 (2026-08-24 security audit): `cylinder` and `swimlane` each draw a
    second, fill-less stroke and used to interpolate `strokeWidth` into that path/line's
    `stroke-width="…"` attribute unescaped, unlike the identical value in `paintAttrs()` three lines
    above it. A style value containing a `"` broke out of the attribute and planted a live event
    handler on the generated element, which `unsafeSVG()` (`component.js`) then parses as real markup
    in the block's shadow root — same-origin script execution for any author with `write:pages`, no
    `write:scripts` required. The fix routes both shapes through the shared, `Number()`-coercing
    `strokeAttrs()` helper `paintAttrs()` itself now uses, so an attribute-breaking value can never
    reach the output at all rather than merely being escaped.
  */
  it('neutralizes an attribute-breaking strokeWidth on cylinder and swimlane, the two shapes that draw a second stroke', () => {
    const malicious = `1" onmouseover="alert(1)`
    const { svg } = drawioToSvg(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="cyl" style="cylinder;strokeWidth=${malicious}" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="60" height="60" as="geometry" />
      </mxCell>
      <mxCell id="sl" value="Pool" style="swimlane;strokeWidth=${malicious}" vertex="1" parent="1">
        <mxGeometry x="0" y="80" width="60" height="60" as="geometry" />
      </mxCell>
    </root></mxGraphModel>`)
    expect(svg).not.toContain('onmouseover')
    expect(svg).not.toContain('alert(1)')
    // -> Not merely absent: the coerced value actually rendered in its place, so this is the fallback
    //    doing its job rather than the shape silently drawing no stroke at all.
    expect(svg).toContain('stroke-width="1"')
  })

  it('still renders a legitimate numeric strokeWidth on cylinder and swimlane', () => {
    const { svg } = drawioToSvg(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="cyl" style="cylinder;strokeWidth=4" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="60" height="60" as="geometry" />
      </mxCell>
      <mxCell id="sl" value="Pool" style="swimlane;strokeWidth=4" vertex="1" parent="1">
        <mxGeometry x="0" y="80" width="60" height="60" as="geometry" />
      </mxCell>
    </root></mxGraphModel>`)
    expect(svg).toContain('stroke-width="4"')
  })

  it('escapes ampersands and quotes in a plain-text label rather than interpolating them raw', () => {
    const { svg } = drawioToSvg(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="x" value="AT&amp;T &quot;Special&quot;" style="rounded=0;" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="60" height="30" as="geometry" />
      </mxCell>
    </root></mxGraphModel>`)
    expect(svg).toContain('AT&amp;T &quot;Special&quot;')
  })

  // -> A quote-breaking `strokeWidth` on a cylinder or swimlane cell used to escape into the
  //    generated SVG's markup unescaped, unlike every other stroke attribute `paintAttrs()` already
  //    covers. The style attribute below is XML-entity-encoded exactly as an author would write it in
  //    the block's `<mxCell style="…">`; the DOM parser decodes it into a raw `"` + `<image onerror>`
  //    string before `parseStyle()` ever sees it, which is the same shape the audit finding
  //    reproduced under jsdom.
  it('does not let a quote-breaking strokeWidth inject markup through the cylinder shape', () => {
    const { svg } = drawioToSvg(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="x" style="cylinder;strokeWidth=1&quot; /&gt;&lt;image href=&quot;x&quot; onerror=&quot;alert(1)&quot; /&gt;&lt;path d=&quot;" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="60" height="60" as="geometry" />
      </mxCell>
    </root></mxGraphModel>`)
    expect(svg).not.toContain('<image')
    expect(svg).not.toContain('onerror')
  })

  it('does not let a quote-breaking strokeWidth inject markup through the swimlane shape', () => {
    const { svg } = drawioToSvg(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="x" style="swimlane;strokeWidth=1&quot; /&gt;&lt;image href=&quot;x&quot; onerror=&quot;alert(1)&quot; /&gt;&lt;line a=&quot;" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="120" height="80" as="geometry" />
      </mxCell>
    </root></mxGraphModel>`)
    expect(svg).not.toContain('<image')
    expect(svg).not.toContain('onerror')
  })

  it('still renders a legitimate numeric strokeWidth on cylinder and swimlane shapes', () => {
    const { svg } = drawioToSvg(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="c" style="cylinder;strokeWidth=3;" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="60" height="60" as="geometry" />
      </mxCell>
      <mxCell id="s" style="swimlane;strokeWidth=3;" vertex="1" parent="1">
        <mxGeometry x="80" y="0" width="120" height="80" as="geometry" />
      </mxCell>
    </root></mxGraphModel>`)
    expect(svg.match(/stroke-width="3"/g)).toHaveLength(4)
  })

  // -> `Number(props.strokeWidth) || 1` treats a strokeWidth of `0` (a legitimate draw.io value
  //    meaning "no visible stroke") as falsy and silently overrides it to `1`, drawing a stroke the
  //    author explicitly asked to suppress. `strokeAttrs()` is shared by `paintAttrs()` (plain shapes)
  //    and the cylinder/swimlane second stroke, so both paths are covered here (OpenProject #2343).
  it('preserves an explicit strokeWidth of 0 instead of coercing it to 1', () => {
    const { svg } = drawioToSvg(`<mxGraphModel><root>
      <mxCell id="0" />
      <mxCell id="1" parent="0" />
      <mxCell id="r" style="rounded=0;strokeWidth=0" vertex="1" parent="1">
        <mxGeometry x="0" y="0" width="60" height="30" as="geometry" />
      </mxCell>
      <mxCell id="cyl" style="cylinder;strokeWidth=0" vertex="1" parent="1">
        <mxGeometry x="0" y="40" width="60" height="60" as="geometry" />
      </mxCell>
      <mxCell id="sl" value="Pool" style="swimlane;strokeWidth=0" vertex="1" parent="1">
        <mxGeometry x="80" y="0" width="120" height="80" as="geometry" />
      </mxCell>
    </root></mxGraphModel>`)
    // 1 from the rounded rectangle's single paintAttrs() stroke, plus 2 each from cylinder and
    // swimlane's main stroke + their second, fill-less stroke.
    expect(svg.match(/stroke-width="0"/g)).toHaveLength(5)
    expect(svg).not.toContain('stroke-width="1"')
  })
})
