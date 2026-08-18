import { describe, expect, it } from 'vitest'

import { blockValues } from './markdownBlocks.js'

/**
 * `blockValues` is what the "Edit Block Parameters" lens opens the form on: a prop the page's source
 * says nothing about falls back to what the block would do if left alone. For a block whose admin
 * card offers a site-wide default (`config`, e.g. block-kroki/block-plantuml's "Server" field), that
 * fallback should be the site's configured value rather than the component's own hardcoded default —
 * an admin who has set one gets to see it reflected back, not silently overridden.
 */

const DEFINITION = {
  props: [
    { name: 'server', type: 'string', default: 'https://kroki.io' },
    { name: 'format', type: 'select', options: ['svg', 'png'], default: 'svg' }
  ]
}

describe('blockValues', () => {
  it('falls back to the prop default when the block has no site config', () => {
    const found = { attributes: [] }
    expect(blockValues(found, DEFINITION)).toEqual({ server: 'https://kroki.io', format: 'svg' })
  })

  it('falls back to the site config value over the prop default when the page omits the prop', () => {
    const found = { attributes: [] }
    const definition = { ...DEFINITION, config: { server: 'https://kroki.example.com' } }
    expect(blockValues(found, definition)).toEqual({
      server: 'https://kroki.example.com',
      format: 'svg'
    })
  })

  it('still prefers what the page itself wrote over both the site config and the prop default', () => {
    const found = { attributes: [{ name: 'server', value: 'https://from-the-page.example.com' }] }
    const definition = { ...DEFINITION, config: { server: 'https://kroki.example.com' } }
    expect(blockValues(found, definition)).toEqual({
      server: 'https://from-the-page.example.com',
      format: 'svg'
    })
  })

  it('ignores an empty-string site config value, falling back to the prop default', () => {
    const found = { attributes: [] }
    const definition = { ...DEFINITION, config: { server: '' } }
    expect(blockValues(found, definition)).toEqual({ server: 'https://kroki.io', format: 'svg' })
  })
})
