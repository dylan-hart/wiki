import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as cheerio from 'cheerio'
import { rendering } from './rendering.ts'
import { installTestWiki } from '../test/mocks.ts'

const wiki = installTestWiki({
  models: {
    blocks: {
      definitions: [{ block: 'whiteboard', props: [] }],
      async getEnabledKeys(_siteId: string) {
        return new Set(['whiteboard'])
      },
      async getCustomBlockDefinitions(_siteId: string) {
        return []
      }
    }
  }
})
after(() => wiki.restore())

const PERMISSIONS = { scripts: false, styles: false }

function board(strokes: number, pointsPerStroke = 1): string {
  const p = Array.from({ length: pointsPerStroke * 3 }, (_, i) => i % 100)
  const stroke = JSON.stringify({ c: '#1f2937', z: 4, p })
  return ['{"v":2,"w":800,"h":450}', ...Array.from({ length: strokes }, () => stroke)].join('\n')
}

function block(body: string, preClass = 'codeblock-whiteboard'): string {
  return `<block-whiteboard><pre class="${preClass}"><code>${body}\n</code></pre></block-whiteboard>`
}

async function refusal(html: string): Promise<any> {
  try {
    await rendering.postProcess('site-1', html, PERMISSIONS)
  } catch (err) {
    return err
  }
  assert.fail('expected postProcess to refuse the save')
}

describe('rendering.postProcess: whiteboard size cap', () => {
  test('keeps a board within the cap byte for byte', async () => {
    const body = board(20, 50)
    assert.equal(body.split('\n').length, 21)
    const result = await rendering.postProcess('site-1', `<p>Intro</p>${block(body)}`, PERMISSIONS)

    assert.ok(result.render.includes('<block-whiteboard><pre class="codeblock-whiteboard">'))
    assert.equal(cheerio.load(result.render)('block-whiteboard pre').text(), `${body}\n`)
  })

  test('keeps an empty board', async () => {
    const result = await rendering.postProcess('site-1', block(board(0)), PERMISSIONS)
    assert.match(result.render, /<block-whiteboard>/)
  })

  test('refuses a block over 262,144 bytes with a 400 and does not truncate it', async () => {
    const err = await refusal(block('x'.repeat(262145)))

    assert.equal(err.statusCode, 400)
    assert.equal(err.name, 'pageWhiteboardTooLarge')
    assert.match(err.message, /262145 bytes/)
  })

  test('accepts a block of exactly 262,144 bytes', async () => {
    await rendering.postProcess('site-1', block('x'.repeat(262144)), PERMISSIONS)
  })

  test('measures the decoded text, not the escaped HTML', async () => {
    await rendering.postProcess('site-1', block('&amp;'.repeat(200000)), PERMISSIONS)
    const err = await refusal(block('&amp;'.repeat(262145)))
    assert.equal(err.statusCode, 400)
  })

  test('refuses a block over 2,000 strokes', async () => {
    const err = await refusal(block(board(2001)))
    assert.equal(err.statusCode, 400)
    assert.match(err.message, /2001 strokes/)
  })

  test('counts a stroke line that does not parse toward the stroke cap', async () => {
    await rendering.postProcess('site-1', block(board(2000)), PERMISSIONS)
    const err = await refusal(block(`${board(2000)}\n{"c":"#1f2937","z":4,"p":[1,2`))
    assert.match(err.message, /2001 strokes/)
  })

  test('refuses a page whose blocks together pass 1 MiB', async () => {
    const quarter = 'x'.repeat(262144)
    await rendering.postProcess('site-1', block(quarter).repeat(4), PERMISSIONS)

    const err = await refusal(block(quarter).repeat(4) + block('y'))
    assert.equal(err.statusCode, 400)
    assert.match(err.message, /1048577 bytes/)
  })

  test('measures the first pre in a block-whiteboard even without the fence class', async () => {
    const err = await refusal(block('x'.repeat(262145), 'codeblock hljs'))
    assert.equal(err.statusCode, 400)
  })

  test('measures a whiteboard fence outside any block', async () => {
    const err = await refusal(
      `<pre class="codeblock-whiteboard"><code>${'x'.repeat(262145)}</code></pre>`
    )
    assert.equal(err.statusCode, 400)
  })

  test('measures a block with no fence by its text, the way the block reads it', async () => {
    const err = await refusal(`<block-whiteboard><p>${'x'.repeat(262145)}</p></block-whiteboard>`)
    assert.equal(err.statusCode, 400)
  })

  test('measures every fence in one block as one body', async () => {
    const half = 'x'.repeat(140000)
    await rendering.postProcess('site-1', block(half), PERMISSIONS)

    const err = await refusal(
      `<block-whiteboard><pre class="codeblock-whiteboard"><code>${half}</code></pre><pre class="codeblock-whiteboard"><code>${half}</code></pre></block-whiteboard>`
    )
    assert.equal(err.statusCode, 400)
    assert.match(err.message, /280001 bytes/)
  })

  test('does not count one pre twice when it is both class-matched and first in its block', async () => {
    const body = 'x'.repeat(262144)
    await rendering.postProcess('site-1', block(body).repeat(4), PERMISSIONS)
  })

  test('leaves other code blocks alone however large', async () => {
    await rendering.postProcess(
      'site-1',
      `<pre class="codeblock hljs"><code>${'x'.repeat(300000)}</code></pre>`,
      PERMISSIONS
    )
  })
})

describe('rendering.postProcess: whiteboard bodies stay out of search text', () => {
  test('drops the fenced JSON and keeps the prose around it', async () => {
    const result = await rendering.postProcess(
      'site-1',
      `<p>Before</p>\n${block(board(2, 3))}\n<p>After</p>`,
      PERMISSIONS
    )

    assert.equal(result.text, 'Before After')
  })

  test('drops a class-less first pre inside the block and a bare whiteboard fence', async () => {
    const result = await rendering.postProcess(
      'site-1',
      `<p>One</p>\n${block(board(1), 'codeblock hljs')}\n<pre class="codeblock-whiteboard"><code>${board(1)}</code></pre>\n<p>Two</p>`,
      PERMISSIONS
    )

    assert.equal(result.text, 'One Two')
  })

  test('drops the body of a block with no fence, and every fence of a block with several', async () => {
    const result = await rendering.postProcess(
      'site-1',
      `<p>One</p>\n<block-whiteboard><p>${board(1)}</p></block-whiteboard>\n<block-whiteboard>${block(board(1)).replaceAll(/<\/?block-whiteboard>/g, '')}<pre><code>${board(1)}</code></pre></block-whiteboard>\n<p>Two</p>`,
      PERMISSIONS
    )

    assert.equal(result.text, 'One Two')
  })

  test('still indexes an ordinary code block', async () => {
    const result = await rendering.postProcess(
      'site-1',
      '<pre class="codeblock hljs"><code>const answer = 42</code></pre>',
      PERMISSIONS
    )

    assert.equal(result.text, 'const answer = 42')
  })
})
