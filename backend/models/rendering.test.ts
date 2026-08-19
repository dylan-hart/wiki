import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { BlockDefinition } from './blocks.ts'

/*
 * `Rendering.postProcess` is what a save (and a headless server-side re-render, which drives the
 * very same frontend pipeline through Puppeteer — see the model's own header comment) both go
 * through before anything is stored. What is genuinely this file's own to cover, without a database,
 * is the sanitize step: whether a diagram block survives it with its element and fenced body intact,
 * which is the "block-vs-fence handoff" the diagram blocks depend on (`firstUpdated()` in each of
 * `block-diagram`, `block-kroki`, `block-plantuml` reads its source out of exactly the `<pre>` this
 * locks down). `getEnabledKeys` is the one call in the path that is real SQL orchestration rather
 * than logic worth exercising here, so it is the one thing stubbed -- `WIKI.models.blocks.definitions`
 * itself is a plain in-memory array (read from the compiled manifest at boot, not a query), so it is
 * given real fixtures shaped exactly like the three diagram blocks' own `static definition.props`.
 */

const DIAGRAM_BLOCKS: BlockDefinition[] = [
  {
    block: 'diagram',
    name: 'Mermaid',
    description: 'Draws a Mermaid diagram.',
    icon: 'workflow',
    props: [
      { name: 'caption', type: 'string' },
      { name: 'theme', type: 'select' },
      { name: 'align', type: 'select' }
    ]
  },
  {
    block: 'kroki',
    name: 'Kroki',
    description: 'Draws a diagram through a Kroki server.',
    icon: 'tree-structure',
    props: [
      { name: 'type', type: 'select' },
      { name: 'server', type: 'string' },
      { name: 'format', type: 'select' },
      { name: 'caption', type: 'string' },
      { name: 'align', type: 'select' }
    ]
  },
  {
    block: 'plantuml',
    name: 'PlantUML',
    description: 'Draws a PlantUML diagram.',
    icon: 'diagram-project',
    props: [
      { name: 'server', type: 'string' },
      { name: 'format', type: 'select' },
      { name: 'caption', type: 'string' },
      { name: 'align', type: 'select' }
    ]
  }
]

let enabledBlocks = new Set<string>()

// -> A minimal stub rather than `test/db.ts`'s full `installTestWiki`: nothing under test here
//    reaches the database, so the only real dependency is `WIKI.models.blocks` itself
;(global as any).WIKI = {
  models: {
    blocks: {
      definitions: DIAGRAM_BLOCKS,
      async getEnabledKeys(_siteId: string) {
        return enabledBlocks
      }
    }
  }
}

const { rendering } = await import('./rendering.ts')

/** The shape markdown-it-mdc + `highlight()` actually leave behind for a fenced diagram inside a block. */
function blockHtml(tag: string, attrs: string, lang: string, escapedSource: string): string {
  return `<${tag} ${attrs}><pre class="codeblock-${lang}"><code>${escapedSource}</code></pre></${tag}>`
}

describe('rendering.postProcess: diagram block-vs-fence handoff', () => {
  test('keeps block-diagram and its fenced mermaid body intact when the block is enabled', async () => {
    enabledBlocks = new Set(['diagram'])
    const html = blockHtml(
      'block-diagram',
      'theme="auto" align="left"',
      'mermaid',
      'A[Start] --&gt; B{Ready?}'
    )

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.match(result.render, /<block-diagram theme="auto" align="left">/)
    assert.match(
      result.render,
      /<pre class="codeblock-mermaid"><code>A\[Start\] --&gt; B\{Ready\?\}<\/code><\/pre>/
    )
    assert.match(result.render, /<\/block-diagram>$/)
  })

  test('keeps block-kroki and its fenced graphviz body intact when the block is enabled', async () => {
    enabledBlocks = new Set(['kroki'])
    const html = blockHtml(
      'block-kroki',
      'type="graphviz" server="https://kroki.io" format="svg"',
      'kroki',
      'digraph G { Hello -&gt; World }'
    )

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.match(
      result.render,
      /^<block-kroki type="graphviz" server="https:\/\/kroki\.io" format="svg">/
    )
    assert.match(
      result.render,
      /<pre class="codeblock-kroki"><code>digraph G \{ Hello -&gt; World \}<\/code><\/pre>/
    )
  })

  test('keeps block-plantuml and its fenced body intact when the block is enabled', async () => {
    enabledBlocks = new Set(['plantuml'])
    const html = blockHtml('block-plantuml', 'format="svg"', 'plantuml', 'Alice -&gt; Bob: hi')

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.match(result.render, /^<block-plantuml format="svg">/)
    assert.match(
      result.render,
      /<pre class="codeblock-plantuml"><code>Alice -&gt; Bob: hi<\/code><\/pre>/
    )
  })

  test('drops the block, but keeps the fenced body as plain text, when the block is disabled for the site', async () => {
    enabledBlocks = new Set() // -> nothing enabled
    const html = blockHtml('block-diagram', 'theme="auto"', 'mermaid', 'A --&gt; B')

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.doesNotMatch(result.render, /block-diagram/)
    // -> The fenced source itself is ordinary content and survives the block around it being stripped
    assert.match(result.render, /<pre class="codeblock-mermaid"><code>A --&gt; B<\/code><\/pre>/)
  })

  test('drops an attribute the block did not declare as a prop', async () => {
    enabledBlocks = new Set(['diagram'])
    const html =
      '<block-diagram theme="auto" onclick="alert(1)"><pre class="codeblock-mermaid"><code>A --&gt; B</code></pre></block-diagram>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.match(result.render, /<block-diagram theme="auto">/)
    assert.doesNotMatch(result.render, /onclick/)
  })
})

/**
 * `sanitize()` is what a page's HTML has to survive to be stored -- and since Task 624
 * (`renderers/markdown.js`'s `$…$`/`$$…$$` TeX authoring) resolves straight to literal KaTeX
 * HTML/MathML at render time, that markup is now something a real page can carry, not just something
 * `block-katex` draws inside a shadow root the sanitiser never sees.
 *
 * `sanitize()`'s block-allowance pass reads `WIKI.models.blocks.definitions`; no page block is
 * involved in typesetting a formula, so its content doesn't matter for these tests -- reuses the
 * same `WIKI` stub the diagram-block suite above already installed.
 */

describe('rendering.sanitize -- KaTeX MathML from inline TeX authoring', () => {
  test('keeps the accent/variant/thickness attributes KaTeX writes onto MathML tags', () => {
    // -> A minimal stand-in for what `katex.renderToString({ output: 'htmlAndMathml' })` actually
    //    emits for `\vec{v}`, `\binom{n}{k}` and a variant-styled identifier -- real output, trimmed
    //    to the four attributes this test exists to protect (see the task's PR description for the
    //    full battery that found them: `mover:accent`, `munder:accentunder`, `mfrac:linethickness`,
    //    `mi:mathvariant` all silently dropped before `BASE_ALLOWED_ATTRIBUTES` named them).
    const html =
      '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics>' +
      '<mover accent="true"><mi>v</mi><mo>⃗</mo></mover>' +
      '<munder accentunder="true"><mi>x</mi><mo>_</mo></munder>' +
      '<mfrac linethickness="0"><mi>n</mi><mi>k</mi></mfrac>' +
      '<mi mathvariant="normal">mod</mi>' +
      '<annotation encoding="application/x-tex">\\vec{v}</annotation>' +
      '</semantics></math>'

    const clean = (rendering as any).sanitize(html, {}, new Set())

    assert.match(clean, /<mover accent="true">/)
    assert.match(clean, /<munder accentunder="true">/)
    assert.match(clean, /<mfrac linethickness="0">/)
    assert.match(clean, /<mi mathvariant="normal">/)
  })
})

/*
  Task 629's audit: verify the allowlist against each engine's *actual* output rather than trusting
  what is already declared, using mhchem (`\ce{}`/`\pu{}`) specifically because chemical notation
  exercises MathML shapes a plain algebraic formula does not -- `mpadded`, `mphantom` and `msub` used
  together for the isotope/coefficient overlap trick, `mo[stretchy][minsize]` for the reaction arrow,
  and `mstyle[scriptlevel][displaystyle]` wrapping a unit fraction.

  These two strings are captured byte-for-byte from a real `katex.renderToString(source, { output:
  'htmlAndMathml' })` run with `katex/contrib/mhchem` loaded (the same import `block-katex/component.js`
  makes) -- not reconstructed by hand. Both come back from `sanitize()` with their `<math>…</math>`
  identical to the byte, so this records a clean audit result, not a fix: every tag and attribute
  mhchem's MathML writer uses was already covered by what Task 624 added.

  mhchem is NOT wired into `renderers/markdown.js`'s literal `$…$`/`$$…$$` path today -- only plain
  `katex` is imported there, so `\ce{}` in inline TeX currently throws ("Undefined control sequence")
  and falls to the error panel, same as any other unrecognised command. This test is not exercising a
  path that is live in the app; it is insurance for the allowlist itself, which is live (the plain-
  algebra MathML this same sanitiser sees every time an author writes `$x^2$` uses many of the same
  tags). If a later task wires mhchem into the literal path -- or `\ce{}` support becomes part of
  "Engine Selection" -- this confirms the allowlist will not need touching to carry it.
*/
describe('rendering.sanitize -- KaTeX MathML from mhchem (\\ce{}/\\pu{})', () => {
  test('keeps every tag and attribute a real \\ce{} render writes into MathML', () => {
    const math =
      '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow>' +
      '<mrow><mi mathvariant="normal">C</mi><mi mathvariant="normal">O</mi></mrow>' +
      '<msub><mpadded width="0px"><mphantom><mi>X</mi></mphantom></mpadded>' +
      '<mpadded height="0px"><mn>2</mn></mpadded></msub>' +
      '<mrow></mrow><mo>+</mo><mrow></mrow><mi mathvariant="normal">C</mi>' +
      '<mover><mo stretchy="true" minsize="3.0em">→</mo>' +
      '<mpadded width="+0.6em" lspace="0.3em"><mrow></mrow></mpadded></mover>' +
      '<mn>2</mn><mtext> </mtext>' +
      '<mrow><mi mathvariant="normal">C</mi><mi mathvariant="normal">O</mi></mrow>' +
      '</mrow><annotation encoding="application/x-tex">\\ce{CO2 + C -&gt; 2 CO}</annotation>' +
      '</semantics></math>'

    const clean = (rendering as any).sanitize(`<p>${math}</p>`, {}, new Set())

    assert.ok(clean.includes(math), 'the whole <math>…</math> survived sanitize() unchanged')
  })

  test('keeps every tag and attribute a real \\pu{} render writes into MathML', () => {
    const math =
      '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow>' +
      '<mn>123</mn><mtext> </mtext>' +
      '<mstyle scriptlevel="0" displaystyle="false"><mfrac>' +
      '<mrow><mi mathvariant="normal">k</mi><mi mathvariant="normal">J</mi></mrow>' +
      '<mrow><mi mathvariant="normal">m</mi><mi mathvariant="normal">o</mi><mi mathvariant="normal">l</mi></mrow>' +
      '</mfrac></mstyle></mrow>' +
      '<annotation encoding="application/x-tex">\\pu{123 kJ//mol}</annotation>' +
      '</semantics></math>'

    const clean = (rendering as any).sanitize(`<p>${math}</p>`, {}, new Set())

    assert.ok(clean.includes(math), 'the whole <math>…</math> survived sanitize() unchanged')
  })
})

/**
 * `renderPdf`'s gating, pure-unit — no Puppeteer, no browser, no database.
 *
 * The rest of `renderPdf` (launching Chromium, setting content, calling `page.pdf`) needs a real
 * Puppeteer install to exercise meaningfully, and Puppeteer is an optional extension this environment
 * does not have installed (see `backend/package.json`'s `allowScripts` note and the absence of the
 * package from `node_modules`) — mocking `import('puppeteer')` itself would mostly be re-describing
 * `launchBrowser` rather than verifying it. What IS a pure function of `WIKI.models.extensions`, and
 * therefore worth a unit test here, is that a missing extension is refused before any browser is
 * touched, with the same `renderPuppeteerMissing` `CustomError` (503) the frontend-bundle renderer
 * already throws for the same reason — see `isAvailable`/`ensureCanRender`.
 */
describe('rendering renderPdf gating (unit)', () => {
  let renderingModel: typeof import('./rendering.ts').rendering

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        extensions: {
          getDefinition: () => null,
          isInstalled: async () => false
        }
      },
      logger: { debug: () => {}, warn: () => {} }
    }
    ;({ rendering: renderingModel } = await import('./rendering.ts'))
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('refuses when the Puppeteer extension is not installed', async () => {
    await assert.rejects(
      renderingModel.renderPdf('<p>Hello</p>', { title: 'Test Page' }),
      (err: any) => {
        assert.equal(err.name, 'renderPuppeteerMissing')
        assert.equal(err.statusCode, 503)
        assert.match(err.message, /Puppeteer/)
        return true
      }
    )
  })
})
