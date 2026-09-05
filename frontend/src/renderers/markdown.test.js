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

/**
 * The `markdown-it-attrs` whitelist (OpenProject #1180): only `id`, `class` and `target` are ever
 * let through onto the rendered element -- everything else an author writes in a `{...}` block is
 * silently dropped, since arbitrary attributes from page content (`onclick`, `style`, ...) are an
 * XSS-adjacent surface `markdown-it-attrs` itself does not fence off by default.
 */
describe('MarkdownRenderer -- markdown-it-attrs allowedAttributes whitelist (OpenProject #1180)', () => {
  it('applies {.class #id} on a heading', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('# Heading {.is-warning #my-heading}\n')

    expect(html).toContain('id="my-heading"')
    expect(html).toMatch(/class="[^"]*\bis-warning\b[^"]*"/)
  })

  it('applies {.class #id} on an inline span', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('Some [text]{.is-warning #my-span} in a sentence.\n')

    expect(html).toContain('id="my-span"')
    expect(html).toContain('class="is-warning"')
  })

  it('keeps the allowed target attribute', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('# Heading {target=_blank}\n')

    expect(html).toContain('target="_blank"')
  })

  it('drops an attribute not on the whitelist rather than rendering it', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('# Heading {onclick=alert(1)}\n')

    expect(html).not.toContain('onclick')
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

/**
 * OpenProject #870: site-wide glossary terms, matched case-insensitively and on whole words only
 * against a cached term list, rendered as a hover tooltip (native `title`) that links through to the
 * term's canonical page when one is set.
 */
describe('MarkdownRenderer - glossary terms (OpenProject #870)', () => {
  it('wraps a matched term as an <abbr> carrying its definition as the title', () => {
    const md = new MarkdownRenderer({
      glossaryTerms: [{ term: 'API', definition: 'Application Programming Interface', link: null }]
    })
    const html = md.render('Call the API to fetch data.')

    expect(html).toContain(
      '<abbr title="Application Programming Interface" class="glossary-term">API</abbr>'
    )
  })

  it('matches case-insensitively while preserving the casing actually written', () => {
    const md = new MarkdownRenderer({
      glossaryTerms: [{ term: 'API', definition: 'Application Programming Interface', link: null }]
    })
    const html = md.render('This is an api, not an Api.')

    expect(html).toContain(
      '<abbr title="Application Programming Interface" class="glossary-term">api</abbr>'
    )
    expect(html).toContain(
      '<abbr title="Application Programming Interface" class="glossary-term">Api</abbr>'
    )
  })

  it('does not match a term inside a longer word ("log" must not match inside "login")', () => {
    const md = new MarkdownRenderer({
      glossaryTerms: [{ term: 'log', definition: 'A record of events.', link: null }]
    })
    const html = md.render('Please login to continue.')

    expect(html).not.toContain('glossary-term')
    expect(html).toContain('login')
  })

  it('renders a link through to the canonical page when one is set', () => {
    const md = new MarkdownRenderer({
      glossaryTerms: [
        { term: 'API', definition: 'Application Programming Interface', link: '/en/dev/api' }
      ]
    })
    const html = md.render('The API is documented.')

    expect(html).toContain(
      '<a href="/en/dev/api" title="Application Programming Interface" class="glossary-term">API</a>'
    )
  })

  it('does not nest an anchor inside an existing markdown link, even when the term has a canonical page', () => {
    // -> Nested <a> tags are invalid HTML; browsers recover by closing the outer link early, which
    //    would silently break the author's own link. The term still gets its tooltip via <abbr>
    //    (OpenProject #870).
    const md = new MarkdownRenderer({
      glossaryTerms: [
        { term: 'API', definition: 'Application Programming Interface', link: '/en/dev/api' }
      ]
    })
    const html = md.render('[Read the API docs](/manual)')

    expect(html).toContain(
      '<a href="/manual">Read the <abbr title="Application Programming Interface" class="glossary-term">API</abbr> docs</a>'
    )
    // -> The term's own href would have nested a second <a> inside the one above; confirms it was
    //    suppressed rather than merely not asserted on
    expect(html).not.toContain('href="/en/dev/api"')
  })

  it('still links a term to its canonical page when the match is plain text, not inside a link', () => {
    const md = new MarkdownRenderer({
      glossaryTerms: [
        { term: 'API', definition: 'Application Programming Interface', link: '/en/dev/api' }
      ]
    })
    const html = md.render('Read the API docs, then [see also](/manual).')

    expect(html).toContain(
      '<a href="/en/dev/api" title="Application Programming Interface" class="glossary-term">API</a>'
    )
  })

  it('prefers the longest matching term when two terms overlap the same span', () => {
    const md = new MarkdownRenderer({
      glossaryTerms: [
        { term: 'API', definition: 'Short definition.', link: null },
        { term: 'REST API', definition: 'Long definition.', link: null }
      ]
    })
    const html = md.render('Our REST API is versioned.')

    expect(html).toContain('title="Long definition."')
    expect(html).not.toContain('title="Short definition."')
  })

  it('matches an alias to the same definition and link as its parent term (OpenProject #1110)', () => {
    const md = new MarkdownRenderer({
      glossaryTerms: [
        {
          term: 'Hot Strip Mill',
          definition: 'A rolling mill.',
          aliases: [{ value: 'HSM', isAcronym: true }],
          link: '/en/dev/hsm'
        }
      ]
    })
    const html = md.render('The HSM was down for maintenance.')

    expect(html).toContain(
      '<a href="/en/dev/hsm" title="A rolling mill." class="glossary-term">HSM</a>'
    )
  })

  it('prefers the longest surface form across every term and alias combined', () => {
    const md = new MarkdownRenderer({
      glossaryTerms: [
        { term: 'API', definition: 'Short definition.', aliases: [], link: null },
        {
          term: 'Interface',
          definition: 'Long definition.',
          aliases: [{ value: 'REST API', isAcronym: false }],
          link: null
        }
      ]
    })
    const html = md.render('Our REST API is versioned.')

    expect(html).toContain('title="Long definition."')
    expect(html).not.toContain('title="Short definition."')
  })

  it('matches every occurrence of a term across the document', () => {
    const md = new MarkdownRenderer({
      glossaryTerms: [{ term: 'widget', definition: 'A small reusable thing.', link: null }]
    })
    const html = md.render('A widget is a widget, no matter where you put the widget.')

    expect(html.match(/class="glossary-term"/g)).toHaveLength(3)
  })

  it('does not match glossary terms inside a fenced code block', () => {
    const md = new MarkdownRenderer({
      glossaryTerms: [{ term: 'API', definition: 'Application Programming Interface', link: null }]
    })
    const html = md.render('```\nconst API = 1\n```')

    expect(html).not.toContain('glossary-term')
  })

  it('degrades to plain text with an empty glossary', () => {
    const md = new MarkdownRenderer({ glossaryTerms: [] })
    const html = md.render('Nothing here is a glossary term, not even API.')

    expect(html).not.toContain('glossary-term')
    expect(html).toContain('API')
  })

  it('degrades to plain text when no glossary config is given at all', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('Plain text, no glossary configured.')

    expect(html).not.toContain('glossary-term')
  })
})

/**
 * OpenProject #1901: both root hljs call sites (this renderer and `EditorCodeBlockMenu.vue`) moved
 * from importing the `highlight.js` package root -- which registers every grammar the package ships,
 * ~190 of them -- to `highlight.js/lib/common`, a ~36-language subset. Trimming cannot break
 * rendering: the `highlight()` option above already guards with `hljs.getLanguage(lang)` before
 * calling `hljs.highlight()`, falling back to escaped plain text for anything hljs does not know --
 * previously only reachable via a typo'd or genuinely unknown language, now also reachable via a
 * language that is real but was never bundled into `lib/common`.
 */
describe('MarkdownRenderer -- highlight.js/lib/common language set (OpenProject #1901)', () => {
  it('highlights a fenced block in a language retained by lib/common', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('```python\nimport os\n```')

    expect(html).toContain('language-python')
    // -> hljs's own span markup, proof the block was actually run through the highlighter and not
    //    just escaped
    expect(html).toContain('class="hljs-keyword"')
    expect(html).toContain('>import<')
  })

  it('falls through to escaped, unhighlighted text for a language present in the full package but not in lib/common', () => {
    const md = new MarkdownRenderer({})
    // -> Haskell ships with the full `highlight.js` package but is not one of lib/common's ~36
    //    languages -- exactly the class of fence this trim newly affects
    const html = md.render('```haskell\nmain = putStrLn "<hi>"\n```')

    expect(html).toContain('language-haskell')
    expect(html).not.toContain('class="hljs-')
    // -> Still escaped like any other unhighlighted fence, not raw-interpolated
    expect(html).toContain('&lt;hi&gt;')
  })
})

/**
 * `lineCount > 1 && 'line-numbers'` interpolated the boolean `false` itself into the class attribute
 * for any single-line fence, since `&&` short-circuits to its left operand rather than an empty
 * string. Since this render is both the live preview AND what gets saved to the page, that literal
 * class `false` used to be written into every page's stored HTML permanently (OpenProject #946).
 */
describe('MarkdownRenderer -- codeblock class attribute (OpenProject #946)', () => {
  it('never interpolates the literal string "false" for a single-line code block', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('```js\nconst x = 1\n```')

    expect(html).toContain('class="codeblock hljs"')
    expect(html).not.toMatch(/class="codeblock hljs[^"]*false/)
  })

  it('adds the line-numbers class for a multi-line code block, with no stray "false"', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('```js\nconst x = 1\nconst y = 2\n```')

    expect(html).toContain('class="codeblock hljs line-numbers"')
    expect(html).not.toContain('false')
  })
})

/**
 * `isExternalHref` judges a link's origin against `siteOrigin` when the render context supplies one,
 * rather than only `globalThis.location` -- what lets the headless re-render
 * (`backend/models/rendering.ts`, running in a browser navigated to its own loopback address, not the
 * site's hostname) classify a link the same way the editor's own save did (OpenProject #1751). This
 * test file has no DOM/`location` at all (see the header comment), so every case here exercises the
 * `siteOrigin` path specifically -- it is the only origin `isExternalHref` ever has to work with under
 * Vitest's `node` environment.
 */
describe('MarkdownRenderer -- is-external-link with a site origin (OpenProject #1751)', () => {
  it('does not mark an absolute link to this same wiki as external', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('[Docs](https://wiki.example.com/docs)', {
      siteOrigin: 'https://wiki.example.com'
    })

    expect(html).toContain('<a href="https://wiki.example.com/docs">')
    expect(html).not.toContain('is-external-link')
  })

  it('marks an absolute link to a foreign origin as external', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('[Elsewhere](https://other.example.com/docs)', {
      siteOrigin: 'https://wiki.example.com'
    })

    expect(html).toContain('class="is-external-link"')
  })

  it('does not mark a relative link as external, regardless of siteOrigin', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('[Sibling](/docs/other)', { siteOrigin: 'https://wiki.example.com' })

    expect(html).not.toContain('is-external-link')
  })
})

/**
 * OpenProject #2372: a Playwright trace against `e2e/tests/csp.spec.js` showed `::block-spoiler{label=
 * "Reveal" hint="Click to show content"}` -- and every block after it in the document -- rendering as
 * literal, unparsed markdown text instead of real `<block-spoiler>` elements. The working hypothesis
 * recorded on the WP was that `markdown-it-mdc` mis-parses a `::block-name{...}` once an attribute
 * value contains a space.
 *
 * That hypothesis does not hold against this renderer: every case below is drawn either directly from
 * `csp.spec.js`'s own `BODY` (`block-spoiler`'s and `block-countdown`'s exact attribute strings) or
 * from a deliberate attempt to break the same code path a different way (the spaced value alone, the
 * spaced value first instead of second, two blocks back-to-back with no blank line between them, a
 * value with several space-separated words, a single-quoted value), constructed with the site's real
 * default editor config (`backend/models/sites.ts`'s `markdown.config`), not an empty `{}` -- and every
 * one parses into a real element with the space preserved in the attribute. This is not a fix for a
 * bug in this file; it is a permanent regression guard, since I could not reproduce one here to fix
 * (see the WP's own comment thread for the full investigation, including where the defect is more
 * likely to actually be: the real-browser Monaco input pipeline the CSP e2e spec drives, which this
 * unit-level render test cannot exercise).
 */
describe('MarkdownRenderer -- MDC block attribute values containing a space (OpenProject #2372)', () => {
  const realEditorConfig = {
    allowHTML: true,
    lineBreaks: true,
    linkify: true,
    multimdTable: true,
    quotes: 'english',
    tabWidth: 2,
    typographer: false,
    underline: true
  }

  it('parses a spaced value alongside a plain one, matching block-spoiler in csp.spec.js', () => {
    const md = new MarkdownRenderer(realEditorConfig)
    const html = md.render(
      '::block-spoiler{label="Reveal" hint="Click to show content"}\nThe content to hide.\n::\n'
    )

    expect(html).toContain('<block-spoiler label="Reveal" hint="Click to show content">')
  })

  it('parses a spaced value as the second of two attributes, matching block-countdown', () => {
    const md = new MarkdownRenderer(realEditorConfig)
    const html = md.render('::block-countdown{date="2030-01-01T00:00" label="New Year"}\n::\n')

    expect(html).toContain('<block-countdown date="2030-01-01T00:00" label="New Year">')
  })

  it('parses a spaced value as the only attribute', () => {
    const md = new MarkdownRenderer(realEditorConfig)
    const html = md.render('::block-spoiler{hint="Click to show content"}\n::\n')

    expect(html).toContain('<block-spoiler hint="Click to show content">')
  })

  it('parses a spaced value listed before a plain one', () => {
    const md = new MarkdownRenderer(realEditorConfig)
    const html = md.render('::block-spoiler{hint="Click to show content" label="Reveal"}\n::\n')

    expect(html).toContain('<block-spoiler hint="Click to show content" label="Reveal">')
  })

  it('parses a value with several space-separated words', () => {
    const md = new MarkdownRenderer(realEditorConfig)
    const html = md.render('::block-spoiler{hint="a b c d e f g h"}\n::\n')

    expect(html).toContain('<block-spoiler hint="a b c d e f g h">')
  })

  it('parses a single-quoted spaced value', () => {
    const md = new MarkdownRenderer(realEditorConfig)
    const html = md.render("::block-spoiler{hint='Click to show content'}\n::\n")

    expect(html).toContain('<block-spoiler hint="Click to show content">')
  })

  it('does not corrupt a following block when the preceding one has a spaced attribute value, with no blank line between them', () => {
    const md = new MarkdownRenderer(realEditorConfig)
    const html = md.render(
      '::block-spoiler{label="Reveal" hint="Click to show content"}\n::\n::block-qr-code{value="https://example.com" caption="QR"}\n::\n'
    )

    expect(html).toContain('<block-spoiler label="Reveal" hint="Click to show content">')
    expect(html).toContain('<block-qr-code value="https://example.com" caption="QR">')
  })

  it('parses every block in csp.spec.js’s exact BODY, in its exact document order', () => {
    const md = new MarkdownRenderer(realEditorConfig)
    const html = md.render(`# CSP Proof Page

CSP proof sentinel paragraph -- this plain sentence is what the editor's debounced preview sync is waited on for,
since none of the block/math syntax below survives markdown rendering as literal text.

Inline KaTeX renders directly in prose: $E = mc^2$. A display formula follows:

$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$

::block-checklist{runkey="csp-check"}
- First step
- Second step
::

:::block-tabs
::block-tab{label="First tab"}
Content of the first tab.
::

::block-tab{label="Second tab"}
Content of the second tab.
::
:::

::block-infobox{name="Montreal" image="https://example.com/photo.jpg"}
\`\`\`yaml
City: Montreal
Country: Canada
Public Transport:
  Metro: true
  Bus: true
\`\`\`
::

::block-spoiler{label="Reveal" hint="Click to show content"}
The content to hide.
::

::block-qr-code{value="https://example.com" caption="QR"}
::

::block-countdown{date="2030-01-01T00:00" label="New Year"}
::

::block-katex
\`\`\`latex
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
\`\`\`
::

::block-gallery
https://example.com/photo-1.jpg
https://example.com/photo-2.jpg
::
`)

    for (const tag of [
      'block-checklist',
      'block-tabs',
      'block-tab',
      'block-infobox',
      'block-spoiler',
      'block-qr-code',
      'block-countdown',
      'block-katex',
      'block-gallery'
    ]) {
      expect(html).toContain(`<${tag}`)
    }
    expect(html).toContain('<block-spoiler label="Reveal" hint="Click to show content">')
    expect(html).toContain('<block-countdown date="2030-01-01T00:00" label="New Year">')
  })
})
