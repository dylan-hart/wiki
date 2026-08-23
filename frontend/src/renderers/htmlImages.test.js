import { describe, expect, it } from 'vitest'

import { fileSrc, rewriteHtmlImages } from './htmlImages.js'

describe('fileSrc', () => {
  it('resolves a path relative to the site root under /_files/', () => {
    expect(fileSrc('/media/photo.png')).toBe('/_files/media/photo.png')
  })

  it('resolves a bare file name relative to the page folder', () => {
    expect(fileSrc('photo.png', 'docs/getting-started')).toBe('/_files/docs/photo.png')
  })

  it('resolves a page-relative path with ./ and ../ segments', () => {
    expect(fileSrc('../assets/photo.png', 'docs/guides/intro')).toBe(
      '/_files/docs/assets/photo.png'
    )
  })

  it('resolves relative to the site root when no page path is known', () => {
    expect(fileSrc('photo.png')).toBe('/_files/photo.png')
  })

  it('leaves an absolute http(s) URL untouched', () => {
    expect(fileSrc('https://example.com/photo.png')).toBe('https://example.com/photo.png')
  })

  it('leaves a data: URI untouched', () => {
    expect(fileSrc('data:image/png;base64,abc123')).toBe('data:image/png;base64,abc123')
  })

  it('leaves a blob: URI untouched (a pending upload not yet saved)', () => {
    expect(fileSrc('blob:http://localhost/abc-123')).toBe('blob:http://localhost/abc-123')
  })

  it('leaves a protocol-relative URL untouched', () => {
    expect(fileSrc('//example.com/photo.png')).toBe('//example.com/photo.png')
  })

  it('leaves a bare fragment untouched', () => {
    expect(fileSrc('#anchor')).toBe('#anchor')
  })

  it('leaves a path the server already owns untouched, /_files/ included', () => {
    expect(fileSrc('/_files/media/photo.png')).toBe('/_files/media/photo.png')
    expect(fileSrc('/_assets/logo.svg')).toBe('/_assets/logo.svg')
  })

  it('leaves an empty source untouched', () => {
    expect(fileSrc('')).toBe('')
    expect(fileSrc(undefined)).toBe(undefined)
  })

  it('encodes a space in the resolved path', () => {
    expect(fileSrc('my photo.png')).toBe('/_files/my%20photo.png')
  })
})

describe('rewriteHtmlImages', () => {
  it('rewrites a double-quoted src', () => {
    expect(rewriteHtmlImages('<img src="photo.png" alt="x">', '')).toBe(
      '<img src="/_files/photo.png" alt="x">'
    )
  })

  it('rewrites a single-quoted src', () => {
    expect(rewriteHtmlImages("<img src='photo.png'>", '')).toBe('<img src="/_files/photo.png">')
  })

  it('rewrites an unquoted src', () => {
    expect(rewriteHtmlImages('<img src=photo.png>', '')).toBe('<img src="/_files/photo.png">')
  })

  it('leaves data-src and similar attributes alone', () => {
    const html = '<img data-src="photo.png" src="real.png">'
    expect(rewriteHtmlImages(html, '')).toBe('<img data-src="photo.png" src="/_files/real.png">')
  })

  it('rewrites every <img> in the string, resolved against the page folder', () => {
    const html = '<img src="a.png"><p>text</p><img src="b.png">'
    expect(rewriteHtmlImages(html, 'docs/page')).toBe(
      '<img src="/_files/docs/a.png"><p>text</p><img src="/_files/docs/b.png">'
    )
  })

  it('leaves an already-external src untouched', () => {
    const html = '<img src="https://example.com/photo.png">'
    expect(rewriteHtmlImages(html, '')).toBe(html)
  })
})
