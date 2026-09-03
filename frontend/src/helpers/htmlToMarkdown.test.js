import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from './htmlToMarkdown'

describe('htmlToMarkdown', () => {
  it('returns an empty string for a blank or whitespace-only payload', () => {
    expect(htmlToMarkdown('')).toBe('')
    expect(htmlToMarkdown('   \n  ')).toBe('')
    expect(htmlToMarkdown(undefined)).toBe('')
  })

  it('converts plain structural HTML -- headings, paragraphs, links, lists', () => {
    const html = `
      <h1>Title</h1>
      <p>A paragraph with a <a href="https://example.com">link</a>.</p>
      <ul><li>One</li><li>Two</li></ul>
      <ol><li>First</li><li>Second</li></ol>
    `
    const md = htmlToMarkdown(html)
    expect(md).toContain('# Title')
    expect(md).toContain('[link](https://example.com)')
    expect(md).toMatch(/-\s+One/)
    expect(md).toMatch(/-\s+Two/)
    expect(md).toMatch(/1\.\s+First/)
    expect(md).toMatch(/2\.\s+Second/)
  })

  it('converts a GFM table (from the gfm plugin)', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('| A | B |')
    expect(md).toContain('| 1 | 2 |')
  })

  it('converts real <strong>/<em>/<del> tags via the gfm-provided strikethrough rule', () => {
    const html = '<p><strong>bold</strong> <em>italic</em> <del>gone</del></p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('**bold**')
    expect(md).toContain('_italic_')
    expect(md).toContain('~~gone~~')
  })

  it('converts a real <input type="checkbox"> list (the gfm plugin\'s taskListItems rule)', () => {
    const html =
      '<ul><li><input type="checkbox"> Todo</li><li><input type="checkbox" checked> Done</li></ul>'
    const md = htmlToMarkdown(html)
    expect(md).toMatch(/\[ \]\s*Todo/)
    expect(md).toMatch(/\[x\]\s*Done/)
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
      const md = htmlToMarkdown(html)
      expect(md).toContain('**bold**')
      expect(md).toContain('_italic_')
      expect(md).toContain('<u>underlined</u>')
      expect(md).toContain('~~struck~~')
    })

    it('does not double-wrap a real <strong>/<em>/<u> that also happens to carry a matching inline style', () => {
      const html =
        '<p><strong style="font-weight:bold">bold</strong> <u style="text-decoration:underline">under</u></p>'
      const md = htmlToMarkdown(html)
      expect(md).toContain('**bold**')
      expect(md).not.toContain('****bold****')
      expect(md).toContain('<u>under</u>')
      expect(md).not.toContain('<u><u>under</u></u>')
    })

    it('rewrites a Unicode ballot-box to-do list to GFM task-list syntax', () => {
      const html = '<ul><li>☐ Unchecked task</li><li>☑ Checked task</li></ul>'
      const md = htmlToMarkdown(html)
      expect(md).toMatch(/^-\s+\[ \]\s+Unchecked task/m)
      expect(md).toMatch(/^-\s+\[x\]\s+Checked task/m)
      expect(md).not.toContain('☐')
      expect(md).not.toContain('☑')
    })

    it('drops <style>/<script> element content rather than leaking it into the markdown', () => {
      const html = '<style>p { color: red; }</style><script>alert(1)</script><p>Visible text</p>'
      const md = htmlToMarkdown(html)
      expect(md).toBe('Visible text')
    })

    it('drops inline images instead of inlining a base64 blob (image-paste-to-asset-upload is #2449, not this)', () => {
      const html =
        '<p>Before</p><img src="data:image/png;base64,AAAA" alt="screenshot"><p>After</p>'
      const md = htmlToMarkdown(html)
      expect(md).not.toContain('data:image')
      expect(md).not.toContain('![')
      expect(md).toContain('Before')
      expect(md).toContain('After')
    })

    it('strips a leaked CF_HTML clipboard header (Version:/StartFragment:/...) ahead of the markup', () => {
      const html =
        'Version:1.0\r\nStartHTML:0000000105\r\nEndHTML:0000000305\r\n' +
        'StartFragment:0000000141\r\nEndFragment:0000000269\r\n' +
        '<html><body><!--StartFragment--><p>hello <strong>world</strong></p><!--EndFragment--></body></html>'
      const md = htmlToMarkdown(html)
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
      const md = htmlToMarkdown(html)
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
  })

  it('collapses runs of blank lines and trims trailing whitespace per line', () => {
    const html = '<p>One</p>\n\n\n\n<p>Two   </p>'
    const md = htmlToMarkdown(html)
    expect(md).not.toMatch(/\n{3,}/)
    expect(md).not.toMatch(/ +\n/)
    expect(md.startsWith('\n')).toBe(false)
    expect(md.endsWith('\n')).toBe(false)
  })
})
