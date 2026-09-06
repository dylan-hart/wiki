import { describe, expect, it } from 'vitest'

import { propDefault, seedConfigValues } from './blocks.js'

/**
 * WP #1745: the seam between an admin's site-wide `config` (block-kroki/block-plantuml's "Server"
 * field, set on the admin Blocks page) and a prop's own hardcoded default -- what
 * `BlockPickerOverlay` and the "Edit Block Parameters" lens both seed a form from. Before this fix,
 * block-kroki/block-plantuml declared no `config` at all, so this path never had anything real to
 * read from `block.config`; this locks in the seeding half now that they do.
 */
describe('propDefault', () => {
  it("prefers the site's own configured value over the prop's hardcoded default", () => {
    const block = { config: { server: 'https://kroki.internal' } }
    const prop = { name: 'server', default: 'https://kroki.io' }

    expect(propDefault(block, prop)).toBe('https://kroki.internal')
  })

  it('falls back to the prop default when the site has never set one', () => {
    const block = { config: {} }
    const prop = { name: 'server', default: 'https://kroki.io' }

    expect(propDefault(block, prop)).toBe('https://kroki.io')
  })

  it('treats an empty-string config value as unset, not as an override', () => {
    const block = { config: { server: '' } }
    const prop = { name: 'server', default: 'https://kroki.io' }

    expect(propDefault(block, prop)).toBe('https://kroki.io')
  })

  it('falls back to an empty string when the prop itself has no default', () => {
    const block = { config: {} }
    const prop = { name: 'caption' }

    expect(propDefault(block, prop)).toBe('')
  })
})

describe('seedConfigValues', () => {
  it('uses the saved config value when the site has already set one', () => {
    const block = {
      config: { tileServerUrl: 'https://example.com/{z}/{x}/{y}.png' },
      configFields: [
        {
          name: 'tileServerUrl',
          type: 'string',
          default: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
        }
      ]
    }

    expect(seedConfigValues(block)).toEqual({
      tileServerUrl: 'https://example.com/{z}/{x}/{y}.png'
    })
  })

  it("falls back to the field's own default where the site has never set a value", () => {
    const block = {
      config: {},
      configFields: [
        { name: 'apiKey', type: 'string' },
        {
          name: 'tileServerUrl',
          type: 'string',
          default: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
        }
      ]
    }

    expect(seedConfigValues(block)).toEqual({
      apiKey: '',
      tileServerUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
    })
  })

  it('reports no values for a block with no config fields', () => {
    expect(seedConfigValues({ config: {}, configFields: [] })).toEqual({})
    expect(seedConfigValues({ config: {} })).toEqual({})
  })
})
