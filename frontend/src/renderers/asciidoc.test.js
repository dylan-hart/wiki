import { describe, expect, it } from 'vitest'

import { AsciidocRenderer } from './asciidoc.js'

/*
  No DOM dependency -- Asciidoctor.js converts in plain JS -- so these instantiate and render
  directly, the same way `markdown.test.js` exercises `MarkdownRenderer`.
*/

describe('AsciidocRenderer', () => {
  it('converts basic AsciiDoc markup to HTML', async () => {
    const renderer = new AsciidocRenderer()
    const html = await renderer.render('Some *bold* and _italic_ text.')

    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
  })

  it('renders the document title into the body', async () => {
    const renderer = new AsciidocRenderer()
    const html = await renderer.render('= Page Title\n\nBody text.')

    expect(html).toContain('<h1>Page Title</h1>')
  })

  it('renders a fragment, not a full HTML document', async () => {
    const renderer = new AsciidocRenderer()
    const html = await renderer.render('Hello.')

    expect(html).not.toContain('<!DOCTYPE')
    expect(html).not.toContain('<html')
  })

  it('returns an empty render for empty source', async () => {
    const renderer = new AsciidocRenderer()

    expect(await renderer.render('')).toBe('')
    expect(await renderer.render(undefined)).toBe('')
  })

  it('converts headings, lists and code blocks', async () => {
    const renderer = new AsciidocRenderer()
    const html = await renderer.render(
      '== Section\n\n* one\n* two\n\n[source,js]\n----\nconst x = 1\n----'
    )

    expect(html).toContain('<h2 id="_section">Section</h2>')
    expect(html).toContain('<ul>')
    expect(html).toContain('const x = 1')
  })

  it('resolves an image macro path against the /_files/ URL, relative to the page folder', async () => {
    const renderer = new AsciidocRenderer()
    const html = await renderer.render('image::photo.png[Alt text]', {
      pagePath: 'docs/getting-started'
    })

    expect(html).toContain('src="/_files/docs/photo.png"')
  })

  it('resolves a site-root-relative image macro path (as written by insertAssetClb)', async () => {
    const renderer = new AsciidocRenderer()
    const html = await renderer.render('image::/media/photo.png[Alt text]')

    expect(html).toContain('src="/_files/media/photo.png"')
  })

  it('leaves an absolute image URL untouched', async () => {
    const renderer = new AsciidocRenderer()
    const html = await renderer.render('image::https://example.com/photo.png[Alt text]')

    expect(html).toContain('src="https://example.com/photo.png"')
  })

  it('does not read the local filesystem for an include directive', async () => {
    const renderer = new AsciidocRenderer()
    const html = await renderer.render('include::/etc/passwd[]')

    expect(html).not.toContain('root:')
    expect(html).toContain('/etc/passwd')
  })
})
