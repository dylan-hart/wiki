import { describe, expect, it } from 'vitest'

import { MarkdownRenderer } from './markdown.js'

/*
  Runs under Vitest, not `node --test` -- see `docs/variances.md` for why, since this file's own
  task brief assumed the opposite and the reasoning is worth not relitigating.

  `MarkdownRenderer` has no DOM dependency (confirmed by `headless.js`, which runs this same class
  server-side under Puppeteer), so these tests instantiate and render directly with no mounting, no
  `happy-dom`, and none of `test/setup.js`'s `API_CLIENT` / `EVENT_BUS` stubs.
*/

/**
 * The block-vs-fence handoff: `block-diagram`, `block-kroki`, `block-plantuml` and `block-drawio` all
 * read their source out of a `<pre>` left behind by markdown's own fence handling — never rendered or
 * escaped away, since each block draws it client-side (Mermaid, draw.io) or hands it to an image
 * server (Kroki, PlantUML). This is the one seam that is genuinely worth a unit test: it is exactly
 * what a headless re-render depends on producing byte-for-byte, and a regression here would silently
 * blank every diagram on the site without ever touching the block components themselves.
 */
describe('MarkdownRenderer fenced diagram handoff', () => {
  it.each(['mermaid', 'kroki', 'plantuml', 'drawio'])(
    'leaves a ```%s fence as an escaped <pre> for the block to read, not a rendered diagram',
    (lang) => {
      const md = new MarkdownRenderer({})
      const html = md.render(`\`\`\`${lang}\nA --> B\n\`\`\``)

      expect(html).toContain(`<pre class="codeblock-${lang}">`)
      expect(html).toContain('A --&gt; B')
      expect(html).not.toContain('A --> B')
    }
  )

  it.each(['mermaid', 'kroki', 'plantuml', 'drawio'])(
    'escapes markup written inside a ```%s fence rather than interpolating it raw',
    (lang) => {
      const md = new MarkdownRenderer({})
      const html = md.render(`\`\`\`${lang}\n<script>alert(1)</script>\n\`\`\``)

      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
    }
  )

  /*
   * `lang === 'diagram'` used to be special-cased in `highlight()`: it base64-decoded the fence body
   * and interpolated the result into `<pre class="diagram">` completely unescaped. Nothing in the app
   * ever produces a ```diagram fence — the block picker's templates and every producer of a diagram
   * fence write ```mermaid / ```kroki / ```plantuml, handled above — so the branch was dead code, and
   * dead code that skips escaping is worth actively guarding against reappearing. A ```diagram fence,
   * if one is ever typed by hand, must fall through to the same escaped, generic-code treatment as any
   * other unrecognised language.
   */
  it('treats a ```diagram fence as ordinary, escaped code rather than unescaped raw HTML', () => {
    const md = new MarkdownRenderer({})
    // -> Valid base64 for "<script>alert(1)</script>": what the old branch would have decoded and
    //    interpolated unescaped had it survived
    const html = md.render('```diagram\nPHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\n```')

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('class="diagram"')
    expect(html).toContain('language-diagram')
  })
})

describe('MarkdownRenderer - multimd-table', () => {
  /*
    Regression coverage for the fix at the `multimdTable` branch in markdown.js: the option was
    misspelled `mdmultiTable`, so the plugin was never installed, and correcting the name on its own
    made the constructor throw `md.utils.assign is not a function` -- markdown-it-multimd-table calls
    a `md.utils.assign` helper that markdown-it dropped in v14, and the plugin has had no release
    since. The shim (`this.md.utils.assign ??= Object.assign`) is what makes the corrected name safe
    to use. If either half of that regresses, these throw instead of asserting.
  */

  it('merges a ^^ rowspan cell into the row above when multimdTable is enabled', () => {
    const renderer = new MarkdownRenderer({ multimdTable: true })
    const html = renderer.render(
      [
        '| A                |||',
        '|------|------|------|',
        '| B    | C    | D    |',
        '| ^^   | E    | F    |',
        ''
      ].join('\n')
    )

    expect(html).toContain('<th colspan="3">A</th>')
    expect(html).toContain('<td rowspan="2">B</td>')
    // -> The merged cell's own row has only the two cells it actually contributes, not a `^^`
    //    placeholder for the one it inherited
    expect(html).not.toContain('^^')
  })

  it('merges a backslash-continued cell across lines into one <td> when multimdTable is enabled', () => {
    const renderer = new MarkdownRenderer({ multimdTable: true })
    const html = renderer.render(
      ['A         | B', '----------|-------', 'line one  | x     \\', 'line two  | y', ''].join(
        '\n'
      )
    )

    // -> One merged row, not two: the continuation line joined into the SAME cell as the line above
    //    it rather than starting a new row
    const rowCount = (html.match(/<tr>/g) ?? []).length
    expect(rowCount).toBe(2) // header row + the single merged body row
    expect(html).toContain('<p>line one\nline two</p>')
    expect(html).toContain('<p>x\ny</p>')
  })

  it('does not install the plugin when multimdTable is disabled, falling back to plain-table parsing', () => {
    const renderer = new MarkdownRenderer({ multimdTable: false })
    const html = renderer.render(
      [
        '| A                |||',
        '|------|------|------|',
        '| B    | C    | D    |',
        '| ^^   | E    | F    |',
        ''
      ].join('\n')
    )

    // -> markdown-it's built-in table rule still renders a plain <table> -- multimd syntax on top of
    //    it is simply not understood, not a parse failure
    expect(html).toContain('<table>')
    expect(html).not.toContain('rowspan')
    expect(html).not.toContain('colspan')
    // -> `^^` is left as the literal cell text rather than being read as a rowspan marker
    expect(html).toContain('<td>^^</td>')
  })
})

describe('MarkdownRenderer - previously-broken edge cases', () => {
  it('does not throw when a fence names an unrecognized/malformed language', () => {
    /*
      See the comment above `highlight()` in markdown.js: markdown-it takes the first word of a
      fence's info string as the language, so a fence whose code starts on the opening line (as this
      one does) asks hljs for a language literally named `<!DOCTYPE`. `hljs.highlight()` THROWS on an
      unknown language -- `ignoreIllegals` only forgives illegal syntax within a language it knows --
      and that throw used to take the entire render down with it.
    */
    const renderer = new MarkdownRenderer({})

    expect(() => {
      const html = renderer.render('```<!DOCTYPE rfc [\nsome text\n```\n')
      expect(html).toContain('some text')
      // -> The escape hatch only ever ran on the unhighlighted path; still confirms angle brackets
      //    from the fence info string don't leak unescaped into the class attribute
      expect(html).toContain('language-&lt;!DOCTYPE')
    }).not.toThrow()
  })

  it('renders a footnote reference instead of letting the mdc inline span rule swallow it', () => {
    /*
      MDC's inline span (`[text]{.class}`) and a footnote reference (`[^1]`) both start with `[`, and
      the span rule is registered first. Left unguarded it claims `[^1]` too, rendering a literal
      `<span>^1</span>` -- and the footnote definition, referenced by nothing anymore, is dropped
      entirely.
    */
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('Some text[^1]\n\n[^1]: The note.\n')

    expect(html).toContain('class="footnote-ref"')
    expect(html).toContain('The note.')
    expect(html).not.toContain('<span>^1</span>')
  })

  it('applies a markdown-it-attrs brace on its own line without the mdc inline-props collision crashing the render', () => {
    /*
      MDC's inline props (`{.class}`) and markdown-it-attrs both claim `{`. A brace that opens a line
      (or stands off behind a space) is markdown-it-attrs addressing the preceding block, but MDC used
      to take it anyway when it abutted the block above -- which both silently dropped the class and,
      in other shapes, crashed the renderer outright.
    */
    const renderer = new MarkdownRenderer({})

    expect(() => {
      const html = renderer.render('> A quote\n{.is-warning}\n')
      expect(html).toContain('<blockquote class="is-warning')
    }).not.toThrow()
  })
})

/*
  happy-dom's `document` never reports a `compatMode` (real browsers do, once they have parsed a
  doctype), and KaTeX warns to the console whenever it cannot confirm one -- a real browser page (and
  the headless-Chromium re-render `models/rendering.ts` drives) always has a proper doctype, so this is
  purely a gap in the test DOM, not a real quirks-mode page. Silenced the same way a real document
  settles it, rather than leaving a spurious warning in every run of this suite.
*/
Object.defineProperty(document, 'compatMode', { value: 'CSS1Compat', configurable: true })

/**
 * Covers the `$…$` / `$$…$$` TeX authoring syntax 2.5.x content actually uses (Feature 366 / Task
 * 624) -- confirmed as the syntax to reproduce against upstream `markdown-it-katex`, which
 * `block-katex`'s own fenced-code form does not accept (`::block-katex` needs a fence; these
 * delimiters are the mid-sentence shorthand authors actually typed).
 */
function render(src) {
  return new MarkdownRenderer().render(src)
}

describe('MarkdownRenderer -- inline and display TeX', () => {
  it('resolves inline $…$ TeX to a literal KaTeX span', () => {
    const html = render('The area is $\\pi r^2$ exactly.')
    expect(html).toContain('class="katex"')
    // -> The delimiters themselves are gone -- this is resolved HTML/MathML, not a live element still
    //    carrying the raw `$…$` syntax (the MathML accessibility annotation legitimately repeats the
    //    source, which is why this checks for the delimiter rather than the TeX itself)
    expect(html).not.toContain('$\\pi r^2$')
  })

  it('resolves display $$…$$ TeX to a literal, centered KaTeX block', () => {
    const html = render('$$x^2 + y^2 = z^2$$')
    expect(html).toContain('katex-display')
  })

  it('does not misfire on literal currency amounts ($5, $10)', () => {
    const html = render('It costs $5 or $10, whichever is more.')
    expect(html).toContain('$5 or $10')
    expect(html).not.toContain('class="katex"')
  })

  it('does not swallow prose between two unrelated currency mentions', () => {
    const html = render('Budget was $20,000 and now it is $30,000.')
    expect(html).toContain('$20,000 and now it is $30,000')
    expect(html).not.toContain('class="katex"')
  })

  it('leaves a $ $ pair with only whitespace between it alone, same as currency', () => {
    const html = render('A lone $ $ sign.')
    expect(html).toContain('$ $')
    expect(html).not.toContain('class="katex"')
  })

  it('shows an error panel for inline TeX that fails to parse, instead of vanishing', () => {
    const html = render('Broken: $\\frac{1}{2$ end.')
    expect(html).toContain('tex-math-error')
    expect(html).toContain('could not be typeset')
  })

  it('shows an error panel for an empty display formula, matching the blocks own wording', () => {
    const html = render('$$$$')
    expect(html).toContain('tex-math-error')
    expect(html).toContain('This formula is empty')
  })

  it('renders more than one inline formula in the same paragraph', () => {
    const html = render('$a^2$ plus $b^2$ equals $c^2$.')
    expect(html.match(/class="katex"/g)?.length).toBe(3)
  })
})

/*
 * OpenProject #829, item 2: targeted regression coverage for two KaTeX edge cases from upstream
 * reports -- multi-character subscripts (upstream #1581) and `\vdots` (upstream discussion #3530).
 * Both are ordinary, well-supported KaTeX/TeX syntax; nothing in `TEX_INLINE`/`TEX_DISPLAY` or
 * `texMathHtml` singles either out for special handling, so these exist to lock in that plain KaTeX
 * usage keeps working through this renderer's own delimiter/currency-guard regexes, not because
 * either construct needed a code change here.
 */
describe('MarkdownRenderer -- KaTeX edge cases (OpenProject #829 item 2)', () => {
  it('typesets a multi-character subscript written with braces', () => {
    const html = render('The element is $x_{ij}$ in the matrix.')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('tex-math-error')
    // -> Both characters of the subscript reached KaTeX as one group, not split around the brace
    expect(html).toMatch(/<annotation encoding="application\/x-tex">x_\{ij\}<\/annotation>/)
  })

  it('does not let a multi-character subscript run past the paragraph it sits in', () => {
    const html = render('The element is $x_{ij}$ in the matrix.')
    expect(html).toContain('in the matrix.')
  })

  it('typesets \\vdots inside a matrix environment', () => {
    const html = render('$$\\begin{matrix} 1 \\\\ \\vdots \\\\ n \\end{matrix}$$')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('tex-math-error')
  })

  it('typesets a bare inline \\vdots', () => {
    const html = render('A column of dots: $\\vdots$')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('tex-math-error')
  })
})

/*
 * OpenProject #829, item 3: upstream PR #2645, "inline math interpreted as attributes" -- braces
 * that are TeX syntax *inside* a `$…$`/`$$…$$` formula (a multi-character subscript, a literal
 * `\{…\}` set) must never be read by `markdown-it-attrs` as a trailing `{.class #id}` block.
 *
 * This renderer's `tex_math` inline rule is registered `before('text', …)`, so it claims the WHOLE
 * `$…$` span -- braces included -- as a single token's content before `text` ever splits the source
 * around them. `markdown-it-attrs` runs afterwards, as a core rule over the already-built token
 * stream, so by the time it looks for a `{…}` to attach, the formula's braces are already inside a
 * `tex_math` token's `content` string rather than sitting in the stream as their own text. These
 * tests are the regression guard for that ordering, confirmed against upstream's own bug shape.
 */
describe('MarkdownRenderer -- inline math braces are not consumed as markdown-it-attrs (OpenProject #829 item 3)', () => {
  it('does not let a multi-character subscript brace become an id/class attribute', () => {
    const html = render('The subscript is $x_{ij}$ here.')
    expect(html).toContain('class="katex"')
    // -> No attribute was scraped out of the formula's own braces onto anything
    expect(html).not.toContain('id="ij"')
    expect(html).not.toContain('class="ij"')
    // -> And the prose after the formula survived untouched
    expect(html).toContain('here.')
  })

  it('does not let a literal \\{…\\} set-builder formula be swallowed as an attrs block', () => {
    const html = render('The set $\\{1, 2, 3\\}$ is finite.')
    expect(html).toContain('class="katex"')
    expect(html).toContain('is finite.')
  })

  it('does not let braces inside a display formula bleed into the next block', () => {
    const html = render('$$\\{a, b, c\\}$$\n\nAnother paragraph.')
    expect(html).toContain('katex-display')
    // -> Its own, ordinary paragraph -- not swallowed into the formula's span, and carrying no
    //    attribute scraped out of the formula's own braces
    expect(html).toMatch(/<p[^>]*>Another paragraph\.<\/p>/)
    expect(html).not.toMatch(/<p[^>]*class="[^"]*\bc\b/)
  })

  it('still applies a real markdown-it-attrs class written after (not inside) a formula', () => {
    // -> The braces here are NOT part of the formula -- they trail the paragraph on their own line,
    //    the ordinary markdown-it-attrs block-attribute position -- so this must keep working exactly
    //    as it does for any other block, confirming the formula's own rule isn't swallowing attrs it
    //    was never meant to touch
    const html = render('> The formula is $x^2$.\n{.is-warning}\n')
    expect(html).toContain('class="katex"')
    expect(html).toContain('<blockquote class="is-warning')
  })
})
