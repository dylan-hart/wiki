import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { convertDrawioFences } from './drawioFence.ts'

/** Escapes a string for embedding as an XML/HTML attribute value, the way draw.io does when it
 * writes its own diagram XML into an exported SVG's `content` attribute. */
function escAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Builds a base64 `\`\`\`diagram` fence body: a draw.io SVG export whose root `content` attribute
 * carries `innerXml`, escaped once — matching what a real draw.io export produces (the `<diagram>`
 * element's own text is separately entity-escaped by the caller, same as draw.io itself does). */
function drawioFenceBody(innerXml: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" content="${escAttr(innerXml)}">shape</svg>`
  return Buffer.from(svg, 'utf8').toString('base64')
}

const MXFILE_XML =
  '<mxfile host="embed.diagrams.net"><diagram id="abc" name="Page-1">' +
  '&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id="0"/&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;' +
  '</diagram></mxfile>'

const BARE_MODEL_XML = '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>'

describe('convertDrawioFences', () => {
  test('converts a ```diagram fence (mxfile shape) into a ::block-drawio-wrapped ```drawio block', () => {
    const content = `# Title\n\n\`\`\`diagram\n${drawioFenceBody(MXFILE_XML)}\n\`\`\`\n\nAfter.`
    const result = convertDrawioFences(content, 'page 12')
    assert.equal(result.converted, 1)
    assert.deepEqual(result.warnings, [])
    assert.equal(
      result.content,
      `# Title\n\n::block-drawio\n\`\`\`drawio\n${MXFILE_XML}\n\`\`\`\n::\n\nAfter.`
    )
  })

  test('converts a bare <mxGraphModel> export the same way', () => {
    const content = `\`\`\`diagram\n${drawioFenceBody(BARE_MODEL_XML)}\n\`\`\``
    const result = convertDrawioFences(content, 'page 12')
    assert.equal(result.converted, 1)
    assert.equal(result.content, `::block-drawio\n\`\`\`drawio\n${BARE_MODEL_XML}\n\`\`\`\n::`)
  })

  test('converts every fence in a page carrying more than one diagram', () => {
    const content =
      `\`\`\`diagram\n${drawioFenceBody(MXFILE_XML)}\n\`\`\`\n\n` +
      `\`\`\`diagram\n${drawioFenceBody(BARE_MODEL_XML)}\n\`\`\``
    const result = convertDrawioFences(content, 'page 12')
    assert.equal(result.converted, 2)
    assert.equal(result.warnings.length, 0)
    assert.ok(result.content.includes(`::block-drawio\n\`\`\`drawio\n${MXFILE_XML}\n\`\`\`\n::`))
    assert.ok(
      result.content.includes(`::block-drawio\n\`\`\`drawio\n${BARE_MODEL_XML}\n\`\`\`\n::`)
    )
  })

  test('leaves content with no ```diagram fence at all untouched', () => {
    const content = '# Plain page\n\nJust markdown, no diagrams.'
    const result = convertDrawioFences(content, 'page 12')
    assert.equal(result.converted, 0)
    assert.deepEqual(result.warnings, [])
    assert.equal(result.content, content)
  })

  test('leaves a fence untouched and warns when the body is not base64-decodable SVG at all', () => {
    const content = '```diagram\nthis is not base64 svg content\n```'
    const result = convertDrawioFences(content, 'page 12')
    assert.equal(result.converted, 0)
    assert.equal(result.content, content)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0]!, /page 12/)
    assert.match(result.warnings[0]!, /could not be converted/)
  })

  test('leaves a fence untouched and warns when the SVG has no content attribute', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg">shape, no drawio metadata</svg>'
    const body = Buffer.from(svg, 'utf8').toString('base64')
    const content = `\`\`\`diagram\n${body}\n\`\`\``
    const result = convertDrawioFences(content, 'page 12')
    assert.equal(result.converted, 0)
    assert.equal(result.content, content)
    assert.equal(result.warnings.length, 1)
  })

  test('leaves a fence untouched when the content attribute is not drawio XML', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" content="${escAttr('<not-drawio/>')}">x</svg>`
    const body = Buffer.from(svg, 'utf8').toString('base64')
    const content = `\`\`\`diagram\n${body}\n\`\`\``
    const result = convertDrawioFences(content, 'page 12')
    assert.equal(result.converted, 0)
    assert.equal(result.warnings.length, 1)
  })

  test('identifier appears in the warning, for a pageHistory-shaped identifier too', () => {
    const content = '```diagram\nnot-decodable\n```'
    const result = convertDrawioFences(content, 'pageHistory 99 (page 12)')
    assert.match(result.warnings[0]!, /pageHistory 99 \(page 12\)/)
  })
})
