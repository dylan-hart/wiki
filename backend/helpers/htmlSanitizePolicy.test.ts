import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import sanitizeHtml from 'sanitize-html'
import { blockAllowances, mergeAllowedSchemes, sanitizeOptions } from './htmlSanitizePolicy.ts'
import { installTestWiki } from '../test/mocks.ts'
import type { RenderPermissions } from './htmlSanitizePolicy.ts'

/*
 * The policy half of what a save runs through: `sanitizeOptions()` fed straight to `sanitize-html`,
 * with no `postProcess` pipeline around it (that half lives in `models/rendering.test.ts`). Nothing
 * here reaches the database, and the one real dependency is `WIKI.models.blocks.definitions` --
 * `blockAllowances()` reads it to widen the allowlist per enabled block. None of these cases is about
 * a block, so the manifest is empty and every call passes an empty enabled set: what they are about is
 * the static tag/attribute/style allowlists underneath it.
 */
const wiki = installTestWiki({
  models: {
    blocks: {
      definitions: []
    }
  }
})
after(() => wiki.restore())

/**
 * What the model's own `sanitize()` used to be: `sanitizeOptions()` fed straight to `sanitize-html`.
 *
 * The model no longer carries that wrapper -- `postProcess` calls `sanitizeOptions()` directly so its
 * two passes share one options object, and nothing but this file ever wanted the one-shot form.
 *
 * `permissions` is `Partial` because these tests only ever name the flag under test: `sanitizeOptions`
 * reads each one for truthiness, so an omitted flag behaves exactly like `false`.
 */
function sanitize(
  html: string,
  permissions: Partial<RenderPermissions>,
  enabledBlockKeys: Set<string>,
  additionalSchemes: string[] = []
): string {
  return sanitizeHtml(
    html,
    sanitizeOptions(
      permissions as RenderPermissions,
      blockAllowances(enabledBlockKeys, []),
      additionalSchemes
    )
  )
}

/**
 * Sanitization is what a page's HTML has to survive to be stored -- and since Task 624
 * (`renderers/markdown.js`'s `$…$`/`$$…$$` TeX authoring) resolves straight to literal KaTeX
 * HTML/MathML at render time, that markup is now something a real page can carry, not just something
 * `block-katex` draws inside a shadow root the sanitiser never sees.
 */

describe('sanitizeOptions -- KaTeX MathML from inline TeX authoring', () => {
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

    const clean = sanitize(html, {}, new Set())

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
  makes) -- not reconstructed by hand. Both come back from sanitization with their `<math>…</math>`
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
describe('sanitizeOptions -- KaTeX MathML from mhchem (\\ce{}/\\pu{})', () => {
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

    const clean = sanitize(`<p>${math}</p>`, {}, new Set())

    assert.ok(clean.includes(math), 'the whole <math>…</math> survived sanitization unchanged')
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

    const clean = sanitize(`<p>${math}</p>`, {}, new Set())

    assert.ok(clean.includes(math), 'the whole <math>…</math> survived sanitization unchanged')
  })
})

/**
 * OpenProject #1360/#2180 (2026-08-24 security audit §3): `style` was in `BASE_ALLOWED_ATTRIBUTES`
 * unconditionally, with no declaration-level filtering — `sanitizeHtml`'s `allowedStyles` was simply
 * never passed, so any CSS survived verbatim on any element regardless of `write:styles`. An author
 * without the permission could write `style="position:fixed;inset:0;z-index:999"` and cover the
 * whole viewport from inside ordinary page content, since nothing about a scroll container's own
 * ancestor chain clips a `position: fixed` box. `permissions: {}` throughout (no `styles: true`) is
 * the author-without-`write:styles` case these tests are about.
 */
describe('sanitizeOptions -- allowedStyles (OpenProject #2180)', () => {
  test('drops position:fixed, inset and z-index for an author without write:styles', () => {
    const html = '<div style="position:fixed;inset:0;z-index:999;color:red;">x</div>'
    const clean = sanitize(html, {}, new Set())

    assert.doesNotMatch(clean, /position:\s*fixed/)
    assert.doesNotMatch(clean, /inset/)
    assert.doesNotMatch(clean, /z-index/)
    // -> Not a blanket style strip: an unrelated, harmless declaration on the very same attribute
    //    survives, proving this is allowlist filtering rather than a `style`-attribute-wide gate.
    assert.match(clean, /color:\s*red/)
  })

  test('drops position:absolute and position:sticky the same way as fixed', () => {
    for (const value of ['absolute', 'sticky']) {
      const clean = sanitize(`<div style="position:${value};">x</div>`, {}, new Set())
      assert.doesNotMatch(clean, new RegExp(`position:\\s*${value}`))
    }
  })

  test('keeps position:relative, real KaTeX output (verified against katex.renderToString)', () => {
    const clean = sanitize('<span style="position:relative;">x</span>', {}, new Set())
    assert.match(clean, /position:\s*relative/)
  })

  test('drops transform, opacity, pointer-events and content', () => {
    const html =
      '<div style="transform:scale(2);opacity:0.5;pointer-events:none;content:\'x\';top:1em;">x</div>'
    const clean = sanitize(html, {}, new Set())

    assert.doesNotMatch(clean, /transform/)
    assert.doesNotMatch(clean, /opacity/)
    assert.doesNotMatch(clean, /pointer-events/)
    assert.doesNotMatch(clean, /content/)
    // -> `top` alone (no `position: fixed`) is inert layout-wise and is real KaTeX output, so it
    //    survives.
    assert.match(clean, /top:\s*1em/)
  })

  test('keeps every declaration a real katex.renderToString({ output: "html" }) run emits', () => {
    /*
      Captured from a real KaTeX 0.16 `renderToString('\\frac{a}{b} + x^2 - \\sqrt{y}', { output:
      'html' })` run (frontend/blocks dependency; not importable from backend, so the exact
      declarations are reproduced here as a fixture) -- the same style the audit asked this task to
      validate against, covering fractions, roots, exponents, and the negative-em offsets KaTeX
      relies on throughout.
    */
    const declarations = [
      'height:1.0404em;vertical-align:-0.345em;',
      'height:0.6954em;',
      'top:-2.655em;',
      'height:3em;',
      'border-bottom-width:0.04em;',
      'top:-3.23em;',
      'top:-3.394em;',
      'height:0.345em;',
      'margin-right:0.2222em;',
      'height:0.8974em;vertical-align:-0.0833em;',
      'height:0.8141em;',
      'top:-3.063em;margin-right:0.05em;',
      'height:2.7em;',
      'height:1.04em;vertical-align:-0.3369em;',
      'height:0.7031em;',
      'top:-3em;',
      'padding-left:0.833em;',
      'margin-right:0.0359em;',
      'top:-2.6631em;',
      'min-width:0.853em;height:1.08em;'
    ]
    for (const style of declarations) {
      const clean = sanitize(`<span style="${style}">x</span>`, {}, new Set())
      for (const decl of style.split(';').filter(Boolean)) {
        const [prop, value] = decl.split(':')
        assert.match(
          clean,
          new RegExp(`${prop}:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
          `expected "${decl}" to survive sanitization unchanged`
        )
      }
    }
  })

  test('an author with write:styles is not filtered at all -- style="…" survives verbatim', () => {
    const html = '<div style="position:fixed;inset:0;z-index:999;">x</div>'
    const clean = sanitize(html, { styles: true }, new Set())

    assert.match(clean, /position:\s*fixed/)
    assert.match(clean, /inset/)
    assert.match(clean, /z-index/)
  })
})

/**
 * OpenProject #2183: `sanitizeOptions()` now passes `allowedStyles` to `sanitize-html`, gating which inline
 * `style` *declarations* survive (not just whether the attribute itself is present) on `write:styles`
 * -- `position: fixed` with no clipping ancestor is what lets an author without the permission cover
 * the viewport or hide content from readers while it stays in the source and search index.
 */
describe('sanitizeOptions -- allowedStyles gates inline CSS by write:styles (OpenProject #2183)', () => {
  test('drops position/inset/z-index declarations for an author without write:styles, keeping an unrelated color declaration', () => {
    const html = '<div style="position: fixed; inset: 0; z-index: 9999; color: red;">x</div>'

    const clean = sanitize(html, { scripts: false, styles: false }, new Set())

    assert.doesNotMatch(clean, /position/)
    assert.doesNotMatch(clean, /inset/)
    assert.doesNotMatch(clean, /z-index/)
    assert.match(clean, /color:\s*red/)
  })

  test('keeps position/inset/z-index declarations for an author with write:styles', () => {
    const html = '<div style="position: fixed; inset: 0; z-index: 9999; color: red;">x</div>'

    const clean = sanitize(html, { scripts: false, styles: true }, new Set())

    assert.match(clean, /position:\s*fixed/)
    assert.match(clean, /inset:\s*0/)
    assert.match(clean, /z-index:\s*9999/)
    assert.match(clean, /color:\s*red/)
  })

  test('keeps the KaTeX-sized safe properties for an author without write:styles, so no formula loses its layout', () => {
    // -> The shape KaTeX actually writes onto formula spans: sizing, fine positioning within a
    //    relatively-positioned ancestor, and colour -- none of it needs `write:styles` to render.
    const html =
      '<span style="height: 0.8em; width: 1.2em; margin-right: 0.05em; ' +
      'padding-left: 0.1em; top: -0.3em; left: 0.02em; vertical-align: -0.2em; ' +
      'font-size: 1.2em; border-color: red; background-color: yellow; text-align: center;">x</span>'

    const clean = sanitize(html, { scripts: false, styles: false }, new Set())

    for (const declaration of [
      'height:0.8em',
      'width:1.2em',
      'margin-right:0.05em',
      'padding-left:0.1em',
      'top:-0.3em',
      'left:0.02em',
      'vertical-align:-0.2em',
      'font-size:1.2em',
      'border-color:red',
      'background-color:yellow',
      'text-align:center'
    ]) {
      assert.ok(clean.includes(declaration), `expected "${declaration}" to survive, got: ${clean}`)
    }
  })

  test('drops the style attribute entirely once every declaration it carried is disallowed', () => {
    const html = '<div style="position: fixed; transform: translateX(10px);">x</div>'

    const clean = sanitize(html, { scripts: false, styles: false }, new Set())

    assert.doesNotMatch(clean, /style=/)
  })
})

/**
 * OpenProject #2458 (part of Feature #2418's "Admin-configurable allowed URL schemes for page
 * links"): the categorical block. A site's admin-configured `allowedUrlSchemes` setting (wired
 * through by #2459, see the describe below) must never be able to smuggle `javascript:`, `vbscript:`,
 * or a non-img `data:` back into the sanitizer's allowlist. These tests exercise `mergeAllowedSchemes()`
 * directly (the one function allowed to produce `allowedSchemes`/`allowedSchemesByTag`) and
 * `sanitizeOptions()`'s threading of it.
 */
describe('mergeAllowedSchemes -- categorical block (OpenProject #2458)', () => {
  test('refuses javascript, vbscript and data regardless of case, whitespace or a trailing colon', () => {
    const merged = mergeAllowedSchemes([
      'javascript',
      'javascript:',
      'JavaScript:',
      '  javascript  ',
      'vbscript',
      'VBScript:',
      'data',
      'DATA:'
    ])

    for (const forbidden of ['javascript', 'vbscript', 'data']) {
      assert.ok(
        !merged.includes(forbidden),
        `expected "${forbidden}" to be refused, got: ${merged}`
      )
    }
  })

  test('keeps data allowed only when allowData is set, and javascript/vbscript refused either way', () => {
    const withoutImg = mergeAllowedSchemes(['data', 'javascript', 'vbscript'])
    const withImg = mergeAllowedSchemes(['data', 'javascript', 'vbscript'], { allowData: true })

    assert.ok(!withoutImg.includes('data'))
    assert.ok(withImg.includes('data'))
    assert.ok(!withImg.includes('javascript'))
    assert.ok(!withImg.includes('vbscript'))
  })

  test('lets a legitimate custom scheme through, deduplicated against the hardcoded defaults', () => {
    const merged = mergeAllowedSchemes(['discord', 'discord:', 'HTTPS:'])

    assert.ok(merged.includes('discord'))
    assert.equal(merged.filter((s) => s === 'discord').length, 1)
    assert.equal(merged.filter((s) => s === 'https').length, 1)
  })

  test('always keeps the hardcoded defaults regardless of what additionalSchemes contains', () => {
    const merged = mergeAllowedSchemes(['javascript', 'vbscript', 'data'])

    for (const expected of ['http', 'https', 'mailto', 'tel', 'ftp']) {
      assert.ok(merged.includes(expected))
    }
  })

  test('drops an empty or whitespace-only entry silently rather than allowing an empty scheme', () => {
    const merged = mergeAllowedSchemes(['', '   ', ':'])

    assert.deepEqual(merged.sort(), ['ftp', 'http', 'https', 'mailto', 'tel'].sort())
  })
})

describe('sanitizeOptions -- additionalSchemes threading (OpenProject #2458)', () => {
  test('an admin-configured javascript: scheme still gets stripped from an <a href>', () => {
    const html = '<a href="javascript:alert(1)">click</a>'

    const clean = sanitize(html, {}, new Set(), ['javascript'])

    assert.doesNotMatch(clean, /javascript:/)
    assert.doesNotMatch(clean, /href=/)
  })

  test('an admin-configured data: scheme still gets stripped from an <a href>, but a real link scheme survives', () => {
    const html =
      '<a href="data:text/html,<script>alert(1)</script>">bad</a>' +
      '<a href="discord://invite/abc">good</a>'

    const clean = sanitize(html, {}, new Set(), ['data', 'discord'])

    assert.doesNotMatch(clean, /data:text\/html/)
    assert.match(clean, /href="discord:\/\/invite\/abc"/)
  })

  test('data: survives on img when admin-configured, since img is the one legitimate use', () => {
    const html = '<img src="data:image/png;base64,AAAA">'

    const clean = sanitize(html, {}, new Set(), ['data'])

    assert.match(clean, /src="data:image\/png;base64,AAAA"/)
  })

  test("an unrelated caller passing no additionalSchemes keeps today's exact behavior", () => {
    const html = '<a href="https://example.com">ok</a><a href="javascript:alert(1)">bad</a>'

    const clean = sanitize(html, {}, new Set())

    assert.match(clean, /href="https:\/\/example\.com"/)
    assert.doesNotMatch(clean, /javascript:/)
  })
})

/*
 * OpenProject #2459 (Feature #2418's Scope): a site's admin-configured `allowedUrlSchemes` is wired
 * into `allowedSchemes`/`allowedSchemesByTag.img` here, additive to the hardcoded `ALLOWED_SCHEMES`
 * floor -- never a replacement for it, and never able to smuggle in the categorically blocked
 * schemes `#2458` owns enforcing canonically.
 */
describe('sanitizeOptions -- admin-configured allowedUrlSchemes (OpenProject #2459)', () => {
  function sanitizeWithSchemes(html: string, allowedUrlSchemes: string[]): string {
    return sanitizeHtml(
      html,
      sanitizeOptions(
        { scripts: false, styles: false },
        blockAllowances(new Set(), []),
        allowedUrlSchemes
      )
    )
  }

  test('a hardcoded-default scheme link survives with no site config at all', () => {
    const clean = sanitizeHtml(
      '<a href="https://example.com">x</a>',
      sanitizeOptions({ scripts: false, styles: false }, blockAllowances(new Set(), []))
    )

    assert.match(clean, /href="https:\/\/example\.com"/)
  })

  test('a configured custom scheme link survives sanitization', () => {
    const clean = sanitizeWithSchemes('<a href="discord://channel/123">Join</a>', ['discord'])

    assert.match(clean, /href="discord:\/\/channel\/123"/)
  })

  test('an unconfigured custom scheme link is still stripped', () => {
    const clean = sanitizeWithSchemes('<a href="steam://run/123">Play</a>', ['discord'])

    assert.doesNotMatch(clean, /href="steam:/)
  })

  test('a configured scheme is honored for img too, alongside the hardcoded data: allowance', () => {
    const clean = sanitizeWithSchemes(
      '<img src="myapp://icon.png"><img src="data:image/png;base64,AAAA">',
      ['myapp']
    )

    assert.match(clean, /src="myapp:\/\/icon\.png"/)
    assert.match(clean, /src="data:image\/png;base64,AAAA"/)
  })

  for (const dangerous of ['javascript', 'vbscript', 'data', 'JavaScript', 'VBScript']) {
    test(`"${dangerous}" in config never becomes an allowed scheme`, () => {
      const clean = sanitizeWithSchemes(`<a href="${dangerous.toLowerCase()}:alert(1)">x</a>`, [
        dangerous
      ])

      assert.doesNotMatch(clean, new RegExp(`href="${dangerous.toLowerCase()}:`, 'i'))
    })
  }

  test('"data" in config does not widen the img allowance beyond what is already unconditional', () => {
    const clean = sanitizeWithSchemes('<img src="data:image/png;base64,AAAA">', ['data'])

    // -> Already allowed for img regardless of config -- proving the denylist entry is a no-op here,
    //    not that it silently broke the pre-existing allowance
    assert.match(clean, /src="data:image\/png;base64,AAAA"/)
  })

  test('a configured scheme already in the hardcoded defaults does not duplicate in the option list', () => {
    const options = sanitizeOptions(
      { scripts: false, styles: false },
      blockAllowances(new Set(), []),
      ['https', 'HTTPS', 'discord']
    )

    const schemes = (options.allowedSchemes as string[] | undefined) ?? []
    assert.equal(schemes.filter((s) => s === 'https').length, 1)
    assert.ok(schemes.includes('discord'))
  })

  test('blank/whitespace-only configured entries are ignored', () => {
    const options = sanitizeOptions(
      { scripts: false, styles: false },
      blockAllowances(new Set(), []),
      ['', '   ', 'discord']
    )

    const schemes = (options.allowedSchemes as string[] | undefined) ?? []
    assert.deepEqual(
      schemes.filter((s) => !['http', 'https', 'mailto', 'tel', 'ftp'].includes(s)),
      ['discord']
    )
  })
})
