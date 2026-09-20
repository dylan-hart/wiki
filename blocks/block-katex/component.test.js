import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

beforeAll(async () => {
  /*
    jsdom leaves `document.adoptedStyleSheets` undefined (github.com/jsdom/jsdom/issues/2925) and
    `component.js` spreads it at module scope, so it must exist before the deferred import below
    evaluates or the spread throws "not iterable".
  */
  document.adoptedStyleSheets ??= []
  await import('./component.js')
})

const mountKatexFenced = (source) => mountBlock('block-katex', { pre: source })

const mountKatexUnfenced = (source) => mountBlock('block-katex', { text: source })

describe('block-katex', () => {
  afterEach(resetBlockDom)

  it('typesets a valid formula into the shadow tree with no error shown', async () => {
    const el = await mountKatexFenced('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const drawing = el.shadowRoot.querySelector('.drawing')
    expect(drawing).not.toBeNull()
    expect(drawing.querySelector('.katex')).not.toBeNull()
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

  it('typesets mhchem, the one extension 2.5.x also carried, from an unfenced body', async () => {
    const el = await mountKatexUnfenced(String.raw`\ce{CO2 + C -> 2 CO}`)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('.drawing .katex')).not.toBeNull()
  })

  /*
    KaTeX has no bbox extension, contrib or built-in, so source that typesets in block-mathjax
    reaches this block's error panel instead.
  */
  it('KNOWN ENGINE LIMIT: \\bbox is not a KaTeX construct', async () => {
    const el = await mountKatexUnfenced(String.raw`\bbox[red]{x+y}`)

    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  describeDarkMode(() => mountKatexFenced('x = y'))
})
