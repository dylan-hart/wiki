import { afterEach, describe, expect, it } from 'vitest'

import { PACKAGES } from './component.js'
import './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/**
 * `text` is the body shape the markdown renderer leaves for an unfenced call; `el._ready` waits out
 * the typeset, which for a formula needing a glyph chunk includes the `mathjax.asyncLoad` round trip.
 */
const mountMathjax = (source) =>
  mountBlock('block-mathjax', { text: source, settle: (el) => el._ready })

describe('block-mathjax', () => {
  afterEach(resetBlockDom)

  /*
    The reachable set is 2.5.x's own `extensions` list plus whatever MathJax's `autoload` map could
    pull from the `input/tex` bundle it loaded. `html` is in that set but is the one package
    component.js deliberately leaves out, so it is absent here too.
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
    Declaring extpfeil is not enough for these three macros: their arrows are drawn from a font chunk
    (svg/dynamic/arrows) that only arrives through the `mathjax.asyncLoad` hook.
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

  // A second glyph range, independent of extpfeil's.
  it('typesets \\verb, whose monospace glyphs load a dynamic font chunk', async () => {
    const el = await mountMathjax(String.raw`\verb|x+y|`)

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    expect(el.shadowRoot.querySelector('.drawing svg')).not.toBeNull()
  })

  // Two further independent ranges: accents-b-i and cyrillic.
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
