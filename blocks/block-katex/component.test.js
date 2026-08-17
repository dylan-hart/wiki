import { afterEach, beforeAll, describe, expect, it } from 'vitest'

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
async function mountKatex(source) {
  const el = document.createElement('block-katex')
  const pre = document.createElement('pre')
  pre.textContent = source
  el.appendChild(pre)
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-katex', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  /*
    Regression coverage for bumping the `katex` dependency (0.18.2 -> 0.18.4): a formula that
    typesets cleanly, and one that KaTeX rejects, both need to keep behaving the same way across the
    bump — this locks in that a valid formula still renders and an invalid one still reports an error
    rather than throwing out of the component.
  */
  it('typesets a valid formula into the shadow tree with no error shown', async () => {
    const el = await mountKatex('x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const drawing = el.shadowRoot.querySelector('.drawing')
    expect(drawing).not.toBeNull()
    expect(drawing.querySelector('.katex')).not.toBeNull()
    // -> Both output forms KaTeX writes: the visual drawing and the MathML a screen reader announces
    expect(drawing.querySelector('.katex-mathml')).not.toBeNull()
    expect(drawing.querySelector('.katex-html')).not.toBeNull()
  })

  it('typesets a chemical equation through the mhchem macros', async () => {
    const el = await mountKatex('\\ce{CO2 + C -> 2 CO}')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('.drawing .katex')).not.toBeNull()
  })

  it('shows an error panel, not a thrown exception, for a formula KaTeX cannot parse', async () => {
    const el = await mountKatex('\\frac{1}{')

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('This formula could not be typeset')
    expect(el.shadowRoot.querySelector('.drawing')).toBeNull()
  })
})
