import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import sanitizeHtml from 'sanitize-html'
import { blockAllowances, sanitizeOptions } from './htmlSanitizePolicy.ts'
import { sanitizeSvg } from './images.ts'
import { installTestWiki } from '../test/mocks.ts'
import type { RenderPermissions } from './htmlSanitizePolicy.ts'

const wiki = installTestWiki({
  models: {
    blocks: {
      definitions: [
        {
          block: 'whiteboard',
          props: [{ name: 'caption' }, { name: 'drawingKey' }, { name: 'src' }]
        }
      ]
    }
  }
})
after(() => wiki.restore())

function sanitize(
  html: string,
  permissions: Partial<RenderPermissions> = {},
  enabled: string[] = ['whiteboard']
): string {
  return sanitizeHtml(
    html,
    sanitizeOptions(permissions as RenderPermissions, blockAllowances(new Set(enabled), []))
  )
}

const DRAWING_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" class="wb" data-board="1">' +
  '<g transform="translate(1,2)" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" vector-effect="non-scaling-stroke" pointer-events="none">' +
  '<path d="M0 0 L10 10" style="stroke:red;pointer-events:none"/>' +
  '</g>' +
  '<text x="1" y="2" font-family="serif" font-size="12" font-weight="bold">note</text>' +
  '<image href="data:image/png;base64,AAAA" x="0" y="0" width="1" height="1"/>' +
  '<foreignObject><div>x</div></foreignObject>' +
  '<style>path{fill:red}</style>' +
  '<animate attributeName="x"/>' +
  '<use href="#a"/>' +
  '<use href="https://evil.example/x.svg#a"/>' +
  '<a href="javascript:alert(1)"><circle r="1" onclick="alert(1)"/></a>' +
  '<script>alert(1)</script>' +
  '</svg>'

describe('sanitizeOptions -- a drawing stored as inline SVG in page HTML', () => {
  test('keeps the shapes, viewBox, stroke presentation attributes, transform and data-*', () => {
    const out = sanitize(DRAWING_SVG)
    assert.match(out, /<svg [^>]*viewBox="0 0 100 100"/)
    assert.match(out, /class="wb"/)
    assert.match(out, /data-board="1"/)
    assert.match(out, /<g transform="translate\(1,2\)" stroke="#000" stroke-width="2"/)
    assert.match(out, /stroke-linecap="round" stroke-linejoin="round" fill="none"/)
    assert.match(out, /<path d="M0 0 L10 10">/)
    assert.match(out, /<text x="1" y="2" font-family="serif" font-size="12">note<\/text>/)
  })

  test('drops vector-effect, pointer-events and font-weight, which a drawing tool would emit', () => {
    const out = sanitize(DRAWING_SVG)
    assert.doesNotMatch(out, /vector-effect/)
    assert.doesNotMatch(out, /pointer-events/)
    assert.doesNotMatch(out, /font-weight/)
  })

  test('drops an embedded raster <image>, so a hybrid drawing loses its background', () => {
    const out = sanitize(DRAWING_SVG)
    assert.doesNotMatch(out, /<image/)
    assert.doesNotMatch(out, /data:image\/png/)
  })

  test('filters the style attribute to the allowlisted declarations without write:styles', () => {
    const out = sanitize(DRAWING_SVG)
    assert.doesNotMatch(out, /style=/)
    assert.doesNotMatch(out, /<style/)
  })

  test('keeps the style attribute whole with write:styles', () => {
    const out = sanitize(DRAWING_SVG, { styles: true })
    assert.match(out, /style="stroke:red;pointer-events:none"/)
  })

  test('removes foreignObject, animate, script, the event handler and the javascript: href', () => {
    const out = sanitize(DRAWING_SVG)
    assert.doesNotMatch(out, /foreignObject/i)
    assert.doesNotMatch(out, /<animate/)
    assert.doesNotMatch(out, /<script/)
    assert.doesNotMatch(out, /alert/)
    assert.doesNotMatch(out, /onclick/)
    assert.doesNotMatch(out, /javascript:/)
  })

  test('leaves a foreignObject child as a bare element inside the svg', () => {
    assert.match(sanitize(DRAWING_SVG), /<\/text><div>x<\/div>/)
  })

  test('keeps a use href, including one naming another origin', () => {
    const out = sanitize(DRAWING_SVG)
    assert.match(out, /<use href="#a"><\/use>/)
    assert.match(out, /<use href="https:\/\/evil\.example\/x\.svg#a"><\/use>/)
  })
})

describe('sanitizeOptions -- a drawing stored as a fenced body inside a block', () => {
  const json = JSON.stringify({
    v: 1,
    strokes: [
      {
        c: '#000',
        w: 2,
        p: [
          [0, 0],
          [10, 10]
        ]
      }
    ]
  })
  const fenced =
    '<block-whiteboard caption="Plan" drawingKey="board-1" src="/b.svg" onclick="alert(1)" data-x="1">' +
    `<pre class="codeblock-whiteboard"><code>${json.replaceAll('"', '&quot;')}</code></pre>` +
    '</block-whiteboard>'

  test('keeps the block, its declared props (either case) and data-*, and drops the handler', () => {
    const out = sanitize(fenced)
    assert.match(out, /^<block-whiteboard /)
    assert.match(out, /caption="Plan"/)
    assert.match(out, /drawingKey="board-1"/)
    assert.match(out, /src="\/b\.svg"/)
    assert.match(out, /data-x="1"/)
    assert.doesNotMatch(out, /onclick/)
  })

  test('returns the JSON body byte for byte once the entities are decoded', () => {
    const out = sanitize(fenced)
    const text = cheerio.load(out, null, false)('pre.codeblock-whiteboard code').text()
    assert.equal(text, json)
  })

  test('applies no size limit of its own to the body', () => {
    const points = Array.from({ length: 60000 }, (_, i) => [i, i * 2])
    const big = JSON.stringify({ v: 1, strokes: [{ c: '#000', w: 2, p: points }] })
    assert.ok(big.length > 500_000)
    const out = sanitize(
      `<block-whiteboard><pre class="codeblock-whiteboard"><code>${big.replaceAll('"', '&quot;')}</code></pre></block-whiteboard>`
    )
    assert.equal(cheerio.load(out, null, false)('code').text(), big)
  })

  test('leaves the JSON visible as a plain pre when the block is not enabled on the site', () => {
    const out = sanitize(fenced, {}, [])
    assert.doesNotMatch(out, /<block-whiteboard/)
    assert.match(out, /<pre class="codeblock-whiteboard"><code>/)
    assert.equal(cheerio.load(out, null, false)('code').text(), json)
  })
})

describe('sanitizeOptions -- a drawing stored as an image', () => {
  test('keeps a data: image and a same-origin file URL on img, and drops a blob: URL', () => {
    const out = sanitize(
      '<img src="data:image/png;base64,AAAA"><img src="data:image/svg+xml;base64,AAAA"><img src="/_files/a.svg"><img src="blob:https://wiki.example/1">'
    )
    assert.match(out, /<img src="data:image\/png;base64,AAAA" \/>/)
    assert.match(out, /<img src="data:image\/svg\+xml;base64,AAAA" \/>/)
    assert.match(out, /<img src="\/_files\/a\.svg" \/>/)
    assert.doesNotMatch(out, /blob:/)
  })

  test('refuses a data: URL on anything but img', () => {
    const out = sanitize('<a href="data:text/html,<b>x</b>">x</a>')
    assert.doesNotMatch(out, /data:/)
  })
})

describe('sanitizeSvg -- the same drawing markup uploaded as an .svg asset', () => {
  const out = sanitizeSvg(Buffer.from(DRAWING_SVG)).toString('utf8')

  test('keeps the shapes and stroke attributes', () => {
    assert.match(out, /viewBox="0 0 100 100"/)
    assert.match(out, /<path d="M0 0 L10 10">/)
    assert.match(out, /stroke-linecap="round"/)
    assert.match(out, /font-size="12"/)
  })

  test('drops data-*, style, vector-effect, <image> and every script route', () => {
    assert.doesNotMatch(out, /data-board/)
    assert.doesNotMatch(out, /style/)
    assert.doesNotMatch(out, /vector-effect/)
    assert.doesNotMatch(out, /<image/)
    assert.doesNotMatch(out, /foreignObject|<script|alert|onclick|javascript:/)
  })

  test('keeps a fragment use href and drops one naming another origin', () => {
    assert.match(out, /<use href="#a"><\/use>/)
    assert.doesNotMatch(out, /evil\.example/)
  })

  test('drops the metadata and title tags, leaving their text bare, and keeps desc', () => {
    const source = '{"strokes":[]}'
    const kept = sanitizeSvg(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><metadata>${source}</metadata><title>Plan</title><desc>${source}</desc><path d="M0 0"/></svg>`
      )
    ).toString('utf8')
    assert.doesNotMatch(kept, /<metadata|<title/)
    assert.match(kept, /<desc>\{"strokes":\[\]\}<\/desc>/)
    assert.equal(kept.split(source).length - 1, 2)
  })
})
