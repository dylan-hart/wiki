import { describe, expect, it } from 'vitest'

import { MarkdownRenderer } from './markdown.js'

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
