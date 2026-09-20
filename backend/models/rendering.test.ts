import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { rendering } from './rendering.ts'
import { installTestWiki } from '../test/mocks.ts'
import { makeSite } from '../test/builders.ts'
import type { BlockDefinition, BlockProp } from './blocks.ts'

/*
 * The "block-vs-fence handoff" these suites lock down: `firstUpdated()` in each of `block-diagram`,
 * `block-kroki` and `block-plantuml` reads its source out of exactly the `<pre>` the sanitize step
 * is asserted to leave intact.
 *
 * `getEnabledKeys` is the one call in the path that is real SQL, so it is the one thing stubbed;
 * `definitions` is a plain in-memory array read from the compiled manifest, so the fixtures below
 * are shaped like the three diagram blocks' own `static definition.props`. The allowlists
 * themselves belong to `helpers/htmlSanitizePolicy.ts` and are covered in its own suite.
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

/*
 * One block whose declared prop is camelCase -- the DOM only ever spells that lowercase -- and a
 * second declaring no such prop, to prove `blockAllowances()` widening one tag's allow-list never
 * leaks onto another's.
 */
const CAMEL_PROP_BLOCKS: BlockDefinition[] = [
  {
    block: 'checklist',
    name: 'Checklist',
    description: 'A checklist.',
    icon: 'list-checks',
    props: [{ name: 'runKey', type: 'string' }]
  },
  {
    block: 'gallery',
    name: 'Gallery',
    description: 'An image gallery.',
    icon: 'images',
    props: [{ name: 'thumbnailSize', type: 'number' }]
  }
]

const TAB_BLOCK: BlockDefinition = {
  block: 'tab',
  name: 'Tab',
  description: 'One panel of a set of tabs.',
  icon: 'tabler:layout-navbar',
  isChild: true,
  props: []
}

const TABS_BLOCK: BlockDefinition = {
  block: 'tabs',
  name: 'Tabs',
  description: 'Groups content into tabbed panels.',
  icon: 'tabler:layout-navbar',
  props: []
}

let enabledBlocks = new Set<string>()

let customBlocks: { block: string; props: { name: string }[] }[] = []

const wiki = installTestWiki({
  models: {
    blocks: {
      definitions: [...DIAGRAM_BLOCKS, ...CAMEL_PROP_BLOCKS, TAB_BLOCK, TABS_BLOCK],
      async getEnabledKeys(_siteId: string) {
        return enabledBlocks
      },
      async getCustomBlockDefinitions(_siteId: string) {
        return customBlocks
      }
    }
  }
})
after(() => wiki.restore())

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
    enabledBlocks = new Set()
    const html = blockHtml('block-diagram', 'theme="auto"', 'mermaid', 'A --&gt; B')

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.doesNotMatch(result.render, /block-diagram/)
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
 * A custom block has no entry in the compiled `definitions` manifest, so unless `blockAllowances()`
 * also admits `getCustomBlockDefinitions()`, `block-<customTag>` never reaches the sanitizer's
 * allowlist and is stripped from every saved page however the editor's preview rendered it.
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
    enabledBlocks = new Set()
    customBlocks = [{ block: 'gallery-custom', props: [{ name: 'caption' }] }]
    const html = '<block-gallery-custom caption="Trip photos">content</block-gallery-custom>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.doesNotMatch(result.render, /block-gallery-custom/)
    assert.match(result.render, /content/)
  })
})

describe('rendering.postProcess: block-tab header attribute (OpenProject #3579)', () => {
  test('keeps header on a block-tab whose definition is the one shipped in blocks/block-tab', async () => {
    const source = await readFile(
      new URL('../../blocks/block-tab/component.js', import.meta.url),
      'utf8'
    )
    const propsSource = source.slice(source.indexOf('props: ['))
    const props: BlockProp[] = [...propsSource.matchAll(/name: '([\w-]+)'/g)].map((m) => ({
      name: m[1],
      type: 'string'
    }))
    assert.ok(
      props.some((p) => p.name === 'header'),
      'block-tab declares a header prop'
    )
    TAB_BLOCK.props = props
    enabledBlocks = new Set(['tabs'])
    const html =
      '<block-tabs><block-tab label="Foo" header="2"><p>body</p></block-tab></block-tabs>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.match(result.render, /<block-tab label="Foo" header="2">/)
  })

  test('strips header from a block-tab whose definition does not declare it', async () => {
    TAB_BLOCK.props = [{ name: 'label', type: 'string' }]
    enabledBlocks = new Set(['tabs'])
    const html =
      '<block-tabs><block-tab label="Foo" header="2"><p>body</p></block-tab></block-tabs>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.match(result.render, /<block-tab label="Foo">/)
    assert.doesNotMatch(result.render, /header/)
  })
})

describe('rendering.postProcess: lowercase spelling of a camelCase block prop (OpenProject #1707)', () => {
  test('keeps a camelCase-declared prop written in its lowercase DOM spelling', async () => {
    enabledBlocks = new Set(['checklist'])
    const html = '<block-checklist runkey="daily"></block-checklist>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.match(result.render, /<block-checklist runkey="daily">/)
  })

  test('still strips a prop declared on one block tag when written on a different block tag', async () => {
    enabledBlocks = new Set(['checklist', 'gallery'])
    const html = '<block-gallery runkey="daily"></block-gallery>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.match(result.render, /^<block-gallery>/)
    assert.doesNotMatch(result.render, /runkey/)
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

/*
  `LinkPickerDialog.vue` writes a locale-prefixed href (`/fr/guide`) for a non-primary-locale
  target, and for every target on a `forcePrefix` site. It is stripped before storing, since every
  consumer of `pages.links` matches on the bare path in the linking page's own locale.
*/
describe('rendering.postProcess: internal link extraction strips a locale prefix (OpenProject #3379)', () => {
  test('strips a non-primary-locale prefix from a link target', async () => {
    CARDINAL.sites['site-locales'] = makeSite({
      id: 'site-locales',
      config: { locales: { primary: 'en', active: ['en', 'fr'] } }
    })
    const html = '<p><a href="/fr/guide">Guide</a></p>'

    const result = await rendering.postProcess(
      'site-locales',
      html,
      { scripts: false, styles: false },
      'docs/page'
    )

    assert.deepEqual(result.links, ['guide'])
  })

  test('strips a forced primary-locale prefix too (forcePrefix site)', async () => {
    CARDINAL.sites['site-force-prefix'] = makeSite({
      id: 'site-force-prefix',
      config: { locales: { primary: 'en', active: ['en', 'fr'], forcePrefix: true } }
    })
    const html = '<p><a href="/en/guide">Guide</a></p>'

    const result = await rendering.postProcess(
      'site-force-prefix',
      html,
      { scripts: false, styles: false },
      'docs/page'
    )

    assert.deepEqual(result.links, ['guide'])
  })

  test('does not strip a first segment that is not an active locale code', async () => {
    CARDINAL.sites['site-locales-2'] = makeSite({
      id: 'site-locales-2',
      config: { locales: { primary: 'en', active: ['en', 'fr'] } }
    })
    const html = '<p><a href="/de/guide">Guide</a></p>'

    const result = await rendering.postProcess(
      'site-locales-2',
      html,
      { scripts: false, styles: false },
      'docs/page'
    )

    assert.deepEqual(result.links, ['de/guide'])
  })

  test('a site with no locales config leaves a link untouched, unchanged from before', async () => {
    const html = '<p><a href="/fr/guide">Guide</a></p>'

    const result = await rendering.postProcess(
      'site-entirely-unknown-to-wiki-sites-3379',
      html,
      { scripts: false, styles: false },
      'docs/page'
    )

    assert.deepEqual(result.links, ['fr/guide'])
  })
})

/*
  Upstream issue #1839 ("Mermaid renders in the live edit preview but not on the saved/reloaded
  page") and discussion #6446 (KaTeX, same shape) report a render-then-reload regression this fork
  cannot reproduce by construction: a diagram draws itself in `firstUpdated()`, which fires on
  whichever DOM path upgraded the element, and TeX resolves to KaTeX markup at render time rather
  than by a script that has to run again on every view. What is checkable without a browser is that
  `postProcess` strips neither the block element nor the fenced source `firstUpdated()` reads out.
*/
describe('rendering.postProcess -- render, save, reload (OpenProject #829)', () => {
  test('keeps a mermaid diagram block and a resolved inline KaTeX formula both intact through the same save-time pass a reload replays', async () => {
    enabledBlocks = new Set(['diagram'])
    // -> Trimmed but structurally real `katex.renderToString(..., { output: 'htmlAndMathml' })`
    //    output, so the MathML the policy suite covers alone is exercised beside a block here
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

    assert.match(result.render, /class="katex"/)
    assert.match(result.render, /\\pi r\^2/)
    assert.match(result.render, /<block-diagram theme="auto">/)
    assert.match(
      result.render,
      /<pre class="codeblock-mermaid"><code>A\[Start\] --&gt; B\{Ready\?\}<\/code><\/pre>/
    )
    assert.match(result.render, /<\/block-diagram>/)
  })
})

/*
 * `inlineIcons()` draws third-party markup into the document, so it needs a sanitize pass of its
 * own after it: `isSafeIconBody` (`models/icons.ts`) is a denylist over the still entity-encoded
 * body at ingest, and never sees what that decodes to once `iconSvg()`'s `$(...)` parses it into a
 * DOM the way a browser would.
 */
describe('rendering.postProcess: re-sanitizes after inlineIcons (OpenProject #2139)', () => {
  const resolvedIcons = new Map<string, { body: string }>()

  ;(CARDINAL.models as any).icons = {
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
    // -> Stands in for the real `iconToSVG`/`iconToHTML`/`replaceIDs` pipeline without needing a
    //    real IconifyIcon shape: what is under test is the two sanitize passes, not this rendering
    renderInlineSvg(icon: { body: string }) {
      return `<svg viewBox="0 0 24 24">${icon.body}</svg>`
    }
  }

  test('removes an entity-encoded javascript: href that only exists after inlineIcons, not before', async () => {
    // -> `&#106;avascript:` is `javascript:` with its first letter as a character reference:
    //    `isSafeIconBody` matches the literal string, so this passes ingest and only becomes a real
    //    `javascript:` value once `iconSvg()`'s `$(...)` HTML-parses it
    resolvedIcons.set('mdi:trap', {
      body: '<a href="&#106;avascript:alert(1)">click</a><circle cx="12" cy="12" r="10"></circle>'
    })
    const html = '<iconify-icon icon="mdi:trap"></iconify-icon>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.doesNotMatch(result.render, /javascript:/i)
    assert.doesNotMatch(result.render, /\shref=/)
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

/*
 * `applyPermissionPlaceholders`'s own unit coverage lives in `helpers/htmlSanitizePolicy.test.ts`;
 * what belongs here is that `postProcess` wires it in ahead of the real `sanitizeHtml()` pass, so a
 * tag stripped for a missing permission leaves a visible callout rather than silently vanishing.
 */
describe('rendering.postProcess: fence line rows survive sanitization (OpenProject #3578)', () => {
  const fence =
    '<pre class="codeblock hljs line-numbers" data-line-start="30"><code class="language-yaml">a\nb\nc\n' +
    '<span aria-hidden="true" class="line-numbers-rows"><span></span><span class="is-highlighted"></span><span></span></span></code></pre>'

  test('keeps is-highlighted rows, the line-numbers class and data-line-start without write:styles', async () => {
    const result = await rendering.postProcess('site-1', fence, { scripts: false, styles: false })

    assert.match(result.render, /<pre class="codeblock hljs line-numbers" data-line-start="30">/)
    assert.match(result.render, /<span aria-hidden="true" class="line-numbers-rows">/)
    assert.match(
      result.render,
      /<span><\/span><span class="is-highlighted"><\/span><span><\/span><\/span><\/code><\/pre>/
    )
  })

  test('strips the inline custom property that data-line-start replaces, so the pin is not a tautology', async () => {
    const result = await rendering.postProcess(
      'site-1',
      '<pre class="codeblock hljs line-numbers" style="--code-line-start: 29"><code>a</code></pre>',
      { scripts: false, styles: false }
    )

    assert.doesNotMatch(result.render, /--code-line-start/)
  })
})

describe('rendering.postProcess: fence title bar survives sanitization (OpenProject #3583)', () => {
  const titled =
    '<div class="codeblock-titled hljs"><div class="codeblock-title">config.yml</div>' +
    '<pre class="codeblock hljs line-numbers" data-line-start="3"><code class="language-yaml">a\nb\nc\n' +
    '<span aria-hidden="true" class="line-numbers-rows"><span></span><span class="is-highlighted"></span><span></span></span></code></pre></div>'

  test('keeps .codeblock-titled, .codeblock-title and the sibling pre without write:styles or write:scripts', async () => {
    const result = await rendering.postProcess('site-1', titled, { scripts: false, styles: false })

    assert.match(
      result.render,
      /<div class="codeblock-titled hljs"><div class="codeblock-title">config\.yml<\/div><pre class="codeblock hljs line-numbers" data-line-start="3">/
    )
    assert.match(result.render, /<\/code><\/pre><\/div>/)
  })

  test('keeps an escaped title inert', async () => {
    const result = await rendering.postProcess(
      'site-1',
      '<div class="codeblock-titled hljs"><div class="codeblock-title">&lt;script&gt;alert(1)&lt;/script&gt;</div><pre class="codeblock hljs"><code class="language-yaml">a</code></pre></div>',
      { scripts: false, styles: false }
    )

    assert.doesNotMatch(result.render, /<script/)
    assert.match(
      result.render,
      /<div class="codeblock-title">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/div>/
    )
  })
})

describe('rendering.postProcess: visible callout for a permission-gated tag (OpenProject #2911)', () => {
  test('replaces an <iframe> with a "write:scripts" callout when the actor lacks the permission', async () => {
    const html = '<p>before</p><iframe src="https://example.com"></iframe><p>after</p>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.doesNotMatch(result.render, /<iframe/)
    assert.match(result.render, /<blockquote class="is-danger">/)
    assert.match(result.render, /<p class="alert-title">Caution<\/p>/)
    assert.match(result.render, /write:scripts permission and was not rendered/)
    assert.match(result.render, /<p>before<\/p>/)
    assert.match(result.render, /<p>after<\/p>/)
  })

  test('replaces a <script> with the same "write:scripts" callout when the actor lacks the permission', async () => {
    const html = '<script>alert(1)</script>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.doesNotMatch(result.render, /<script/)
    assert.doesNotMatch(result.render, /alert\(1\)/)
    assert.match(result.render, /write:scripts permission and was not rendered/)
  })

  test('replaces a <style> with a "write:styles" callout when the actor lacks that permission', async () => {
    const html = '<style>body { color: red; }</style>'

    const result = await rendering.postProcess('site-1', html, { scripts: false, styles: false })

    assert.doesNotMatch(result.render, /<style/)
    assert.match(result.render, /write:styles permission and was not rendered/)
  })

  test('leaves an <iframe> and a <style> alone -- no callout -- when the actor holds both permissions', async () => {
    const html = '<iframe src="https://example.com"></iframe><style>body { color: red; }</style>'

    const result = await rendering.postProcess('site-1', html, { scripts: true, styles: true })

    assert.match(result.render, /<iframe src="https:\/\/example\.com">/)
    assert.match(result.render, /<style>/)
    assert.match(result.render, /color:\s*red/)
    assert.doesNotMatch(result.render, /alert-title/)
  })
})

/*
 * The scheme-filtering logic itself is `helpers/htmlSanitizePolicy.test.ts`'s to cover -- what
 * belongs here is only that this model reaches for the right site's `allowedUrlSchemes` config key,
 * and that a site without one falls back to the defaults.
 */
describe('rendering.postProcess: site-configured allowedUrlSchemes (OpenProject #2459)', () => {
  test('a link using a site-configured custom scheme survives sanitization', async () => {
    CARDINAL.sites['site-with-schemes'] = makeSite({
      id: 'site-with-schemes',
      config: { allowedUrlSchemes: ['discord'] }
    })

    const result = await rendering.postProcess(
      'site-with-schemes',
      '<a href="discord://channel/123">Join</a>',
      { scripts: false, styles: false }
    )

    assert.match(result.render, /href="discord:\/\/channel\/123"/)
  })

  test('a site with no allowedUrlSchemes config still strips a non-default scheme, unchanged', async () => {
    CARDINAL.sites['site-no-config'] = makeSite({ id: 'site-no-config' })

    const result = await rendering.postProcess(
      'site-no-config',
      '<a href="discord://channel/123">Join</a>',
      { scripts: false, styles: false }
    )

    assert.doesNotMatch(result.render, /href="discord:/)
  })

  test('a siteId with no CARDINAL.sites entry at all behaves identically to the hardcoded defaults', async () => {
    const result = await rendering.postProcess(
      'site-entirely-unknown-to-wiki-sites',
      '<a href="discord://channel/123">Join</a><a href="https://example.com">x</a>',
      { scripts: false, styles: false }
    )

    assert.doesNotMatch(result.render, /href="discord:/)
    assert.match(result.render, /href="https:\/\/example\.com"/)
  })
})
