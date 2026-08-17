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
