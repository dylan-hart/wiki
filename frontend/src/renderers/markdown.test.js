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
 * The block-vs-fence handoff: `block-diagram`, `block-kroki` and `block-plantuml` all read their
 * source out of a `<pre>` left behind by markdown's own fence handling — never rendered or escaped
 * away, since each block draws it client-side (Mermaid) or hands it to an image server (Kroki,
 * PlantUML). This is the one seam that is genuinely worth a unit test: it is exactly what a headless
 * re-render depends on producing byte-for-byte, and a regression here would silently blank every
 * diagram on the site without ever touching the block components themselves.
 */
describe('MarkdownRenderer fenced diagram handoff', () => {
  it.each(['mermaid', 'kroki', 'plantuml'])(
    'leaves a ```%s fence as an escaped <pre> for the block to read, not a rendered diagram',
    (lang) => {
      const md = new MarkdownRenderer({})
      const html = md.render(`\`\`\`${lang}\nA --> B\n\`\`\``)

      expect(html).toContain(`<pre class="codeblock-${lang}">`)
      expect(html).toContain('A --&gt; B')
      expect(html).not.toContain('A --> B')
    }
  )

  it.each(['mermaid', 'kroki', 'plantuml'])(
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
