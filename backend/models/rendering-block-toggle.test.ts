import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { rendering } from './rendering.ts'

/**
 * Task 631 -- verifies the `block-toggle-as-engine-switch` mechanism end to end, through the same
 * `postProcess()` a real save (`models/pages.ts#create`/`update`) or the Puppeteer queue's drain
 * (`storeRender`) actually calls. `blockAllowances()`/`sanitizeOptions()` (see `rendering.ts`) do not
 * know `katex`/`mathjax` by name -- they are ordinary entries in `WIKI.models.blocks.definitions`, gated
 * for a site purely by whether `getEnabledKeys()` returns them. That genericity is exactly what this
 * test exercises: no block-specific code path exists to verify, only the generic one applied to these
 * two blocks.
 *
 * Fixture HTML is real output, not hand-written: captured from
 * `new MarkdownRenderer().render('::block-katex\n\`\`\`latex\nx = \\frac{...}...\`\`\`\n::')`
 * (`frontend/src/renderers/markdown.js`) -- markdown-it-mdc's block-component syntax wrapping a
 * fenced code block that markdown-it's own hljs highlighting already ran over, exactly what an author
 * saving a page with a KaTeX formula produces.
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

/** Real `MarkdownRenderer().render()` output for a `::block-katex` fence -- see file docstring. */
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
  ;(globalThis as any).WIKI = {
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
    // -> KaTeX turned off site-wide: `definitions` still lists it (it is still installed), but
    //    `getEnabledKeys()` no longer returns it -- exactly what `AdminBlocks.vue` flipping the
    //    toggle does to the row in the `blocks` table.
    stubBlocks([KATEX_DEFINITION], new Set())

    const { render } = await rendering.postProcess('site-1', PAGE_WITH_KATEX_FORMULA, {
      scripts: false,
      styles: false
    })

    // -> The custom element itself is gone -- not present in any form, styled or not
    assert.doesNotMatch(render, /<block-katex/)
    assert.doesNotMatch(render, /<\/block-katex>/)
    // -> sanitize-html's default behaviour for a disallowed tag is unwrap, not delete: the code block
    //    it wrapped survives, so the formula degrades to visible fenced code rather than vanishing
    assert.match(render, /<pre class="codeblock/)
    assert.match(render, /\\frac/)
    assert.match(render, /\\sqrt/)
    // -> Surrounding content is untouched -- only the disallowed tag was acted on
    assert.match(render, /Before the formula\./)
    assert.match(render, /After the formula\./)
  })

  test('switching engines (disable KaTeX, enable MathJax) does not rewrite existing ::block-katex markup', async () => {
    // -> Both blocks installed; MathJax is the one switched on for this site now
    stubBlocks([KATEX_DEFINITION, MATHJAX_DEFINITION], new Set(['mathjax']))

    const { render } = await rendering.postProcess('site-1', PAGE_WITH_KATEX_FORMULA, {
      scripts: false,
      styles: false
    })

    // -> The page was authored with ::block-katex, not ::block-mathjax -- nothing in `postProcess()`
    //    rewrites one block's markup into another's, so the formula is inert code, not migrated
    assert.doesNotMatch(render, /<block-katex/)
    assert.doesNotMatch(render, /<block-mathjax/)
    assert.match(render, /\\frac/)
  })
})
