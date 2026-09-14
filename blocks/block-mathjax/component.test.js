import { afterEach, describe, expect, it } from 'vitest'

import { PACKAGES } from './component.js'
import './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/**
 * Appends a `<block-mathjax>` carrying `source` as its light-DOM body (the way the wiki's own
 * markdown renderer leaves it for an unfenced call — see block-gallery's component.test.js for the
 * precedent) and waits for Lit's first render, then for typesetting itself to finish -- which, for a
 * formula needing a dynamic glyph chunk, includes the `mathjax.asyncLoad` round trip. `el._ready` is
 * the handle `firstUpdated()` keeps for exactly this, the same pattern `shared/diagram-image.js` uses
 * for the two diagram blocks' own async draw.
 */
const mountMathjax = (source) =>
  mountBlock('block-mathjax', { text: source, settle: (el) => el._ready })

describe('block-mathjax', () => {
  afterEach(resetBlockDom)

  /*
    Feature 366 / Task 634 audited PACKAGES against 2.5.x's actual MathJax setup
    (server/modules/rendering/markdown-mathjax/renderer.js, pre-3.x): its explicit `extensions` list
    plus everything MathJax's own `autoload` package could reach from the default `input/tex` bundle
    it loaded (AutoloadConfiguration.ts's `autoload` map — action, amscd, bbox, boldsymbol, braket,
    bussproofs, cancel, color, enclose, extpfeil, html, mhchem, newcommand, unicode, verb). `html` is
    the one deliberate exclusion (documented at component.js:10-23, unchanged by this task). Every
    other package 2.5.x could reach must stay in PACKAGES — this pins that finding so a future edit
    to the list can't silently drop one of them.
  */
  it('is a superset of every TeX package 2.5.x content could reach', () => {
    const reachableIn25x = [
      'base',
      'action',
      'ams',
      'amscd',
      'bbox',
      'boldsymbol',
      'braket',
      'bussproofs',
      'cancel',
      'color',
      'enclose',
      'extpfeil',
      'mhchem',
      'newcommand',
      'unicode',
      'verb'
    ]
    for (const pkg of reachableIn25x) {
      expect(PACKAGES).toContain(pkg)
    }
  })

  it('typesets mhchem, the one contrib extension 2.5.x also carried', async () => {
    const el = await mountMathjax(String.raw`\ce{CO2 + C -> 2 CO}`)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('.drawing svg')).not.toBeNull()
  })

  it('typesets cancel, one of the packages reachable only through 2.5.x autoload', async () => {
    const el = await mountMathjax(String.raw`\cancel{x+y}`)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('.drawing svg')).not.toBeNull()
  })

  /*
    extpfeil is in PACKAGES (and was reachable in 2.5.x), but its extensible arrows are drawn from a
    font chunk (@mathjax/mathjax-newcm-font's svg/dynamic/arrows) that MathJax fetches through a
    `mathjax.asyncLoad` hook — declaring the package alone was never sufficient for these three
    macros. OpenProject #3190 wired that hook up (component.js's `mathjax.asyncLoad` + the literal
    `import()`s in dynamicChunks.js), so this now pins the fixed behavior instead of the previously
    broken one.
  */
  it('typesets extpfeil, whose extensible arrows load a dynamic font chunk', async () => {
    const rightarrow = await mountMathjax(String.raw`\xtwoheadrightarrow{f}`)
    expect(rightarrow.shadowRoot.querySelector('.error')).toBeNull()
    expect(rightarrow.shadowRoot.querySelector('.drawing svg')).not.toBeNull()

    const leftarrow = await mountMathjax(String.raw`\xtwoheadleftarrow{f}`)
    expect(leftarrow.shadowRoot.querySelector('.error')).toBeNull()
    expect(leftarrow.shadowRoot.querySelector('.drawing svg')).not.toBeNull()

    const mapsto = await mountMathjax(String.raw`\xmapsto{f}`)
    expect(mapsto.shadowRoot.querySelector('.error')).toBeNull()
    expect(mapsto.shadowRoot.querySelector('.drawing svg')).not.toBeNull()
  })

  /*
    \verb draws from the font's monospace dynamic chunk — a second, independent glyph range from
    extpfeil's, and one 2.5.x's autoload map could also reach.
  */
  it('typesets \\verb, whose monospace glyphs load a dynamic font chunk', async () => {
    const el = await mountMathjax(String.raw`\verb|x+y|`)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('.drawing svg')).not.toBeNull()
  })

  /*
    An accented Latin character and a non-Latin one, each drawn from their own dynamic chunk
    (accents-b-i and cyrillic respectively) rather than the base bundle -- the third acceptance case
    #3190 names alongside extpfeil and \verb.
  */
  it('typesets an accented Latin character from a dynamic font chunk', async () => {
    const el = await mountMathjax(String.raw`\text{café}`)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('.drawing svg')).not.toBeNull()
  })

  it('typesets a non-Latin Unicode character from a dynamic font chunk', async () => {
    const el = await mountMathjax(String.raw`\text{Привет}`)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('.drawing svg')).not.toBeNull()
  })

  describeDarkMode(() => mountMathjax(String.raw`x = y`))
})
