import { afterEach, describe, expect, it } from 'vitest'

import { PACKAGES } from './component.js'
import './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/**
 * Appends a `<block-mathjax>` carrying `source` as its light-DOM body (the way the wiki's own
 * markdown renderer leaves it for an unfenced call — see block-gallery's component.test.js for the
 * precedent) and waits for Lit's first render.
 */
const mountMathjax = (source) => mountBlock('block-mathjax', { text: source })

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
    to the list can't silently drop one of them. See docs/variances.md for the full audit.
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
    A gap this audit found that PACKAGES membership does not capture: extpfeil is in PACKAGES (and
    was reachable in 2.5.x), but its extensible arrows are drawn from a font chunk
    (@mathjax/mathjax-newcm-font's "dynamic/arrows") that MathJax fetches through a
    `mathjax.asyncLoad` hook this block never configures — 2.5.x could reach it because it ran
    server-side in Node with filesystem `require` access; this block runs in the browser from a
    static bundle with nothing to fetch that chunk from. Declaring the package is therefore not
    sufficient for every macro in it. Recorded in full in docs/variances.md; this test pins the
    current (broken) behavior rather than silently accepting or silently "fixing" it per one line
    short of a real fix (wiring asyncLoad is a bundling change, out of scope for this audit task) —
    update it if a future task wires the dynamic chunks up.
  */
  it('KNOWN GAP: extpfeil arrows fail — their glyphs need a font chunk this block never wires up', async () => {
    const el = await mountMathjax(String.raw`\xtwoheadrightarrow{f}`)

    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  describeDarkMode(() => mountMathjax(String.raw`x = y`))
})
