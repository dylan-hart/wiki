import { describe, expect, it } from 'vitest'

import { seedConfigValues } from './blocks.js'

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
