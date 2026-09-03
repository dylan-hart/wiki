import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

beforeAll(async () => {
  /*
    jsdom does not implement `document.adoptedStyleSheets` (github.com/jsdom/jsdom/issues/2925): the
    property is simply `undefined` rather than an empty array. `component.js` spreads it into a new
    array as a module-scope side effect, to install KaTeX's `@font-face` rule the moment the module
    loads — so that has to exist before the (dynamic, hence deferred until this line runs) import
    below evaluates it, or the spread throws "not iterable".
  */
  document.adoptedStyleSheets ??= []
  await import('./component.js')
})

/**
 * Appends a `<block-katex>` carrying `source` inside a fenced code block, the way the wiki's own
 * markdown renderer leaves a fence's contents — exactly as typed, undoing markdown's own escaping.
 */
const mountKatexFenced = (source) => mountBlock('block-katex', { pre: source })

/**
 * Appends a `<block-katex>` carrying `source` as its light-DOM body directly (the way the wiki's own
 * markdown renderer leaves it for an unfenced call — see block-gallery's component.test.js for the
 * precedent), exercising `firstUpdated()`'s `fence ?? this` fallback for a call with no `<pre>` at all.
 */
const mountKatexUnfenced = (source) => mountBlock('block-katex', { text: source })

describe('block-katex', () => {
  afterEach(resetBlockDom)

  /*
    Regression coverage for bumping the `katex` dependency (0.18.2 -> 0.18.4): a formula that
    typesets cleanly, and one that KaTeX rejects, both need to keep behaving the same way across the
    bump — this locks in that a valid formula still renders and an invalid one still reports an error
    rather than throwing out of the component.
  */
  it('typesets a valid formula into the shadow tree with no error shown', async () => {
    const el = await mountKatexFenced('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const drawing = el.shadowRoot.querySelector('.drawing')
    expect(drawing).not.toBeNull()
    expect(drawing.querySelector('.katex')).not.toBeNull()
    // -> Both output forms KaTeX writes: the visual drawing and the MathML a screen reader announces
    expect(drawing.querySelector('.katex-mathml')).not.toBeNull()
    expect(drawing.querySelector('.katex-html')).not.toBeNull()
  })

  it('typesets a chemical equation through the mhchem macros, from a fenced body', async () => {
    const el = await mountKatexFenced('\\ce{CO2 + C -> 2 CO}')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('.drawing .katex')).not.toBeNull()
  })

  it('shows an error panel, not a thrown exception, for a formula KaTeX cannot parse', async () => {
    const el = await mountKatexFenced('\\frac{1}{')

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('This formula could not be typeset')
    expect(el.shadowRoot.querySelector('.drawing')).toBeNull()
  })

  /*
    Feature 366 / Task 634 audited block-katex's extension surface against 2.5.x's actual KaTeX
    renderer (server/modules/rendering/markdown-katex/renderer.js, pre-3.x). 2.5.x never loaded any
    KaTeX contrib module — it vendored its own mhchem.js (a straight port of MathJax's mhchem.js,
    the same lineage KaTeX's own `katex/contrib/mhchem` was later built from) to implement \ce and
    \pu, plus a custom \tripledash macro contrib/mhchem also carries. `katex/contrib/mhchem` is
    therefore a strict, better-maintained replacement for what 2.5.x had — not a subset of it. The
    other four contrib modules KaTeX ships (auto-render, copy-tex, mathtex-script-type,
    render-a11y-string) are DOM/UX integrations, not TeX-syntax extensions, 2.5.x used none of them,
    and none would add a construct this block currently rejects. See docs/variances.md for the full
    audit and the resulting KaTeX/MathJax TeX-subset compatibility table.
  */
  it('typesets mhchem, the one extension 2.5.x also carried, from an unfenced body', async () => {
    const el = await mountKatexUnfenced(String.raw`\ce{CO2 + C -> 2 CO}`)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('.drawing .katex')).not.toBeNull()
  })

  /*
    \bbox is one of the constructs the docs/variances.md compatibility table records as
    MathJax-only: KaTeX has no bbox extension (contrib or built-in) at the pinned katex version, so
    the same source that typesets in block-mathjax reaches this block's error panel instead. Pinned
    here as the concrete, runnable form of that table entry.
  */
  it('KNOWN ENGINE LIMIT: \\bbox is not a KaTeX construct — see docs/variances.md', async () => {
    const el = await mountKatexUnfenced(String.raw`\bbox[red]{x+y}`)

    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  describeDarkMode(() => mountKatexFenced('x = y'))
})
