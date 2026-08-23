import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import underline from './markdown-it-underline.js'

function render(src) {
  return new MarkdownIt().use(underline).render(src)
}

describe('markdown-it-underline', () => {
  it('renders _single underscore_ emphasis as <u> instead of <em>', () => {
    const html = render('_underlined_')
    expect(html).toContain('<u>underlined</u>')
    expect(html).not.toContain('<em>')
  })

  it('leaves __double underscore__ strong rendering as <strong> -- only em (markup === "_") is remapped', () => {
    const html = render('__strong__')
    expect(html).toContain('<strong>strong</strong>')
    expect(html).not.toContain('<u>')
  })

  it('leaves *asterisk* emphasis rendering as <em>, unaffected', () => {
    const html = render('*emphasized*')
    expect(html).toContain('<em>emphasized</em>')
    expect(html).not.toContain('<u>')
  })

  it('leaves **double asterisk** strong rendering as <strong>, unaffected', () => {
    const html = render('**strong**')
    expect(html).toContain('<strong>strong</strong>')
    expect(html).not.toContain('<u>')
  })

  it('supports nesting an asterisk emphasis inside an underscore one', () => {
    const html = render('_a *b* c_')
    expect(html).toContain('<u>a <em>b</em> c</u>')
  })
})
