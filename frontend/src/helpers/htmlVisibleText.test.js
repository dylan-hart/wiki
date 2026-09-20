import { describe, expect, it } from 'vitest'
import { htmlToVisibleText, isSameVisibleText } from './htmlVisibleText.js'

describe('htmlToVisibleText (OpenProject #2834)', () => {
  it('returns an empty string for a blank/whitespace-only payload', () => {
    expect(htmlToVisibleText('')).toBe('')
    expect(htmlToVisibleText('   \n  ')).toBe('')
  })

  it('strips tags and decodes entities from a simple fragment', () => {
    expect(htmlToVisibleText('<p>Hello &amp; welcome</p>')).toContain('Hello & welcome')
  })

  it('puts each Monaco-style per-line <div> on its own line, with no blank line between them', () => {
    const html = '<div>line one</div><div>line two</div><div>line three</div>'
    const text = htmlToVisibleText(html)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    expect(text).toEqual(['line one', 'line two', 'line three'])
  })

  it('treats a <br> the same as a block boundary, for an empty Monaco line', () => {
    const html = '<div>A</div><div><br></div><div>B</div>'
    const text = htmlToVisibleText(html)
      .split('\n')
      .map((line) => line.trim())
    expect(text.filter((line) => line.length > 0)).toEqual(['A', 'B'])
    expect(text.some((line) => line === '')).toBe(true)
  })

  it('drops <style>/<script> contents rather than leaking them into the visible text', () => {
    const html = '<p>Visible</p><style>.x { color: red }</style><script>doThing()</script>'
    expect(htmlToVisibleText(html)).not.toMatch(/color|doThing/)
  })

  it('unwraps a full document shell the same way a real clipboard payload arrives', () => {
    const html = '<html><body><p>Hello world</p></body></html>'
    expect(htmlToVisibleText(html).trim()).toBe('Hello world')
  })

  it('strips a CF_HTML (Office/OneNote) clipboard header before parsing', () => {
    const html =
      'Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000200\r\n' +
      '<html><body><!--StartFragment--><p>Copied text</p><!--EndFragment--></body></html>'
    expect(htmlToVisibleText(html)).toContain('Copied text')
    expect(htmlToVisibleText(html)).not.toContain('StartHTML')
  })
})

describe('isSameVisibleText (OpenProject #2834)', () => {
  it('matches a same-editor Monaco-style copy against its text/plain sibling', () => {
    const html =
      '<div><span style="color:#569cd6">const</span> <span style="color:#9cdcfe">x</span> = 1</div>' +
      '<div><span style="color:#569cd6">const</span> <span style="color:#9cdcfe">y</span> = 2</div>'
    const text = 'const x = 1\nconst y = 2'
    expect(isSameVisibleText(html, text)).toBe(true)
  })

  it('matches when Monaco represents indentation with &nbsp; runs and text/plain uses real spaces', () => {
    const html = '<div>&nbsp;&nbsp;&nbsp;&nbsp;indented()</div><div>unindented()</div>'
    const text = '    indented()\nunindented()'
    expect(isSameVisibleText(html, text)).toBe(true)
  })

  it('does not match when the HTML carries real structure text/plain lacks (a table)', () => {
    const html = '<table><tr><td>Name</td><td>Score</td></tr><tr><td>A</td><td>1</td></tr></table>'
    // -> A browser's `text/plain` for a copied table joins each row's cells on one line, where
    //    this reduction gives one cell per line -- so a table paste reliably diverges.
    const text = 'Name\tScore\nA\t1'
    expect(isSameVisibleText(html, text)).toBe(false)
  })

  // -> Accepted limitation: reduced to bare visible text, a rich paste of emphasized words is
  //    indistinguishable from a same-editor copy. Detecting it is worse than skipping conversion,
  //    since Monaco emits incidental inline bold/italic for some theme tokens and preserving THAT
  //    as markdown is the corruption this gate exists to stop.
  it('matches (and so skips conversion) when only inline emphasis differs, by design', () => {
    const html = '<p>Hello <strong>world</strong></p>'
    const text = 'Hello world'
    expect(isSameVisibleText(html, text)).toBe(true)
  })

  it('does not match a genuinely different payload (unrelated text/plain)', () => {
    expect(isSameVisibleText('<p>Hello</p>', 'Something else entirely')).toBe(false)
  })

  it('does not match rich content with no accompanying text/plain at all', () => {
    expect(isSameVisibleText('<p>Hello <strong>world</strong></p>', '')).toBe(false)
  })

  it('does not match an image-only paste against an empty text/plain (OpenProject #2504 regression)', () => {
    // -> Both sides reduce to '', so a naive equality would skip the conversion and drop the image.
    const html = '<img src="data:image/png;base64,AAAA" alt="screenshot">'
    expect(isSameVisibleText(html, '')).toBe(false)
  })
})
