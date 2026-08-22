import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import imsize from './markdown-it-imsize.js'

function render(src) {
  return new MarkdownIt().use(imsize).render(src)
}

describe('markdown-it-imsize', () => {
  it('renders a plain image with no size unchanged', () => {
    const html = render('![alt text](/photo.jpg)')
    expect(html).toContain('<img src="/photo.jpg" alt="alt text">')
    expect(html).not.toContain('width=')
    expect(html).not.toContain('height=')
  })

  it('parses a =WxH size suffix into width/height attributes', () => {
    const html = render('![alt](/photo.jpg =300x200)')
    expect(html).toContain('src="/photo.jpg"')
    expect(html).toContain('width="300"')
    expect(html).toContain('height="200"')
  })

  it('accepts a width-only size (=300x)', () => {
    const html = render('![alt](/photo.jpg =300x)')
    expect(html).toContain('width="300"')
    expect(html).not.toContain('height="')
  })

  it('accepts a height-only size (=x200)', () => {
    const html = render('![alt](/photo.jpg =x200)')
    expect(html).toContain('height="200"')
    expect(html).not.toContain('width="')
  })

  it('keeps a quoted title alongside the size', () => {
    const html = render('![alt](/photo.jpg "A title" =100x50)')
    expect(html).toContain('title="A title"')
    expect(html).toContain('width="100"')
    expect(html).toContain('height="50"')
  })

  it('requires a preceding space before the size marker -- "=WxH" glued to the title is not parsed as a size', () => {
    const html = render('![alt](/photo.jpg "title"=100x50)')
    expect(html).not.toContain('width=')
    expect(html).not.toContain('height=')
  })

  it('resolves a reference-style image against a defined reference, size untouched', () => {
    const html = render('![alt][ref]\n\n[ref]: /photo.jpg "Ref title"')
    expect(html).toContain('src="/photo.jpg"')
    expect(html).toContain('title="Ref title"')
  })

  it('leaves an image referencing an undefined label as literal text', () => {
    const html = render('![alt][missing]')
    expect(html).not.toContain('<img')
    expect(html).toContain('[missing]')
  })
})
