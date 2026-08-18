import { afterEach, describe, expect, it } from 'vitest'

import './component.js'

/**
 * `block-kroki` encodes diagram source straight into a GET URL with no POST fallback (see
 * `docs/variances.md`). A diagram large enough to push that URL past what a reverse proxy will
 * accept used to fail silently as a generic broken-image message via `_explain()`, once the browser
 * actually tried to load it. This locks down the pre-flight guard instead: `firstUpdated()` checks
 * the encoded URL's length itself and reports a clear, actionable `.error` before any request is
 * made.
 */

async function mountKroki(body = '', attrs = {}) {
  const el = document.createElement('block-kroki')
  const pre = document.createElement('pre')
  pre.textContent = body
  el.appendChild(pre)
  Object.assign(el, attrs)
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-kroki', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('draws a small diagram normally, with no error', async () => {
    const el = await mountKroki('digraph G {\n  Hello -> World\n}')

    expect(el.shadowRoot.querySelector('.error')).toBeNull()
    const img = el.shadowRoot.querySelector('img')
    expect(img).not.toBeNull()
    expect(img.src).toContain('kroki.io')
  })

  it('refuses to draw a diagram whose encoded URL is too large for a GET request', async () => {
    // -> Deflate won't shrink this below the threshold: high-entropy content, well past 8,000 chars
    //    once encoded even after compression
    const huge = Array.from(
      { length: 20000 },
      (_, i) => `node${i} [label="${Math.random()}"];`
    ).join('\n')
    const el = await mountKroki(huge)

    const error = el.shadowRoot.querySelector('.error')
    expect(error).not.toBeNull()
    expect(error.textContent).toContain('too large')
    expect(error.textContent).toContain('Mermaid')
    expect(error.textContent).toContain('Diagram block')
    // -> No request should ever have been attempted for a diagram refused before it was drawn
    expect(el.shadowRoot.querySelector('img')).toBeNull()
  })
})
