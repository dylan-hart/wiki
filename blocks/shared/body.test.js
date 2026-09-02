import { afterEach, describe, expect, it } from 'vitest'

import { readFencedSource } from './body.js'

function bodyWith(markup) {
  const host = document.createElement('div')
  host.innerHTML = markup
  document.body.appendChild(host)
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('shared/body.js: readFencedSource()', () => {
  it('reads the fence when there is one, and says so', () => {
    const el = bodyWith('<pre><code>graph TD;\n  A --&gt; B</code></pre>')

    expect(readFencedSource(el)).toEqual({ source: 'graph TD;\n  A --> B', fenced: true })
  })

  it("reads the element's own text when there is no fence, and says so", () => {
    const el = bodyWith('<p>x = 1</p>')

    expect(readFencedSource(el)).toEqual({ source: 'x = 1', fenced: false })
  })

  it('trims the surrounding whitespace markdown leaves behind', () => {
    const el = bodyWith('<pre>\n  A --> B\n</pre>')

    expect(readFencedSource(el).source).toBe('A --> B')
  })

  it('reads an empty body as an empty source rather than throwing', () => {
    const el = bodyWith('')

    expect(readFencedSource(el)).toEqual({ source: '', fenced: false })
  })

  it('prefers the fence even when there is other content beside it', () => {
    const el = bodyWith('<p>ignored</p><pre>kept</pre>')

    expect(readFencedSource(el)).toEqual({ source: 'kept', fenced: true })
  })
})
