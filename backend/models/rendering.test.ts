import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { rendering } from './rendering.ts'

/**
 * `sanitize()` is what a page's HTML has to survive to be stored -- and since Task 624
 * (`renderers/markdown.js`'s `$…$`/`$$…$$` TeX authoring) resolves straight to literal KaTeX
 * HTML/MathML at render time, that markup is now something a real page can carry, not just something
 * `block-katex` draws inside a shadow root the sanitiser never sees.
 *
 * `sanitize()`'s block-allowance pass reads `WIKI.models.blocks.definitions`; no page block is
 * involved in typesetting a formula, so the smallest stub that satisfies it is an empty list -- same
 * "smallest object satisfying the methods the code path under test actually calls" convention as
 * `test/mocks.ts`.
 */
;(globalThis as any).WIKI = { models: { blocks: { definitions: [] } } }

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
