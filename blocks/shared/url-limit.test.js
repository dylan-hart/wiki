import { describe, expect, it } from 'vitest'

import { MAX_DIAGRAM_URL_LENGTH, explainUrlTooLarge } from './url-limit.js'

/**
 * OpenProject #1968 / testing.md §6: `url-limit.js` is shared by `block-kroki` and `block-plantuml`
 * and had no test of its own -- only exercised as a side effect of each block's own suite.
 */
describe('shared/url-limit.js', () => {
  it('exports the documented 8,000-character ceiling', () => {
    expect(MAX_DIAGRAM_URL_LENGTH).toBe(8000)
  })

  describe('explainUrlTooLarge()', () => {
    it('mentions both the actual length and the limit in the message', () => {
      const message = explainUrlTooLarge(MAX_DIAGRAM_URL_LENGTH - 1)

      expect(message).toContain((MAX_DIAGRAM_URL_LENGTH - 1).toLocaleString())
      expect(message).toContain(MAX_DIAGRAM_URL_LENGTH.toLocaleString())
    })

    it('reports the actual length and the limit for a URL exactly at the limit', () => {
      const length = MAX_DIAGRAM_URL_LENGTH
      const message = explainUrlTooLarge(length)

      expect(message).toContain(length.toLocaleString())
      expect(message).toContain(MAX_DIAGRAM_URL_LENGTH.toLocaleString())
    })

    it('points at the Mermaid block as the escape hatch, for a length just over the limit', () => {
      const message = explainUrlTooLarge(MAX_DIAGRAM_URL_LENGTH + 1)

      expect(message).toContain((MAX_DIAGRAM_URL_LENGTH + 1).toLocaleString())
      expect(message).toMatch(/mermaid/i)
    })
  })
})
