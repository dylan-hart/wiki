import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { rendering } from './rendering.ts'

/**
 * `blockAllowances()`/`sanitizeOptions()` do not know `katex`/`mathjax` by name -- they are
 * ordinary entries in `CARDINAL.models.blocks.definitions`, gated purely by `getEnabledKeys()`. No
 * block-specific code path to verify, only the generic one applied to these two blocks.
 *
 * Fixture HTML is real output, not hand-written: captured from `new MarkdownRenderer().render()`
 * (`frontend/src/renderers/markdown.js`) over a `::block-katex` fence, so it carries markdown-it's
 * own hljs highlighting exactly as an author saving a KaTeX formula produces it.
 */

const KATEX_DEFINITION = {
  block: 'katex',
  name: 'KaTeX',
  description: 'Typesets a TeX formula with KaTeX.',
  icon: 'math',
  props: [
    { name: 'caption', type: 'string' },
    { name: 'align', type: 'select', options: ['center', 'left'] }
  ]
}

const MATHJAX_DEFINITION = {
  block: 'mathjax',
  name: 'MathJax',
  description: 'Typesets a TeX formula with MathJax.',
  icon: 'sigma',
  props: [
    { name: 'caption', type: 'string' },
    { name: 'align', type: 'select', options: ['center', 'left'] }
  ]
}

const PAGE_WITH_KATEX_FORMULA =
  '<p>Before the formula.</p>\n' +
  '<block-katex>\n' +
  '<pre class="codeblock hljs false"><code class="language-latex">x = ' +
  '<span class="hljs-keyword">\\frac</span>{-b <span class="hljs-keyword">\\pm</span> ' +
  '<span class="hljs-keyword">\\sqrt</span>{b<span class="hljs-built_in">^</span>2 - 4ac}}{2a}\n' +
  '</code></pre>\n' +
  '</block-katex>\n' +
  '<p>After the formula.</p>\n'

function stubBlocks(definitions: unknown[], enabled: Set<string>) {
  ;(globalThis as any).CARDINAL = {
    models: {
      blocks: {
        definitions,
        getEnabledKeys: mock.fn(async () => enabled),
        getCustomBlockDefinitions: mock.fn(async () => [])
      }
    }
  }
}

describe('rendering.postProcess -- block-katex/block-mathjax as an ordinary block toggle', () => {
  test('baseline: KaTeX enabled keeps the block element on the page', async () => {
    stubBlocks([KATEX_DEFINITION], new Set(['katex']))

    const { render } = await rendering.postProcess('site-1', PAGE_WITH_KATEX_FORMULA, {
      scripts: false,
      styles: false
    })

    assert.match(render, /<block-katex>/)
    assert.match(render, /\\frac/)
  })

  test('disabling KaTeX for the site strips <block-katex> but keeps the fenced TeX as visible text', async () => {
    // -> Still installed, so `definitions` lists it, but absent from `getEnabledKeys()` -- what
    //    turning the site toggle off leaves behind
    stubBlocks([KATEX_DEFINITION], new Set())

    const { render } = await rendering.postProcess('site-1', PAGE_WITH_KATEX_FORMULA, {
      scripts: false,
      styles: false
    })

    assert.doesNotMatch(render, /<block-katex/)
    assert.doesNotMatch(render, /<\/block-katex>/)
    // -> sanitize-html's default for a disallowed tag is unwrap, not delete: the code block it
    //    wrapped survives, so the formula degrades to visible fenced code rather than vanishing
    assert.match(render, /<pre class="codeblock/)
    assert.match(render, /\\frac/)
    assert.match(render, /\\sqrt/)
    assert.match(render, /Before the formula\./)
    assert.match(render, /After the formula\./)
  })

  test('switching engines (disable KaTeX, enable MathJax) does not rewrite existing ::block-katex markup', async () => {
    stubBlocks([KATEX_DEFINITION, MATHJAX_DEFINITION], new Set(['mathjax']))

    const { render } = await rendering.postProcess('site-1', PAGE_WITH_KATEX_FORMULA, {
      scripts: false,
      styles: false
    })

    // -> Neither tag survives: katex is disabled so its element is unwrapped, and nothing rewrites
    //    one block's markup into another's, so the formula is left inert rather than migrated
    assert.doesNotMatch(render, /<block-katex/)
    assert.doesNotMatch(render, /<block-mathjax/)
    assert.match(render, /\\frac/)
  })
})
