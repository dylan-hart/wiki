import { afterEach, describe, expect, it } from 'vitest'

import './component.js'

/**
 * Appends a `<block-katex>` carrying `source` as its light-DOM body (the way the wiki's own
 * markdown renderer leaves it for an unfenced call — see block-gallery's component.test.js for the
 * precedent) and waits for Lit's first render.
 */
async function mountKatex(source) {
  const el = document.createElement('block-katex')
  el.textContent = source
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-katex', () => {
  afterEach(() => {
    document.body.replaceChildren()
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
  it('typesets mhchem, the one extension 2.5.x also carried', async () => {
    const el = await mountKatex(String.raw`\ce{CO2 + C -> 2 CO}`)

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
    const el = await mountKatex(String.raw`\bbox[red]{x+y}`)

    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
  })
})
