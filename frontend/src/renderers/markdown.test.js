import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MarkdownRenderer, gatedContentPlaceholder, sanitizeForPreview } from './markdown.js'
import {
  CHROMIUM_TIMEOUT,
  buildRenderedContentScript,
  chromium,
  hasChromium
} from '../../test/realGridLayout.js'

/*
  `MarkdownRenderer` has no DOM dependency, so these tests instantiate and render directly: no
  mounting, no `happy-dom`, and none of `test/setup.js`'s `API_CLIENT` / `EVENT_BUS` stubs.
*/

/**
 * Each of these blocks reads its source out of the `<pre>` that markdown's own fence handling
 * leaves behind. The source is never rendered or escaped away, because the block draws it
 * client-side or hands it to an image server.
 */
describe('MarkdownRenderer fenced diagram handoff', () => {
  it.each(['mermaid', 'kroki', 'plantuml', 'drawio', 'whiteboard'])(
    'leaves a ```%s fence as an escaped <pre> for the block to read, not a rendered diagram',
    (lang) => {
      const md = new MarkdownRenderer({})
      const html = md.render(`\`\`\`${lang}\nA --> B\n\`\`\``)

      expect(html).toContain(`<pre class="codeblock-${lang}">`)
      expect(html).toContain('A --&gt; B')
      expect(html).not.toContain('A --> B')
    }
  )

  it.each(['mermaid', 'kroki', 'plantuml', 'drawio', 'whiteboard'])(
    'escapes markup written inside a ```%s fence rather than interpolating it raw',
    (lang) => {
      const md = new MarkdownRenderer({})
      const html = md.render(`\`\`\`${lang}\n<script>alert(1)</script>\n\`\`\``)

      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
    }
  )

  /*
   * Nothing in the app produces a ```diagram fence — every producer writes ```mermaid / ```kroki /
   * ```plantuml, handled above — so a hand-typed one must fall through to the same escaped,
   * generic-code treatment as any other unrecognised language rather than to a base64-decoding
   * special case that skips escaping.
   */
  it('leaves a whiteboard body inside ::block-whiteboard as a quiet pre whose text is the JSON', () => {
    const body =
      '{"v":2,"w":800,"h":450}\n{"c":"#1f2937","z":4,"p":[1,2,3,4,5,6]}\n{"c":"#1f2937","z":4,"p":[7,8,9]}'
    const html = new MarkdownRenderer({}).render(
      `::block-whiteboard\n\`\`\`whiteboard\n${body}\n\`\`\`\n::\n`
    )

    expect(html).toMatch(/<block-whiteboard[^>]*>\s*<pre class="codeblock-whiteboard"><code>/)
    expect(html).not.toContain('hljs')
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('block-whiteboard pre').textContent).toBe(`${body}\n`)
  })

  it('treats a ```diagram fence as ordinary, escaped code rather than unescaped raw HTML', () => {
    const md = new MarkdownRenderer({})
    // -> Base64 for "<script>alert(1)</script>"
    const html = md.render('```diagram\nPHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\n```')

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('class="diagram"')
    expect(html).toContain('language-diagram')
  })
})

describe('MarkdownRenderer - multimd-table', () => {
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

    // -> `colspan`/`rowspan` are not valid on the `<div role="columnheader"/"cell">` the grid markup
    //    renders, so the renderer renames them to their ARIA equivalents.
    expect(html).toContain('<div aria-colspan="3" role="columnheader">A</div>')
    expect(html).toContain('<div aria-rowspan="2" role="cell">B</div>')
    expect(html).not.toContain('^^')
  })

  it('merges a backslash-continued cell across lines into one grid cell when multimdTable is enabled', () => {
    const renderer = new MarkdownRenderer({ multimdTable: true })
    const html = renderer.render(
      ['A         | B', '----------|-------', 'line one  | x     \\', 'line two  | y', ''].join(
        '\n'
      )
    )

    const rowCount = (html.match(/role="row"/g) ?? []).length
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

    expect(html).toContain('role="table"')
    expect(html).not.toContain('rowspan')
    expect(html).not.toContain('colspan')
    expect(html).toContain('<div role="cell">^^</div>')
  })

  it('renders a table with no header row when multimdTable and headerless are both enabled', () => {
    const renderer = new MarkdownRenderer({ multimdTable: true })
    const html = renderer.render(
      ['| ------ | ------ |', '| A      | B      |', '| C      | D      |', ''].join('\n')
    )

    expect(html).toContain('role="table"')
    expect(html).not.toContain('role="columnheader"')
    const rowCount = (html.match(/role="row"/g) ?? []).length
    expect(rowCount).toBe(2)
    expect(html).toContain('<div role="cell">A</div>')
    expect(html).toContain('<div role="cell">B</div>')
    expect(html).toContain('<div role="cell">C</div>')
    expect(html).toContain('<div role="cell">D</div>')
  })
})

/**
 * A rendered table is CSS Grid, not a real `<table>`: `table_open`/`table_close` and the row/cell
 * rules retag every table-related token to a `<div>` carrying the matching ARIA role.
 * `border-collapse` combined with an ancestor `overflow: hidden` + `border-radius` clip is a
 * cross-browser rendering gap that container-level fixes cannot close from the outside, so the
 * table element itself cannot be a `<table>`.
 */
describe('MarkdownRenderer - table grid markup', () => {
  it('renders a plain table as nested div[role] elements: table > row > columnheader/cell', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render(
      ['| A    | B    |', '|------|------|', '| 1    | 2    |', ''].join('\n')
    )

    expect(html).toContain('role="table"')
    expect(html).not.toContain('<table')
    expect(html).not.toContain('<thead')
    expect(html).not.toContain('<tbody')
    expect(html).not.toContain('<tr')
    expect(html).not.toContain('<th')
    expect(html).not.toContain('<td')

    expect(html).toContain('<div role="columnheader">A</div>')
    expect(html).toContain('<div role="columnheader">B</div>')
    expect(html).toContain('<div role="cell">1</div>')
    expect(html).toContain('<div role="cell">2</div>')

    const rowCount = (html.match(/role="row"/g) ?? []).length
    expect(rowCount).toBe(2)
  })

  it('carries a column-alignment style from markdown-it onto the header/cell div, same as it did on <th>/<td>', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render(
      ['| A    | B    |', '|:-----|-----:|', '| 1    | 2    |', ''].join('\n')
    )

    expect(html).toContain('<div style="text-align:left" role="columnheader">A</div>')
    expect(html).toContain('<div style="text-align:right" role="columnheader">B</div>')
  })

  it('renders a multimd table (rowspan/colspan) as the same div[role] shape', () => {
    const renderer = new MarkdownRenderer({ multimdTable: true })
    const html = renderer.render(
      ['| A                |||', '|------|------|------|', '| B    | C    | D    |', ''].join('\n')
    )

    expect(html).toContain('role="table"')
    expect(html).not.toContain('<table')
    expect(html).toContain('<div aria-colspan="3" role="columnheader">A</div>')
  })

  /*
    `markdown-it-attrs` joins the class onto the table token at parse time, before it is retagged to
    a `<div>` at render time, so it lands on the same token either way.
  */
  it('keeps an author\'s markdown-it-attrs class on the grid\'s outer div, alongside role="table"', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render(
      ['| A    | B    |', '|------|------|', '| 1    | 2    |', '', '{.table-leading-col}'].join(
        '\n'
      )
    )

    expect(html).toContain('<div class="table-leading-col" role="table">')
  })

  /*
    A real `<caption>` tag is silently DROPPED by the browser's own HTML parser: WHATWG's "in body"
    insertion mode ignores an orphan `caption` start tag, and since every table token is retagged to
    a `<div>` there is no `<table>` left for a caption to be inside.
  */
  it('renders a caption authored above the table as a div, not a <caption> the browser would silently drop', () => {
    const renderer = new MarkdownRenderer({ multimdTable: true })
    const html = renderer.render(
      ['[Top Caption]', '| A    | B    |', '|------|------|', '| 1    | 2    |', ''].join('\n')
    )

    expect(html).not.toContain('<caption')
    expect(html).toContain('<div class="table-caption">Top Caption</div>')
    expect(html.indexOf('table-caption')).toBeLessThan(html.indexOf('role="row"'))
  })

  it('carries an inline caption-side: bottom style onto the retagged div, for a caption authored below the table', () => {
    const renderer = new MarkdownRenderer({ multimdTable: true })
    const html = renderer.render(
      ['| A    | B    |', '|------|------|', '| 1    | 2    |', '[Bottom Caption]', ''].join('\n')
    )

    expect(html).not.toContain('<caption')
    expect(html).toContain(
      '<div style="caption-side: bottom" class="table-caption">Bottom Caption</div>'
    )
    // -> Emitted in its authored position; `_page-contents.css`'s `order: 1` rule keys off this
    //    inline style to put it at the visual end of the grid.
    expect(html.indexOf('table-caption')).toBeGreaterThan(html.lastIndexOf('role="row"'))
  })
})

/**
 * Three nested divs rather than one: `.table-wrap` is the non-scrolling frame, so a corner mark can
 * overhang it without an `overflow-x: auto` box clipping it away; `.table-clip` carries the radius
 * clip, because `border-radius` does not reliably clip an element that is itself rendering a native
 * scrollbar; `.table-scroll` is the box that actually scrolls.
 */
describe('MarkdownRenderer - table scroll wrapper', () => {
  it('wraps a plain table in div.table-wrap > div.table-clip > div.table-scroll', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render(
      ['| A    | B    |', '|------|------|', '| 1    | 2    |', ''].join('\n')
    )

    expect(html).toContain(
      '<div class="table-wrap"><div class="table-clip"><div class="table-scroll"><div role="table">'
    )
    expect(html).toMatch(/<\/div>\n?<\/div><\/div><\/div>$/)
  })

  it('wraps a multimd table (rowspan/colspan) in the same nested divs', () => {
    const renderer = new MarkdownRenderer({ multimdTable: true })
    const html = renderer.render(
      ['| A                |||', '|------|------|------|', '| B    | C    | D    |', ''].join('\n')
    )

    expect(html).toContain(
      '<div class="table-wrap"><div class="table-clip"><div class="table-scroll"><div role="table">'
    )
    expect(html).toMatch(/<\/div>\n?<\/div><\/div><\/div>$/)
  })
})

/*
  Accessibility-tree computation and clipboard behavior are two things neither jsdom nor happy-dom
  can answer, so this drives a real Chromium via `test/realGridLayout.js` rather than reasoning from
  spec alone.
*/
describe(
  'MarkdownRenderer - table grid accessibility & clipboard (OpenProject #3016)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    const html = new MarkdownRenderer({}).render(
      ['| Key   | Value |', '|-------|-------|', '| alpha | 1     |', '| beta  | 2     |', ''].join(
        '\n'
      )
    )

    const REAL_TABLE_HTML =
      '<table><thead><tr><th>Key</th><th>Value</th></tr></thead>' +
      '<tbody><tr><td>alpha</td><td>1</td></tr><tr><td>beta</td><td>2</td></tr></tbody></table>'

    it('exposes the same table/row/columnheader/cell accessibility roles a real <table> would, with row/column associations intact from DOM order alone', async () => {
      const page = await browser.newPage()
      try {
        await page.setContent(`<!doctype html><html><body>${html}</body></html>`)
        const gridSnapshot = await page.locator('[role="table"]').ariaSnapshot()

        await page.setContent(`<!doctype html><html><body>${REAL_TABLE_HTML}</body></html>`)
        const tableSnapshot = await page.locator('table').ariaSnapshot()

        // -> A real `<table>` additionally nests each row under a `rowgroup` (from `thead`/`tbody`),
        //    which the ARIA `table` role has no equivalent for and the grid deliberately renders as
        //    nothing; everything else must match line for line.
        const roleLines = (snapshot) =>
          snapshot
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith('- rowgroup'))
            .map((line) => line.replace(/:$/, ''))

        expect(roleLines(gridSnapshot)).toEqual(roleLines(tableSnapshot))
        expect(roleLines(gridSnapshot)).toEqual([
          '- table',
          '- row "Key Value"',
          '- columnheader "Key"',
          '- columnheader "Value"',
          '- row "alpha 1"',
          '- cell "alpha"',
          '- cell "1"',
          '- row "beta 2"',
          '- cell "beta"',
          '- cell "2"'
        ])

        // -> No `aria-colindex`/`aria-rowindex` anywhere, deliberately: those exist to restore
        //    associations when DOM order can't be trusted (a virtualized or reordered grid), and
        //    `grid-template-columns: subgrid` places every cell in DOM order here.
      } finally {
        await page.close()
      }
    })

    /*
      Excel's and Google Sheets' HTML-paste importers key off literal `<table>`/`<tr>`/`<td>` markup
      (the CF_HTML clipboard convention), not ARIA roles, so whether the copied fragment contains a
      real `<table>` is the decisive, testable question. `navigator.clipboard.read()` needs a real
      http(s) origin to grant clipboard permissions against -- `about:blank`/`data:` URLs have none
      -- so this fakes one via `page.route()` rather than `page.setContent()`.
    */
    it('confirms the copy/paste-to-spreadsheet fix: the copied HTML fragment contains a real <table>, the same as the markup it replaced would (OpenProject #3238)', async () => {
      const page = await browser.newPage()
      try {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: 'http://localhost'
        })
        const renderedContentScript = await buildRenderedContentScript()

        async function copiedHtmlAndTextFor(selector, body, { wireInterception = false } = {}) {
          await page.route('**/probe.html', (route) =>
            route.fulfill({
              body: `<!doctype html><html><body>${body}</body></html>`,
              contentType: 'text/html'
            })
          )
          await page.goto('http://localhost/probe.html')
          if (wireInterception) {
            await page.addScriptTag({ content: renderedContentScript })
            await page.evaluate(() =>
              window.RenderedContent.enhanceRenderedContent(document.body, (k) => k)
            )
          }
          return page.evaluate(async (sel) => {
            const el = document.querySelector(sel)
            const range = document.createRange()
            range.selectNodeContents(el)
            const selection = window.getSelection()
            selection.removeAllRanges()
            selection.addRange(range)
            document.execCommand('copy')
            const out = { html: null, text: null }
            for (const item of await navigator.clipboard.read()) {
              if (item.types.includes('text/html')) {
                out.html = await (await item.getType('text/html')).text()
              }
              if (item.types.includes('text/plain')) {
                out.text = await (await item.getType('text/plain')).text()
              }
            }
            return out
          }, selector)
        }

        const gridClipboard = await copiedHtmlAndTextFor('[role="table"]', html, {
          wireInterception: true
        })
        const realTableClipboard = await copiedHtmlAndTextFor('table', REAL_TABLE_HTML)

        // -> Control: proves the probe captures what the browser really puts on the clipboard
        expect(realTableClipboard.html).toContain('<table')
        expect(realTableClipboard.html).toContain('<td')

        // -> The `copy` interception synthesizes a real `<table>` ahead of the browser's own default
        //    copy, which would put the flat run of role-bearing `<div>`s on the clipboard instead
        expect(gridClipboard.html).toContain('<table')
        expect(gridClipboard.html).toContain('<th')
        expect(gridClipboard.html).toContain('<td')
        expect(gridClipboard.html).not.toContain('role="row"')
        expect(gridClipboard.html).not.toContain('role="cell"')

        // -> Tab/newline-delimited fallback, for a paste target that reads only the plain-text slot
        expect(gridClipboard.text).toBe('Key\tValue\nalpha\t1\nbeta\t2')
      } finally {
        await page.close()
      }
    })
  }
)

describe('MarkdownRenderer - previously-broken edge cases', () => {
  it('does not throw when a fence names an unrecognized/malformed language', () => {
    /*
      markdown-it takes the first word of a fence's info string as the language, so a fence whose
      code starts on the opening line asks hljs for a language literally named `<!DOCTYPE`.
      `hljs.highlight()` THROWS on an unknown language -- `ignoreIllegals` only forgives illegal
      syntax within a language it knows -- and an unguarded throw takes the whole render down.
    */
    const renderer = new MarkdownRenderer({})

    expect(() => {
      const html = renderer.render('```<!DOCTYPE rfc [\nsome text\n```\n')
      expect(html).toContain('some text')
      expect(html).toContain('language-&lt;!DOCTYPE')
    }).not.toThrow()
  })

  it('renders a footnote reference instead of letting the mdc inline span rule swallow it', () => {
    /*
      The inline span rule (`[text]{.class}`) and a footnote reference (`[^1]`) both start with `[`,
      and the span rule is registered first: unguarded it claims `[^1]` too, and the footnote
      definition, then referenced by nothing, is dropped entirely.
    */
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('Some text[^1]\n\n[^1]: The note.\n')

    expect(html).toContain('class="footnote-ref"')
    expect(html).toContain('The note.')
    expect(html).not.toContain('<span>^1</span>')
  })

  it('renders a bracket span nested inside an outer link label without throwing (OpenProject #3070)', () => {
    /*
      markdown-it core's `link` rule calls `helpers.parseLinkLabel` to find the matching `]`, which
      scans forward running every inline rule once in SILENT mode via `skipToken` and throws
      "inline rule didn't increment state.pos" if a rule reports a match without moving `state.pos`
      -- which is why `wikiSpan` assigns `state.pos` before its own silent-mode return.

      Not throwing does not make the outer `[...]` a link: `parseLinkLabel`'s `disableNested` check
      refuses an outer label once a nested `[` resolves to a complete token of its own, so the
      correct render is the brackets and URL staying literal text with the span substituted inside.
    */
    const renderer = new MarkdownRenderer({})

    let html
    expect(() => {
      html = renderer.render(
        '[See the analysis, noting it is **[CONTEXT]**, not independently traced here](https://example.com/page)\n'
      )
    }).not.toThrow()

    expect(html).not.toContain('<a ')
    expect(html).toContain('<span>CONTEXT</span>')
    expect(html).toContain('[See the analysis, noting it is')
    expect(html).toContain('not independently traced here](https://example.com/page)')
  })

  it('renders an unterminated bracket span nested inside an outer footnote-shaped label without throwing (OpenProject #3078)', () => {
    /*
      Same crash class as the case above, for a nested `[` with no closing `]` anywhere before
      end-of-input.

      The fixture's shape is load-bearing: an outer `[` immediately followed by `^` makes `wikiSpan`
      decline without scanning at all (its footnote-reference guard), handing straight to core's
      `link` rule, whose `parseLinkLabel` scans the label via `skipToken` -- always silent -- right
      into the nested `[`. An outer bracket `wikiSpan` itself recognises cannot reach that path: its
      own scan only declines after finding a balanced `]`.
    */
    const renderer = new MarkdownRenderer({})

    let html
    expect(() => {
      html = renderer.render(
        '[^1 outer label, then a nested unterminated bracket [with no closing bracket anywhere in the rest of this string'
      )
    }).not.toThrow()

    expect(html).not.toContain('<a ')
    expect(html).toContain('outer label, then a nested unterminated bracket')
    expect(html).toContain('with no closing bracket anywhere in the rest of this string')
  })

  it('applies a markdown-it-attrs brace on its own line without the mdc inline-props collision crashing the render', () => {
    /*
      Inline props (`{.class}`) and markdown-it-attrs both claim `{`. A brace that opens a line, or
      stands off behind a space, is markdown-it-attrs addressing the preceding block -- an inline
      rule taking it anyway silently drops the class.
    */
    const renderer = new MarkdownRenderer({})

    expect(() => {
      const html = renderer.render('> A quote\n{.is-warning}\n')
      expect(html).toContain('<blockquote class="is-warning')
    }).not.toThrow()
  })
})

describe('MarkdownRenderer -- block container plugin (OpenProject #3071)', () => {
  it('adds trailing props to a completed link rather than opening a new span', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('[Docs](https://example.com/docs){.external #docs-link}\n')

    expect(html).toMatch(
      /<a href="https:\/\/example\.com\/docs" class="[^"]*\bexternal\b[^"]*" id="docs-link">Docs<\/a>/
    )
    expect(html).not.toContain('<span')
  })

  it('adds trailing props to a completed image rather than opening a new span', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('![A photo](https://example.com/photo.jpg){.thumb}\n')

    expect(html).toContain('class="thumb"')
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/photo\.jpg"/)
    expect(html).not.toContain('<span')
  })

  it('leaves a brace after plain prose alone, for markdown-it-attrs to find instead', () => {
    // -> No just-closed link/image before it, and a space in front of it: markdown-it-attrs' own
    //    whole-paragraph shape, not a link/image's trailing props.
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('Some plain text\n{.is-warning}\n')

    expect(html).toMatch(/<p class="is-warning[^"]*"[^>]*>Some plain text<\/p>/)
  })

  it('does not let a literal "::" inside a fenced code body close the block early', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render(
      '::block-infobox{name="Example"}\n```text\nnotation: a::b\n::\nmore text\n```\n::\n'
    )

    expect(html).toContain('<block-infobox name="Example">')
    expect(html).toContain('notation: a::b')
    expect(html).toContain('more text')
    expect(html).toMatch(/<\/block-infobox>\s*$/)
  })

  it('joins several shorthand classes on an inline span', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('A [word]{.a .b} in a sentence.\n')

    expect(html).toContain('<span class="a b">word</span>')
  })

  /**
   * The WYSIWYG editor's text-colour/highlight/font-family marks serialize as this same
   * `[text]{style="…"}` span. `wikiSpan`'s `applyProps` has no attribute allowlist (unlike
   * `markdown-it-attrs`), so `style` reaches the rendered `<span>` regardless of the `mdAttrs`
   * whitelist; `backend/helpers/htmlSanitizePolicy.ts` restricts which declarations an author
   * without `write:styles` keeps.
   */
  it('keeps a style attribute on an inline bracket span', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('A [word]{style="color: #D32F2F;"} in a sentence.\n')

    expect(html).toContain('<span style="color: #D32F2F;">word</span>')
  })
})

/**
 * markdown-it's option is spelled `typographer` and it silently ignores unknown keys, so a misspelt
 * one fails invisibly. `quotes` only applies while `typographer` is on: the two settings live or die
 * together.
 */
describe('MarkdownRenderer - typographer setting (OpenProject #3150)', () => {
  it('replaces straight quotes with curly quotes when typographer is enabled (default english quotes)', () => {
    const renderer = new MarkdownRenderer({ typographer: true })
    const html = renderer.render('She said "hello" to \'him\'.\n')

    expect(html).toContain('“hello”')
    expect(html).toContain('‘him’')
    expect(html).not.toContain('"hello"')
    expect(html).not.toContain("'him'")
  })

  it('replaces (c) with the copyright glyph when typographer is enabled', () => {
    const renderer = new MarkdownRenderer({ typographer: true })
    const html = renderer.render('Copyright (c) Example\n')

    expect(html).toContain('©')
    expect(html).not.toContain('(c)')
  })

  it('honors a non-default quote style (french guillemets, the array-shaped quoteStyles entry)', () => {
    const renderer = new MarkdownRenderer({ typographer: true, quotes: 'french' })
    const html = renderer.render('She said "hello" to him.\n')

    expect(html).toContain('«\xA0hello\xA0»')
    expect(html).not.toContain('"hello"')
  })

  it('leaves straight quotes and a literal "(c)" alone when typographer is disabled', () => {
    const renderer = new MarkdownRenderer({ typographer: false })
    const html = renderer.render('She said "hello" to \'him\'. Copyright (c) Example\n')

    // -> markdown-it always HTML-escapes a literal `"` in text, whether or not typographer is on
    expect(html).toContain('&quot;hello&quot;')
    expect(html).toContain("'him'")
    expect(html).toContain('(c)')
    expect(html).not.toContain('“hello”')
    expect(html).not.toContain('©')
  })

  it('leaves straight quotes alone when typographer is left unset (default off)', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('She said "hello" to \'him\'.\n')

    expect(html).toContain('&quot;hello&quot;')
    expect(html).not.toContain('“hello”')
  })
})

/**
 * `id`, `class`, `target` and `style` are the only attributes let through onto the rendered element:
 * arbitrary attributes from page content (`onclick`, ...) are an XSS-adjacent surface
 * `markdown-it-attrs` does not fence off by default. The whitelist only decides whether the `style`
 * ATTRIBUTE survives at all; which CSS *declarations* inside it survive for an author without
 * `write:styles` is a separate boundary, `backend/helpers/htmlSanitizePolicy.ts`'s `ALLOWED_STYLES`.
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

  it('keeps the allowed style attribute (OpenProject #3398)', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('Centered paragraph {style="text-align: center;"}\n')

    expect(html).toContain('style="text-align: center;"')
  })

  it('drops an attribute not on the whitelist rather than rendering it', () => {
    const renderer = new MarkdownRenderer({})
    const html = renderer.render('# Heading {onclick=alert(1)}\n')

    expect(html).not.toContain('onclick')
  })
})

/*
  happy-dom's `document` never reports a `compatMode` (a real browser does, once it has parsed a
  doctype) and KaTeX warns to the console whenever it cannot confirm one -- a gap in the test DOM,
  not a real quirks-mode page.
*/
Object.defineProperty(document, 'compatMode', { value: 'CSS1Compat', configurable: true })

/**
 * The `$…$` / `$$…$$` mid-sentence TeX shorthand 2.5.x content authors: `::block-katex` needs a
 * fence and does not accept these delimiters.
 */
function render(src) {
  return new MarkdownRenderer().render(src)
}

describe('MarkdownRenderer -- inline and display TeX', () => {
  it('resolves inline $…$ TeX to a literal KaTeX span', () => {
    const html = render('The area is $\\pi r^2$ exactly.')
    expect(html).toContain('class="katex"')
    // -> The MathML accessibility annotation legitimately repeats the TeX source, so this checks the
    //    delimiters are gone rather than the TeX itself
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
 * Both are ordinary, well-supported KaTeX syntax that nothing in `TEX_INLINE`/`TEX_DISPLAY` or
 * `texMathHtml` singles out: these lock in that plain KaTeX usage survives this renderer's own
 * delimiter/currency-guard regexes.
 */
describe('MarkdownRenderer -- KaTeX edge cases (OpenProject #829 item 2)', () => {
  it('typesets a multi-character subscript written with braces', () => {
    const html = render('The element is $x_{ij}$ in the matrix.')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('tex-math-error')
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
 * Braces that are TeX syntax *inside* a `$…$`/`$$…$$` formula must never be read by
 * `markdown-it-attrs` as a trailing `{.class #id}` block. The `tex_math` inline rule is registered
 * `before('text', …)`, so it claims the whole `$…$` span -- braces included -- into one token's
 * content before `markdown-it-attrs` (a core rule over the already-built token stream) looks for a
 * `{…}` to attach. These guard that ordering.
 */
describe('MarkdownRenderer -- inline math braces are not consumed as markdown-it-attrs (OpenProject #829 item 3)', () => {
  it('does not let a multi-character subscript brace become an id/class attribute', () => {
    const html = render('The subscript is $x_{ij}$ here.')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('id="ij"')
    expect(html).not.toContain('class="ij"')
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
    expect(html).toMatch(/<p[^>]*>Another paragraph\.<\/p>/)
    expect(html).not.toMatch(/<p[^>]*class="[^"]*\bc\b/)
  })

  it('still applies a real markdown-it-attrs class written after (not inside) a formula', () => {
    // -> These braces trail the block on their own line, markdown-it-attrs' ordinary
    //    block-attribute position, so the formula's own rule must not be swallowing them
    const html = render('> The formula is $x^2$.\n{.is-warning}\n')
    expect(html).toContain('class="katex"')
    expect(html).toContain('<blockquote class="is-warning')
  })
})

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
    // -> Nested <a> tags are invalid HTML; a browser recovers by closing the outer link early,
    //    silently breaking the author's own link. The term keeps its tooltip via <abbr>.
    const md = new MarkdownRenderer({
      glossaryTerms: [
        { term: 'API', definition: 'Application Programming Interface', link: '/en/dev/api' }
      ]
    })
    const html = md.render('[Read the API docs](/manual)')

    expect(html).toContain(
      '<a href="/manual">Read the <abbr title="Application Programming Interface" class="glossary-term">API</abbr> docs</a>'
    )
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
 * Both hljs call sites import `highlight.js/lib/common`, a ~36-language subset, rather than the
 * package root, which registers all ~190 grammars it ships. Trimming cannot break rendering:
 * `highlight()` guards with `hljs.getLanguage(lang)` and falls back to escaped plain text -- now
 * also for a language that is real but is not bundled into `lib/common`.
 */
describe('MarkdownRenderer -- highlight.js/lib/common language set (OpenProject #1901)', () => {
  it('highlights a fenced block in a language retained by lib/common', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('```python\nimport os\n```')

    expect(html).toContain('language-python')
    // -> hljs's own span markup: proof the block ran through the highlighter, not just the escaper
    expect(html).toContain('class="hljs-keyword"')
    expect(html).toContain('>import<')
  })

  it('falls through to escaped, unhighlighted text for a language present in the full package but not in lib/common', () => {
    const md = new MarkdownRenderer({})
    // -> Haskell ships with the full `highlight.js` package but is not in lib/common
    const html = md.render('```haskell\nmain = putStrLn "<hi>"\n```')

    expect(html).toContain('language-haskell')
    expect(html).not.toContain('class="hljs-')
    expect(html).toContain('&lt;hi&gt;')
  })
})

/**
 * This render is both the live preview and what is stored on the page, so a stray class -- a `&&`
 * short-circuiting to the boolean `false` rather than to an empty string, say -- is written into
 * every page's HTML permanently.
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

describe('MarkdownRenderer -- fence info-string attributes (OpenProject #3578)', () => {
  const render = (info, body = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj') =>
    new MarkdownRenderer({}).render('```' + info + '\n' + body + '\n```')
  const highlightedRows = (html) => {
    const rows = html.match(
      /<span aria-hidden="true" class="line-numbers-rows">(.*?)<\/span><\/code>/s
    )
    if (!rows) {
      return []
    }
    return [...rows[1].matchAll(/<span( class="is-highlighted")?><\/span>/g)]
      .map((m, i) => (m[1] ? i + 1 : null))
      .filter(Boolean)
  }

  it('renders a fence with no attributes exactly as before', () => {
    const html = render('js', 'const x = 1\nconst y = 2')
    expect(html).toBe(
      '<pre class="codeblock hljs line-numbers"><code class="language-js"><span class="hljs-keyword">const</span> x = <span class="hljs-number">1</span>\n<span class="hljs-keyword">const</span> y = <span class="hljs-number">2</span>\n<span aria-hidden="true" class="line-numbers-rows"><span></span><span></span></span></code></pre>\n'
    )
    expect(html).not.toContain('data-line-start')
    expect(html).not.toContain('is-highlighted')
  })

  it('renders a fence with extra words but no key=value exactly as before', () => {
    const plain = render('js', 'a\nb')
    expect(render('js {1,3} some words', 'a\nb')).toBe(plain)
    expect(render('js title', 'a\nb')).toBe(plain)
  })

  it('emits data-line-start, never an inline style, for linesStart', () => {
    const html = render('yaml linesStart="30"')
    expect(html).toContain('<pre class="codeblock hljs line-numbers" data-line-start="30">')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('--code-line-start')
  })

  it('omits data-line-start at the default of 1 and for junk values', () => {
    for (const value of ['1', 'abc', '-3', '2.5', '', '99999999999999999999']) {
      expect(render(`yaml linesStart="${value}"`)).not.toContain('data-line-start')
    }
    expect(render('yaml linesStart=0')).toContain('data-line-start="0"')
  })

  it('accepts bare, double-quoted and single-quoted values', () => {
    expect(render('yaml linesStart=5')).toContain('data-line-start="5"')
    expect(render('yaml linesStart="5"')).toContain('data-line-start="5"')
    expect(render("yaml linesStart='5'")).toContain('data-line-start="5"')
  })

  it('folds attribute keys to lower case', () => {
    expect(render('yaml LINESSTART=5')).toContain('data-line-start="5"')
    expect(highlightedRows(render('yaml LINESHIGHLIGHT=2'))).toEqual([2])
  })

  it('marks the rows in linesHighlight, singles and ranges', () => {
    expect(highlightedRows(render('yaml linesHighlight="1,3,5-7"'))).toEqual([1, 3, 5, 6, 7])
  })

  it('reads a backwards range as the range it means', () => {
    expect(highlightedRows(render('yaml linesHighlight="7-5"'))).toEqual([5, 6, 7])
  })

  it('drops malformed highlight entries instead of failing', () => {
    expect(highlightedRows(render('yaml linesHighlight="2,x,3-,-4,a-b,,5"'))).toEqual([2, 5])
  })

  it('does not expand a huge range', () => {
    expect(highlightedRows(render('yaml linesHighlight="1-40000000"'))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    ])
  })

  it('compares highlights against the renumbered gutter', () => {
    expect(highlightedRows(render('yaml linesStart="30" linesHighlight="31-32"'))).toEqual([2, 3])
  })

  it('draws a row layer for a highlighted single-line block, but not the gutter class', () => {
    const html = render('yaml linesHighlight="1"', 'only: one')
    expect(html).toContain('<span class="is-highlighted"></span>')
    expect(html).toContain('class="codeblock hljs"')
  })

  it('keeps an escaped quote inside a quoted value from ending it', () => {
    const html = render('yaml title="Say \\"hi\\"" linesStart=4')
    expect(html).toContain('data-line-start="4"')
  })

  it('never lets an attribute value into the markup', () => {
    const html = render('yaml linesStart="3\\" onclick=\\"x" linesHighlight="1\\"><img src=x>"')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('<img')
  })

  it('still escapes the language name', () => {
    const html = render('"><img linesStart=3')
    expect(html).not.toContain('<img')
  })

  it('does not throw on an unknown language that carries attributes', () => {
    const html = render('nosuchlang linesStart=3 linesHighlight=1')
    expect(html).toContain('class="language-nosuchlang"')
    expect(html).toContain('data-line-start="3"')
  })

  it.each(['drawio', 'kroki', 'mermaid', 'plantuml', 'whiteboard'])(
    'ignores every attribute on a %s diagram fence',
    (lang) => {
      const html = render(`${lang} title="T" linesStart=5 linesHighlight=1`, 'A --> B')
      expect(html).toBe(`<pre class="codeblock-${lang}"><code>A --&gt; B\n</code></pre>\n`)
    }
  )
})

describe('MarkdownRenderer -- fence title bar (OpenProject #3583)', () => {
  const render = (info, body = 'a\nb\nc') =>
    new MarkdownRenderer({}).render('```' + info + '\n' + body + '\n```')
  const plain = render('yaml')

  it('wraps the block in a titled hljs container with the bar as a sibling of the pre', () => {
    const html = render('yaml title="Some title"')
    expect(html).toMatch(
      /^<div class="codeblock-titled hljs"><div class="codeblock-title">Some title<\/div><pre class="codeblock hljs line-numbers"><code class="language-yaml">/
    )
    expect(html).toMatch(/<\/code><\/pre><\/div>\n$/)
    expect(html.match(/<pre/g)).toHaveLength(1)
  })

  it('accepts a bare or single-quoted title', () => {
    expect(render('yaml title=config.yml')).toContain(
      '<div class="codeblock-title">config.yml</div>'
    )
    expect(render("yaml title='a b'")).toContain('<div class="codeblock-title">a b</div>')
  })

  it('trims the title', () => {
    expect(render('yaml title="  padded  "')).toContain('<div class="codeblock-title">padded</div>')
  })

  it('HTML-escapes the title and renders a script in it inert', () => {
    const html = render('yaml title="<script>alert(1)</script> & \\"q\\""')
    expect(html).not.toContain('<script>')
    expect(html).toContain(
      '<div class="codeblock-title">&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</div>'
    )
  })

  it('renders an empty title exactly as no title', () => {
    expect(render('yaml title=""')).toBe(plain)
  })

  it('renders a whitespace-only title exactly as no title', () => {
    expect(render('yaml title="   "')).toBe(plain)
    expect(render("yaml title='\t '")).toBe(plain)
  })

  it('renders a fence without a title with no wrapper', () => {
    expect(plain).not.toContain('codeblock-titled')
    expect(plain).not.toContain('codeblock-title')
  })

  it.each(['drawio', 'kroki', 'mermaid', 'plantuml', 'whiteboard'])(
    'never draws a bar on a %s diagram',
    (lang) => {
      const html = render(`${lang} title="Ignored"`, 'A --> B')
      expect(html).not.toContain('Ignored')
      expect(html).not.toContain('codeblock-title')
      expect(html).toBe(`<pre class="codeblock-${lang}"><code>A --&gt; B\n</code></pre>\n`)
    }
  )

  it('combines with linesHighlight and linesStart on the pre inside the wrapper', () => {
    const html = render('yaml title="T" linesStart=10 linesHighlight="11"')
    expect(html).toContain(
      '<div class="codeblock-titled hljs"><div class="codeblock-title">T</div><pre class="codeblock hljs line-numbers" data-line-start="10">'
    )
    expect(html).toContain('<span></span><span class="is-highlighted"></span><span></span>')
  })

  it('titles a single-line block with no gutter', () => {
    const html = render('yaml title="One"', 'only: one')
    expect(html).toContain('<div class="codeblock-title">One</div><pre class="codeblock hljs">')
  })

  it('titles a block whose language is unknown', () => {
    const html = render('nosuchlang title="T"')
    expect(html).toContain('<div class="codeblock-title">T</div>')
    expect(html).toContain('class="language-nosuchlang"')
  })
})

/**
 * `isExternalHref` judges a link's origin against `siteOrigin` when the render context supplies one,
 * rather than only `globalThis.location` -- what lets the headless re-render
 * (`backend/models/rendering.ts`, running in a browser navigated to its own loopback address, not
 * the site's hostname) classify a link the same way the editor's own save did. This file has no
 * DOM/`location` at all, so `siteOrigin` is the only origin in play in every case here.
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
 * A `::block-name{...}` whose attribute value contains a space was reported rendering as literal,
 * unparsed text through the real-browser Monaco input pipeline `e2e/tests/csp.spec.js` drives,
 * which a unit-level render cannot exercise -- it does not reproduce here. The cases below are
 * drawn from `csp.spec.js`'s own `BODY` and from deliberate attempts to break the same path, and
 * render with the site's real default editor config (`backend/models/sites.ts`'s `markdown.config`)
 * rather than an empty `{}`.
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

/*
 * `gatedContentPlaceholder`'s markup and wording are duplicated in the backend's
 * `helpers/htmlSanitizePolicy.ts` with no shared import, so each side pins the exact string.
 */
describe('gatedContentPlaceholder', () => {
  it('names the missing permission inside a "caution"-classed admonition', () => {
    const html = gatedContentPlaceholder('write:scripts')

    expect(html).toBe(
      '<blockquote class="is-danger"><p class="alert-title">Caution</p>' +
        '<p>This content requires the write:scripts permission and was not rendered.</p></blockquote>'
    )
  })
})

describe('sanitizeForPreview', () => {
  it('leaves the HTML untouched when the author holds both scripts and styles', () => {
    const html = '<iframe src="https://example.com"></iframe><style>body{color:red}</style>'

    expect(sanitizeForPreview(html, { scripts: true, styles: true })).toBe(html)
  })

  it('replaces an <iframe> with a "write:scripts" callout when scripts is not permitted', () => {
    const html = '<p>before</p><iframe src="https://example.com"></iframe><p>after</p>'

    const result = sanitizeForPreview(html, { scripts: false, styles: true })

    expect(result).not.toContain('<iframe')
    expect(result).toContain(gatedContentPlaceholder('write:scripts'))
    expect(result).toContain('<p>before</p>')
    expect(result).toContain('<p>after</p>')
  })

  it('replaces a <script> with the same "write:scripts" callout when scripts is not permitted', () => {
    const html = '<script>alert(1)</script>'

    const result = sanitizeForPreview(html, { scripts: false, styles: true })

    expect(result).not.toContain('<script')
    expect(result).not.toContain('alert(1)')
    expect(result).toContain(gatedContentPlaceholder('write:scripts'))
  })

  it('replaces a <style> with a "write:styles" callout when styles is not permitted', () => {
    const html = '<style>body{color:red}</style>'

    const result = sanitizeForPreview(html, { scripts: true, styles: false })

    expect(result).not.toContain('<style')
    expect(result).toContain(gatedContentPlaceholder('write:styles'))
  })

  it('leaves an <iframe> a script-permitted author wrote completely intact', () => {
    const html = '<iframe src="https://example.com" width="400"></iframe>'

    expect(sanitizeForPreview(html, { scripts: true, styles: false })).toContain(
      '<iframe src="https://example.com" width="400">'
    )
  })

  it('does not execute a gated <script> while scanning it for removal', () => {
    globalThis.__markdownTestSanitizeForPreviewRan = false
    const html = '<script>globalThis.__markdownTestSanitizeForPreviewRan = true</script>'

    sanitizeForPreview(html, { scripts: false, styles: false })

    expect(globalThis.__markdownTestSanitizeForPreviewRan).toBe(false)
    delete globalThis.__markdownTestSanitizeForPreviewRan
  })
})

describe('MarkdownRenderer definition lists', () => {
  it('renders a term with one definition as dl/dt/dd', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('Apple\n: A red fruit')

    expect(html).toContain('<dl>')
    expect(html).toContain('<dt>Apple</dt>')
    expect(html).toContain('<dd>')
    expect(html).toContain('A red fruit')
    expect(html).toContain('</dl>')
  })

  it('renders a term with two definitions as one dt followed by two dd', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('Apple\n: A red fruit\n: A technology company')

    expect(html.match(/<dt>/g)).toHaveLength(1)
    expect(html.match(/<dd>/g)).toHaveLength(2)
    expect(html).toContain('A red fruit')
    expect(html).toContain('A technology company')
  })

  it('renders a multi-paragraph definition as paragraphs inside one dd', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('Apple\n\n: First paragraph\n\n    Second paragraph')

    expect(html.match(/<dd>/g)).toHaveLength(1)
    expect(html).toMatch(
      /<dd>\s*<p[^>]*>First paragraph<\/p>\s*<p[^>]*>Second paragraph<\/p>\s*<\/dd>/
    )
  })

  it('leaves a plain `a: b` paragraph alone', () => {
    const md = new MarkdownRenderer({})
    const html = md.render('a: b')

    expect(html).toMatch(/<p[^>]*>a: b<\/p>/)
    expect(html).not.toMatch(/<(dl|dt|dd)[\s>]/)
  })
})
