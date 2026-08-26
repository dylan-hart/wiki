import { describe, test } from 'node:test'
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

/** Custom blocks (OpenProject #2132) -- the shape `models/blocks.ts#getCustomBlockDefinitions()` returns. */
let customBlocks: { block: string; props: { name: string }[] }[] = []

// -> A minimal stub rather than `test/db.ts`'s full `installTestWiki`: nothing under test here
//    reaches the database, so the only real dependency is `WIKI.models.blocks` itself
;(global as any).WIKI = {
  models: {
    blocks: {
      definitions: DIAGRAM_BLOCKS,
      async getEnabledKeys(_siteId: string) {
        return enabledBlocks
      },
      async getCustomBlockDefinitions(_siteId: string) {
        return customBlocks
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

/*
 * `blockAllowances()` used to read only `WIKI.models.blocks.definitions` -- the compiled manifest,
 * which a custom block (a `blocks` row with `isCustom: true`, uploaded through `api/blocks.ts`) has no
 * entry in at all. That meant `block-<customTag>` never reached the sanitizer's allowlist and was
 * silently stripped from every saved page, however the editor's own preview rendered it. OpenProject
 * #2132 admits custom blocks from `getCustomBlockDefinitions()` (stubbed here as the mutable
 * `customBlocks`, mirroring `enabledBlocks` above) the same way built-ins are admitted -- gated on
 * being enabled, and with only the prop names the block's own upload declared.
 */
describe('rendering.postProcess: custom blocks admitted to blockAllowances (OpenProject #2132)', () => {
  test("keeps a custom block's tag and declared prop, but strips an attribute it never declared", async () => {
    enabledBlocks = new Set(['gallery-custom'])
    customBlocks = [{ block: 'gallery-custom', props: [{ name: 'caption' }] }]
    const html =
      '<block-gallery-custom caption="Trip photos" onclick="alert(1)"><p>content</p></block-gallery-custom>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.match(result.render, /<block-gallery-custom caption="Trip photos">/)
    assert.doesNotMatch(result.render, /onclick/)
  })

  test('drops the element, but keeps its text content, when the custom block is not enabled for the site', async () => {
    enabledBlocks = new Set() // -> nothing enabled, including the custom block below
    customBlocks = [{ block: 'gallery-custom', props: [{ name: 'caption' }] }]
    const html = '<block-gallery-custom caption="Trip photos">content</block-gallery-custom>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.doesNotMatch(result.render, /block-gallery-custom/)
    // -> Same as any other disallowed tag: the element goes, the text inside it stays
    assert.match(result.render, /content/)
  })
})

describe('rendering.postProcess: internal link extraction (OpenProject #881)', () => {
  test("resolves a relative link against the page's folder", async () => {
    const html = '<p><a href="../sibling">Sibling</a></p>'
    const result = await rendering.postProcess(
      'site-1',
      html,
      { scripts: false, styles: false },
      'docs/child/page'
    )
    assert.deepEqual(result.links, ['docs/sibling'])
  })

  test('resolves a root-relative link as-is, dropping the leading slash', async () => {
    const html = '<p><a href="/getting-started">Start</a></p>'
    const result = await rendering.postProcess(
      'site-1',
      html,
      { scripts: false, styles: false },
      'docs/page'
    )
    assert.deepEqual(result.links, ['getting-started'])
  })

  test('ignores external, mailto, and fragment-only links', async () => {
    const html =
      '<p><a href="https://example.com">Ext</a> <a href="mailto:a@b.com">Mail</a> <a href="#section">Frag</a></p>'
    const result = await rendering.postProcess(
      'site-1',
      html,
      { scripts: false, styles: false },
      'docs/page'
    )
    assert.deepEqual(result.links, [])
  })

  test('de-duplicates repeated links to the same page', async () => {
    const html = '<p><a href="sibling">One</a> <a href="sibling">Two</a></p>'
    const result = await rendering.postProcess(
      'site-1',
      html,
      { scripts: false, styles: false },
      'docs/page'
    )
    assert.deepEqual(result.links, ['docs/sibling'])
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
/*
  OpenProject #829, item 1: upstream issue #1839 ("Mermaid renders in the live edit preview but not
  on the saved/reloaded page") and discussion #6446 (the identical pattern for KaTeX formulas) both
  describe a render-then-reload regression. This fork's architecture cannot reproduce either report
  by construction, and this test is what pins that down rather than leaving it as an assertion in a
  comment:

   - A diagram (`block-diagram`/`block-kroki`/`block-plantuml`) is a Lit custom element that draws
     itself in `firstUpdated()` -- a browser lifecycle hook that fires identically whichever DOM path
     upgraded the element. `pages/Index.vue`'s route watcher (`{ immediate: true }`, so it also fires
     on a page loaded directly rather than navigated to) scans the loaded content for
     `:not(:defined)` custom elements and imports their component the same way `EditorMarkdown.vue`'s
     live preview does -- there is no separate "preview renderer" and "saved-page renderer" to drift
     apart. What this test can verify without a browser is the half that actually lives here: that
     `postProcess` -- what a save (and what a headless re-render replays) both run -- does not
     itself strip or mangle the block element or the fenced source `firstUpdated()` reads out of it,
     which is the one way a reload-only regression could hide in this file.
   - Literal `$…$`/`$$…$$` TeX (Task 624) is resolved to real KaTeX HTML/MathML at the point the
     editor's own render runs (`renderers/markdown.js`), not deferred to a script that has to run
     again on every future view -- so the stored/reloaded page needs no client-side re-render step
     for a formula to appear at all, unlike a design where "render" and "display" are separate
     passes that can disagree. This test's job is to confirm `postProcess`'s sanitize step is what
     the earlier `describe` block already proved in isolation -- keeps that literal markup byte-for-
     byte -- when it runs alongside a diagram block in the same document, not just alone.
*/
describe('rendering.postProcess -- render, save, reload (OpenProject #829)', () => {
  test('keeps a mermaid diagram block and a resolved inline KaTeX formula both intact through the same save-time pass a reload replays', async () => {
    enabledBlocks = new Set(['diagram'])
    // -> A trimmed but structurally real `katex.renderToString(..., { output: 'htmlAndMathml' })`
    //    shape: the MathML the earlier describe block already proved survives `sanitize()` on its
    //    own, now alongside a diagram block in one document -- the actual "did the editor's own
    //    HTML come back out the other end of a save" question this item asks.
    const katexHtml =
      '<span class="katex"><span class="katex-mathml">' +
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics>' +
      '<mrow><mi>π</mi><msup><mi>r</mi><mn>2</mn></msup></mrow>' +
      '<annotation encoding="application/x-tex">\\pi r^2</annotation>' +
      '</semantics></math></span>' +
      '<span class="katex-html" aria-hidden="true">π r<sup>2</sup></span></span>'
    const diagramHtml = blockHtml(
      'block-diagram',
      'theme="auto"',
      'mermaid',
      'A[Start] --&gt; B{Ready?}'
    )
    const html = `<p>The area is ${katexHtml} exactly.</p>${diagramHtml}`

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    // -> The formula: fully resolved, static markup a reload can display with no re-render step
    assert.match(result.render, /class="katex"/)
    assert.match(result.render, /\\pi r\^2/)
    // -> The diagram: the element and its fenced source, exactly what `firstUpdated()` needs to draw
    //    it again on whichever DOM path upgraded the element this time
    assert.match(result.render, /<block-diagram theme="auto">/)
    assert.match(
      result.render,
      /<pre class="codeblock-mermaid"><code>A\[Start\] --&gt; B\{Ready\?\}<\/code><\/pre>/
    )
    assert.match(result.render, /<\/block-diagram>/)
  })
})

/*
 * OpenProject #2183: `allowedStyles` gates the inline `style` *attribute* (distinct from the
 * `<style>` *tag*, which `write:styles` already controlled) so that an author without the
 * permission cannot escape their own element's box -- `position: fixed` chief among them, since
 * `WScrollArea.vue` (the page content's real ancestor chain) establishes no containing block for
 * it to be clipped by.
 */
describe('rendering.sanitize -- allowedStyles gates inline style declarations', () => {
  test('drops position/inset/z-index from a style attribute for an author without write:styles', () => {
    const html = '<div style="position: fixed; inset: 0; z-index: 999; color: red;">x</div>'

    const clean = (rendering as any).sanitize(html, { scripts: false, styles: false }, new Set())

    assert.doesNotMatch(clean, /position/)
    assert.doesNotMatch(clean, /inset/)
    assert.doesNotMatch(clean, /z-index/)
    // -> An unrelated, allowed declaration in the same attribute survives
    assert.match(clean, /color:\s*red/)
  })

  test('drops transform/opacity/pointer-events/content the same way', () => {
    const html =
      '<div style="transform: translateX(100px); opacity: 0.5; pointer-events: none; content: \'x\'; width: 10px;">x</div>'

    const clean = (rendering as any).sanitize(html, { scripts: false, styles: false }, new Set())

    assert.doesNotMatch(clean, /transform/)
    assert.doesNotMatch(clean, /opacity/)
    assert.doesNotMatch(clean, /pointer-events/)
    assert.doesNotMatch(clean, /content/)
    assert.match(clean, /width:\s*10px/)
  })

  test('keeps top/left even without position, since they are inert without it', () => {
    const html = '<div style="top: 10px; left: 20px;">x</div>'

    const clean = (rendering as any).sanitize(html, { scripts: false, styles: false }, new Set())

    assert.match(clean, /top:\s*10px/)
    assert.match(clean, /left:\s*20px/)
  })

  test('does not restrict style declarations for an author who holds write:styles', () => {
    const html = '<div style="position: fixed; inset: 0; z-index: 999;">x</div>'

    const clean = (rendering as any).sanitize(html, { scripts: false, styles: true }, new Set())

    assert.match(clean, /position:\s*fixed/)
    assert.match(clean, /z-index:\s*999/)
  })

  test('keeps the real KaTeX inline-style declarations a formula needs for layout', () => {
    // -> A representative slice of what `katex.renderToString` writes for sizing/positioning glyphs
    //    inside a formula -- height/width/margin/vertical-align/border are all real KaTeX output.
    const html =
      '<span class="katex-html"><span class="strut" style="height:0.9em;vertical-align:-0.1em;">' +
      '</span><span class="mfrac" style="width:1.2em;margin-right:0.1em;border-bottom-width:0.04em;">' +
      '</span></span>'

    const clean = (rendering as any).sanitize(html, { scripts: false, styles: false }, new Set())

    assert.match(clean, /height:0\.9em/)
    assert.match(clean, /vertical-align:-0\.1em/)
    assert.match(clean, /width:1\.2em/)
    assert.match(clean, /margin-right:0\.1em/)
    assert.match(clean, /border-bottom-width:0\.04em/)
  })
})

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

/*
 * `postProcess` used to run `sanitize()` before `inlineIcons()`, so the last step that draws more
 * markup into the document (an icon's SVG body, resolved from a third party) ran AFTER the only step
 * that filtered what a page may contain -- `isSafeIconBody` (`models/icons.ts`) is a denylist over the
 * icon's raw, still HTML-entity-encoded body at ingest time, and never sees what that decodes to once
 * `iconSvg()`'s own `$(...)` call parses it straight into the live DOM, entity-decoding attribute
 * values exactly like a browser would. OpenProject #2139 closes the gap with a second sanitize pass
 * after `inlineIcons()`, against the identical options object the first pass used.
 *
 * `WIKI.models.icons` is stubbed only with what `inlineIcons()`/`iconSvg()` actually call --
 * `parseRef`, `resolveIcons`, `renderInlineSvg` -- keyed off a `resolvedIcons` map this describe block
 * populates per test, the same "minimal stub of the one real dependency" approach the file's own
 * header comment already uses for `WIKI.models.blocks`.
 */
describe('rendering.postProcess: re-sanitizes after inlineIcons (OpenProject #2139)', () => {
  const resolvedIcons = new Map<string, { body: string }>()

  ;(global as any).WIKI.models.icons = {
    parseRef(ref: string) {
      const [prefix, name] = `${ref}`.split(':')
      return prefix && name ? { prefix, name } : null
    },
    async resolveIcons(prefix: string, names: string[]) {
      const icons: Record<string, { body: string }> = {}
      for (const name of names) {
        const found = resolvedIcons.get(`${prefix}:${name}`)
        if (found) {
          icons[name] = found
        }
      }
      return { icons, notFound: names.filter((name) => !icons[name]) }
    },
    // -> A trimmed stand-in for the real `iconToSVG`/`iconToHTML`/`replaceIDs` pipeline: wraps the
    //    icon's body in an <svg> exactly the way the real method does, without needing a real
    //    IconifyIcon shape -- what's under test is `postProcess`'s two sanitize passes, not this
    //    method's own rendering, which has no coverage gap of its own to fill here.
    renderInlineSvg(icon: { body: string }) {
      return `<svg viewBox="0 0 24 24">${icon.body}</svg>`
    }
  }

  test('removes an entity-encoded javascript: href that only exists after inlineIcons, not before', async () => {
    // -> `&#106;avascript:` is `javascript:` with its first letter as a numeric character reference --
    //    `isSafeIconBody`'s denylist matches the literal string `javascript:`, so this passes ingest,
    //    and only becomes a real `javascript:` value once something HTML-parses it (`iconSvg()`'s
    //    `$(...)` call does exactly that, the same as a browser would).
    resolvedIcons.set('mdi:trap', {
      body: '<a href="&#106;avascript:alert(1)">click</a><circle cx="12" cy="12" r="10"></circle>'
    })
    const html = '<iconify-icon icon="mdi:trap"></iconify-icon>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.doesNotMatch(result.render, /javascript:/i)
    assert.doesNotMatch(result.render, /\shref=/)
    // -> The rest of the icon body, which is not itself dangerous, still comes through
    assert.match(result.render, /<circle cx="12" cy="12" r="10">/)
  })

  test('still inlines an ordinary icon with its shape primitives and attributes intact', async () => {
    resolvedIcons.set('mdi:plain', {
      body: '<path d="M12 2L2 7l10 5 10-5-10-5z" fill="currentColor"></path>'
    })
    const html = '<iconify-icon icon="mdi:plain"></iconify-icon>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.match(result.render, /<svg viewBox="0 0 24 24"[^>]*>/)
    assert.match(result.render, /<path d="M12 2L2 7l10 5 10-5-10-5z" fill="currentColor">/)
  })
})
