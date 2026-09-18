import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from './htmlToMarkdown'

describe('htmlToMarkdown', () => {
  it('returns an empty markdown string and no images for a blank or whitespace-only payload', () => {
    expect(htmlToMarkdown('')).toEqual({ markdown: '', images: [] })
    expect(htmlToMarkdown('   \n  ')).toEqual({ markdown: '', images: [] })
    expect(htmlToMarkdown(undefined)).toEqual({ markdown: '', images: [] })
  })

  it('converts plain structural HTML -- headings, paragraphs, links, lists', () => {
    const html = `
      <h1>Title</h1>
      <p>A paragraph with a <a href="https://example.com">link</a>.</p>
      <ul><li>One</li><li>Two</li></ul>
      <ol><li>First</li><li>Second</li></ol>
    `
    const { markdown: md } = htmlToMarkdown(html)
    expect(md).toContain('# Title')
    expect(md).toContain('[link](https://example.com)')
    expect(md).toMatch(/-\s+One/)
    expect(md).toMatch(/-\s+Two/)
    expect(md).toMatch(/1\.\s+First/)
    expect(md).toMatch(/2\.\s+Second/)
  })

  it('converts a GFM table (from the gfm plugin)', () => {
    // @joplin/turndown-plugin-gfm pads every cell to a minimum of 3 characters -- upstream's
    // abandoned turndown-plugin-gfm did not, so this fixture's single-char cells ('A'/'B'/'1'/'2')
    // are the direct proof of that behaviour change (WP 3163).
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
    const { markdown: md } = htmlToMarkdown(html)
    expect(md).toContain('| A   | B   |')
    expect(md).toContain('| 1   | 2   |')
  })

  it('converts a headerless GFM table (behaviour change: @joplin/turndown-plugin-gfm converts it instead of leaving raw HTML)', () => {
    // Upstream turndown-plugin-gfm's `tables` rule refused a table with no `<th>` row, leaving the
    // whole `<table>` as literal HTML in the output. @joplin/turndown-plugin-gfm converts it,
    // synthesising a blank header row so the result is still valid GFM (WP 3163 acceptance
    // criteria: "Headerless tables now convert to Markdown instead of staying as HTML").
    const html = '<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>'
    const { markdown: md } = htmlToMarkdown(html)
    expect(md).not.toContain('<table>')
    expect(md).not.toContain('<td>')
    expect(md).toContain('| --- | --- |')
    expect(md).toContain('| 1   | 2   |')
    expect(md).toContain('| 3   | 4   |')
  })

  it('converts a newline inside a table cell to <br> (behaviour change)', () => {
    // WP 3163 acceptance criteria: "Newlines inside cells become <br>." -- a `<br>`, or any
    // block-level split (e.g. two `<p>`s), inside a `<td>`/`<th>` collapses to `<br>` in the cell's
    // markdown rather than breaking the table row across multiple lines.
    const html = '<table><tr><th>A</th></tr><tr><td>line one<br>line two</td></tr></table>'
    const { markdown: md } = htmlToMarkdown(html)
    expect(md).toContain('line one  <br>line two')
    expect(md.split('\n')).toHaveLength(3)
  })

  it('converts real <strong>/<em>/<del> tags via the gfm-provided strikethrough rule', () => {
    const html = '<p><strong>bold</strong> <em>italic</em> <del>gone</del></p>'
    const { markdown: md } = htmlToMarkdown(html)
    expect(md).toContain('**bold**')
    expect(md).toContain('_italic_')
    expect(md).toContain('~~gone~~')
  })

  it('converts a real <input type="checkbox"> list (the gfm plugin\'s taskListItems rule)', () => {
    const html =
      '<ul><li><input type="checkbox"> Todo</li><li><input type="checkbox" checked> Done</li></ul>'
    const { markdown: md } = htmlToMarkdown(html)
    expect(md).toMatch(/\[ \]\s*Todo/)
    expect(md).toMatch(/\[x\]\s*Done/)
  })

  describe('embedded images (OpenProject #2504)', () => {
    it('replaces an <img> with a pending-image placeholder and collects its src/alt', () => {
      const html =
        '<p>Before</p><img src="data:image/png;base64,AAAA" alt="screenshot"><p>After</p>'
      const { markdown, images } = htmlToMarkdown(html)
      expect(images).toEqual([
        { token: 'pending-image:0', src: 'data:image/png;base64,AAAA', alt: 'screenshot' }
      ])
      expect(markdown).toContain('![screenshot](pending-image:0)')
      expect(markdown).not.toContain('data:image')
      expect(markdown).toContain('Before')
      expect(markdown).toContain('After')
    })

    it('collects more than one image in document order, with distinct tokens', () => {
      const html =
        '<img src="data:image/png;base64,AAAA" alt="one">' +
        '<img src="blob:http://example.com/xyz" alt="two">'
      const { markdown, images } = htmlToMarkdown(html)
      expect(images.map((img) => img.token)).toEqual(['pending-image:0', 'pending-image:1'])
      expect(images[1]).toEqual({
        token: 'pending-image:1',
        src: 'blob:http://example.com/xyz',
        alt: 'two'
      })
      expect(markdown).toContain('![one](pending-image:0)')
      expect(markdown).toContain('![two](pending-image:1)')
    })

    it('drops an <img> with no src, and collects nothing for it', () => {
      const html = '<p>Before</p><img alt="broken"><p>After</p>'
      const { markdown, images } = htmlToMarkdown(html)
      expect(images).toEqual([])
      expect(markdown).not.toContain('![')
      expect(markdown).toContain('Before')
      expect(markdown).toContain('After')
    })

    it('defaults a missing alt attribute to an empty string', () => {
      const html = '<img src="data:image/png;base64,AAAA">'
      const { markdown, images } = htmlToMarkdown(html)
      expect(images).toEqual([
        { token: 'pending-image:0', src: 'data:image/png;base64,AAAA', alt: '' }
      ])
      expect(markdown).toBe('![](pending-image:0)')
    })

    it('collapses a multi-line alt (Word/OneNote OCR description, OpenProject #2534) to a single line so the placeholder stays resolvable', () => {
      const html =
        '<img src="data:image/png;base64,AAAA" alt="Hopper @ WIKD\n09 The Last of Us Part\nII Remastered">'
      const { markdown, images } = htmlToMarkdown(html)
      expect(images).toEqual([
        {
          token: 'pending-image:0',
          src: 'data:image/png;base64,AAAA',
          alt: 'Hopper @ WIKD 09 The Last of Us Part II Remastered'
        }
      ])
      // The placeholder in `markdown` must be a single line and match the `images[].alt` value
      // exactly -- a caller resolves it with a plain substring replace built from that same alt,
      // and `normalize()` trims trailing whitespace per-line across the whole document, so an
      // embedded raw newline here would desync the two and leave the placeholder unresolved.
      expect(markdown).toBe(
        '![Hopper @ WIKD 09 The Last of Us Part II Remastered](pending-image:0)'
      )
      expect(markdown).not.toContain('\n')
    })
  })

  describe('OneNote clipboard quirks (Feature #2417 validation case)', () => {
    it('converts inline-style bold/italic/underline/strikethrough spans -- OneNote/Office use presentational styles, not <b>/<i>/<u>/<s>', () => {
      const html = `
        <p>
          <span style="font-weight:bold">bold</span>
          <span style="font-style:italic">italic</span>
          <span style="text-decoration:underline">underlined</span>
          <span style="text-decoration:line-through">struck</span>
        </p>
      `
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).toContain('**bold**')
      expect(md).toContain('_italic_')
      expect(md).toContain('<u>underlined</u>')
      expect(md).toContain('~~struck~~')
    })

    it('does not double-wrap a real <strong>/<em>/<u> that also happens to carry a matching inline style', () => {
      const html =
        '<p><strong style="font-weight:bold">bold</strong> <u style="text-decoration:underline">under</u></p>'
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).toContain('**bold**')
      expect(md).not.toContain('****bold****')
      expect(md).toContain('<u>under</u>')
      expect(md).not.toContain('<u><u>under</u></u>')
    })

    it('preserves a mid-paragraph font-size change as a <span style="font-size: ..."> fallback (OpenProject #2505)', () => {
      const html = '<p>Normal <span style="font-size:18pt">bigger</span> normal again.</p>'
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).toContain('<span style="font-size: 18pt">bigger</span>')
      expect(md).toContain('Normal')
      expect(md).toContain('normal again')
    })

    it('does not wrap a whole block-level container in a font-size span -- only a mid-paragraph change', () => {
      const html =
        '<ul><li><div style="font-family:Calibri;font-size:11pt">First bullet</div></li></ul>'
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).toMatch(/-\s+First bullet/)
      expect(md).not.toContain('font-size')
    })

    it('rewrites a Unicode ballot-box to-do list to GFM task-list syntax', () => {
      const html = '<ul><li>☐ Unchecked task</li><li>☑ Checked task</li></ul>'
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).toMatch(/^-\s+\[ \]\s+Unchecked task/m)
      expect(md).toMatch(/^-\s+\[x\]\s+Checked task/m)
      expect(md).not.toContain('☐')
      expect(md).not.toContain('☑')
    })

    it('drops <style>/<script> element content rather than leaking it into the markdown', () => {
      const html = '<style>p { color: red; }</style><script>alert(1)</script><p>Visible text</p>'
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).toBe('Visible text')
    })

    it('strips a leaked CF_HTML clipboard header (Version:/StartFragment:/...) ahead of the markup', () => {
      const html =
        'Version:1.0\r\nStartHTML:0000000105\r\nEndHTML:0000000305\r\n' +
        'StartFragment:0000000141\r\nEndFragment:0000000269\r\n' +
        '<html><body><!--StartFragment--><p>hello <strong>world</strong></p><!--EndFragment--></body></html>'
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).toBe('hello **world**')
      expect(md).not.toContain('Version:')
      expect(md).not.toContain('StartFragment:')
    })

    it('realistic combined OneNote fixture: title paragraph, inline-styled emphasis, plain and to-do lists, a link', () => {
      const html = `
        <html><head><style>p.p1 { margin: 0px; font-size: 11pt; font-family: Calibri; }</style></head>
        <body>
        <!--StartFragment-->
        <div style="font-family:Calibri Light;font-size:24pt">Meeting Notes</div>
        <div style="font-family:Calibri;font-size:11pt">This is <span style="font-weight:bold">important</span> and <span style="font-style:italic">emphasized</span> text.</div>
        <ul>
          <li><div style="font-family:Calibri;font-size:11pt">First bullet</div></li>
          <li><div style="font-family:Calibri;font-size:11pt">Second bullet</div></li>
        </ul>
        <ul style="list-style-type:none">
          <li>☐ Follow up with the vendor</li>
          <li>☑ Send the recap email</li>
        </ul>
        <div style="font-family:Calibri;font-size:11pt">See <a href="https://example.com/notes">the shared notes</a>.</div>
        <!--EndFragment-->
        </body></html>
      `
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).not.toContain('font-family')
      expect(md).not.toContain('margin: 0px')
      expect(md).toContain('Meeting Notes')
      expect(md).toContain('**important**')
      expect(md).toContain('_emphasized_')
      expect(md).toMatch(/-\s+First bullet/)
      expect(md).toMatch(/-\s+Second bullet/)
      expect(md).toMatch(/-\s+\[ \]\s+Follow up with the vendor/)
      expect(md).toMatch(/-\s+\[x\]\s+Send the recap email/)
      expect(md).toContain('[the shared notes](https://example.com/notes)')
    })

    it('converts a real captured OneNote nested-list fixture (OpenProject #3423, comment 10078) to a properly indented nested markdown list', () => {
      // Real captured OneNote clipboard HTML, 4 levels deep, verbatim as posted to the work
      // package (not a re-simplified hand-built approximation -- the Bug's own history shows that
      // already produced a false "already works" read once before).
      const html = `
        <html><body>
        <!--StartFragment-->
        <ul class="BulletListStyle1" style="list-style-type: disc;">
        <li data-aria-level="2"><p>Level 1</p>
          <ul class="BulletListStyle2" style="list-style-type: circle;">
            <li data-aria-level="3"><p>Level 2 (nested)</p></li>
            <li data-aria-level="3"><p>Still level 2</p></li>
            <li data-aria-level="3"><p>More level 2</p></li>
          </ul>
        </li>
        <li data-aria-level="2"><p>Level 1 again</p></li>
        <li data-aria-level="2"><p>Another level 1</p>
          <ul class="BulletListStyle2" style="list-style-type: circle;">
            <li data-aria-level="3"><p>Level 2</p>
              <ul class="BulletListStyle3" style="list-style-type: square;">
                <li data-aria-level="4"><p>Level 3</p></li>
                <li data-aria-level="4"><p>Level 3</p></li>
                <li data-aria-level="4"><p>Level 3</p></li>
              </ul>
            </li>
            <li data-aria-level="3"><p>Level 2</p></li>
            <li data-aria-level="3"><p>Level 2</p></li>
          </ul>
        </li>
        <li data-aria-level="2"><p>Level 1</p></li>
        </ul>
        <!--EndFragment-->
        </body></html>
      `
      const { markdown: md } = htmlToMarkdown(html)
      // Every sub-bullet is indented 4 spaces per depth level under its own parent bullet, matching
      // turndown's own bulletListMarker width ('-   ') -- a flattened conversion would put every one
      // of these at column 0 instead.
      expect(md).toMatch(/^-\s+Level 1$/m)
      expect(md).toMatch(/^ {4}-\s+Level 2 \(nested\)$/m)
      expect(md).toMatch(/^ {4}-\s+Still level 2$/m)
      expect(md).toMatch(/^ {4}-\s+More level 2$/m)
      expect(md).toMatch(/^-\s+Level 1 again$/m)
      expect(md).toMatch(/^-\s+Another level 1$/m)
      expect(md).toMatch(/^ {4}-\s+Level 2$/m)
      expect(md).toMatch(/^ {8}-\s+Level 3$/m)
      expect(md).toMatch(/^-\s+Level 1$/m)
    })

    it('re-nests a sub-list written as an invalid, flat DOM sibling of its <li> (verified against real Chromium: not something any parser reparents on its own -- an Office-family clipboard convention for representing list depth without descendant nesting)', () => {
      const html =
        '<ul><li><p>Level 1</p></li><ul><li><p>Level 2 (nested)</p></li><li><p>Still level 2</p></li></ul><li><p>Level 1 again</p></li></ul>'
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).toMatch(/^-\s+Level 1$/m)
      expect(md).toMatch(/^ {4}-\s+Level 2 \(nested\)$/m)
      expect(md).toMatch(/^ {4}-\s+Still level 2$/m)
      expect(md).toMatch(/^-\s+Level 1 again$/m)
    })

    it('re-nests flat-sibling sub-lists at more than one depth in the same fixture', () => {
      const html =
        '<ul>' +
        '<li><p>Level 1</p></li>' +
        '<ul>' +
        '<li><p>Level 2</p></li>' +
        '<ul><li><p>Level 3</p></li></ul>' +
        '<li><p>Level 2 again</p></li>' +
        '</ul>' +
        '<li><p>Level 1 again</p></li>' +
        '</ul>'
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).toMatch(/^-\s+Level 1$/m)
      expect(md).toMatch(/^ {4}-\s+Level 2$/m)
      expect(md).toMatch(/^ {8}-\s+Level 3$/m)
      expect(md).toMatch(/^ {4}-\s+Level 2 again$/m)
      expect(md).toMatch(/^-\s+Level 1 again$/m)
    })

    it('leaves an already-nested sub-list (the common, well-formed case) alone', () => {
      const html = '<ul><li><p>Level 1</p><ul><li><p>Level 2</p></li></ul></li></ul>'
      const { markdown: md } = htmlToMarkdown(html)
      expect(md).toMatch(/^-\s+Level 1$/m)
      expect(md).toMatch(/^ {4}-\s+Level 2$/m)
    })
  })

  it('collapses runs of blank lines and trims trailing whitespace per line', () => {
    const html = '<p>One</p>\n\n\n\n<p>Two   </p>'
    const { markdown: md } = htmlToMarkdown(html)
    expect(md).not.toMatch(/\n{3,}/)
    expect(md).not.toMatch(/ +\n/)
    expect(md.startsWith('\n')).toBe(false)
    expect(md.endsWith('\n')).toBe(false)
  })
})
