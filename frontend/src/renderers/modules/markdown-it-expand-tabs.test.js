import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import expandTabs from './markdown-it-expand-tabs.js'

function render(src, opts) {
  return new MarkdownIt().use(expandTabs, opts).render(src)
}

describe('markdown-it-expand-tabs', () => {
  it('expands a leading tab in a fenced code block to the configured tabWidth', () => {
    const html = render('```\n\tconst x = 1\n```\n', { tabWidth: 4 })
    expect(html).toContain('    const x = 1')
    expect(html).not.toContain('\t')
  })

  it('expands a run of several leading tabs, one group of spaces per tab', () => {
    const html = render('```\n\t\t\tx\n```\n', { tabWidth: 2 })
    expect(html).toContain('      x')
    expect(html).not.toContain('\t')
  })

  it('defaults tabWidth to 2 spaces when the option is omitted entirely', () => {
    const html = render('```\n\tx\n```\n')
    expect(html).toContain('  x')
  })

  it('honors an explicit tabWidth of 0 rather than treating it as unset', () => {
    const html = render('```\n\tx\n```\n', { tabWidth: 0 })
    expect(html).toContain('>x')
    expect(html).not.toContain('\t')
  })

  it('leaves a tab that is not at the start of a line untouched', () => {
    const html = render('```\nconst\tx = 1\n```\n', { tabWidth: 4 })
    expect(html).toContain('const\tx = 1')
  })

  it('leaves tabs in non-fence content untouched', () => {
    const html = render('a\tb\n\n\tindented paragraph text\n', { tabWidth: 4 })
    expect(html).toContain('a\tb')
  })

  it('preserves the fence info string (language) unchanged', () => {
    const html = render('```js\n\tconst x = 1\n```\n', { tabWidth: 4 })
    expect(html).toContain('language-js')
  })

  it('expands leading tabs independently on each line of a multi-line fence', () => {
    const html = render('```\n\ta\n\t\tb\nc\n```\n', { tabWidth: 2 })
    expect(html).toContain('  a')
    expect(html).toContain('    b')
    expect(html).toContain('c')
    expect(html).not.toContain('\t')
  })
})
