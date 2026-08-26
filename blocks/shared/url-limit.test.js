import { describe, expect, it } from 'vitest'

import { explainUrlTooLarge, MAX_DIAGRAM_URL_LENGTH } from './url-limit.js'

describe('shared/url-limit.js: explainUrlTooLarge()', () => {
  it('reports the actual length and the limit for a URL one character under the limit', () => {
    const length = MAX_DIAGRAM_URL_LENGTH - 1
    const message = explainUrlTooLarge(length)

    expect(message).toContain(length.toLocaleString())
    expect(message).toContain(MAX_DIAGRAM_URL_LENGTH.toLocaleString())
  })

  it('reports the actual length and the limit for a URL exactly at the limit', () => {
    const length = MAX_DIAGRAM_URL_LENGTH
    const message = explainUrlTooLarge(length)

    expect(message).toContain(length.toLocaleString())
    expect(message).toContain(MAX_DIAGRAM_URL_LENGTH.toLocaleString())
  })

  it('reports the actual length and the limit for a URL one character over the limit', () => {
    const length = MAX_DIAGRAM_URL_LENGTH + 1
    const message = explainUrlTooLarge(length)

    expect(message).toContain(length.toLocaleString())
    expect(message).toContain(MAX_DIAGRAM_URL_LENGTH.toLocaleString())
  })

  it('points readers at the Mermaid block as the URL-size-limit-free escape hatch', () => {
    const message = explainUrlTooLarge(MAX_DIAGRAM_URL_LENGTH + 1)

    expect(message).toContain('Mermaid')
  })
})
