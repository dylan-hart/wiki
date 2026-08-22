import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import mdAttrs from 'markdown-it-attrs'
import githubAlerts from './github-alerts.js'

/*
  A plain markdown-it instance with only this plugin registered -- github-alerts.js runs a core rule
  over `blockquote_open`/`paragraph_open`/`inline` tokens that default markdown-it already produces,
  so it needs nothing else installed to be exercised directly (unlike markdown.test.js, which tests
  through the full app renderer).
*/
function render(src) {
  return new MarkdownIt().use(githubAlerts).render(src)
}

// -> Only the "already-classed blockquote" case needs markdown-it-attrs (the app's own renderer
//    always has both installed) -- attrJoin has nothing to join onto without it.
function renderWithAttrs(src) {
  return new MarkdownIt().use(mdAttrs).use(githubAlerts).render(src)
}

describe('github-alerts', () => {
  it.each([
    ['note', 'is-info', 'Note'],
    ['tip', 'is-success', 'Tip'],
    ['important', 'is-important', 'Important'],
    ['warning', 'is-warning', 'Warning'],
    ['caution', 'is-danger', 'Caution']
  ])(
    'maps [!%s] to the %s admonition class with its own default title',
    (kind, className, label) => {
      const html = render(`> [!${kind.toUpperCase()}]\n> Body text`)
      expect(html).toContain(`class="${className}"`)
      expect(html).toContain(`<p class="alert-title">${label}</p>`)
      expect(html).toContain('Body text')
    }
  )

  it('is case-insensitive on the marker keyword', () => {
    const html = render('> [!NoTe]\n> Body')
    expect(html).toContain('class="is-info"')
  })

  it("uses the author's own text after the marker as the title instead of the kind's label", () => {
    const html = render('> [!NOTE] Read this first\n> Body text')
    expect(html).toContain('<p class="alert-title">Read this first</p>')
    expect(html).not.toContain('>Note<')
  })

  it('falls back to the label when the text after the marker is only whitespace', () => {
    const html = render('> [!NOTE]   \n> Body text')
    expect(html).toContain('<p class="alert-title">Note</p>')
  })

  it('parses markdown inside an author-supplied title', () => {
    const html = render('> [!NOTE] Read **this** first\n> Body')
    expect(html).toContain('<p class="alert-title">Read <strong>this</strong> first</p>')
  })

  it('joins the admonition class onto an already-classed blockquote rather than replacing it', () => {
    const html = renderWithAttrs('> [!TIP]\n> Body\n{.custom-class}')
    expect(html).toMatch(/class="custom-class is-success"|class="is-success custom-class"/)
  })

  it('leaves an ordinary blockquote with no marker untouched', () => {
    const html = render('> Just a quote, nothing special')
    expect(html).not.toMatch(/is-info|is-success|is-important|is-warning|is-danger/)
    expect(html).not.toContain('alert-title')
    expect(html).toContain('Just a quote, nothing special')
  })

  it('ignores an unrecognized bracketed kind', () => {
    const html = render('> [!BOGUS]\n> Body')
    expect(html).not.toContain('alert-title')
    expect(html).toContain('[!BOGUS]')
  })

  it('only claims the marker when it opens the blockquote (a mid-quote line is left alone)', () => {
    const html = render('> Some text\n> [!NOTE]\n> more')
    expect(html).not.toContain('alert-title')
  })
})
