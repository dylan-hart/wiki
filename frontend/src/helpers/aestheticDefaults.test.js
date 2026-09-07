import { describe, expect, it } from 'vitest'

import { AESTHETIC_DEFAULT_COLORS, aestheticDefaultColors } from './aestheticDefaults.js'

describe('aestheticDefaultColors', () => {
  it("returns Ledger's existing brand defaults for 'ledger'", () => {
    expect(aestheticDefaultColors('ledger')).toEqual({
      colorPrimary: '#c14a52',
      colorAccent: '#c14a52',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7'
    })
  })

  it("returns Cobalt's own defaults for 'cobalt', distinct from Ledger's", () => {
    expect(aestheticDefaultColors('cobalt')).toEqual({
      colorPrimary: '#1f4fd6',
      colorAccent: '#c8303c',
      colorHeader: '#1f4fd6',
      colorSidebar: '#10194a'
    })
  })

  it('falls back to ledger for an unknown or missing aesthetic', () => {
    expect(aestheticDefaultColors(undefined)).toEqual(AESTHETIC_DEFAULT_COLORS.ledger)
    expect(aestheticDefaultColors('something-else')).toEqual(AESTHETIC_DEFAULT_COLORS.ledger)
  })

  it('never shares a color between the two aesthetics for a role admins can tell apart', () => {
    const { ledger, cobalt } = AESTHETIC_DEFAULT_COLORS
    for (const key of Object.keys(ledger)) {
      expect(cobalt[key]).not.toBe(ledger[key])
    }
  })

  // Pin against `backend/models/sites.ts`'s `DEFAULT_THEME_COLORS` seed, which a fresh (always
  // Ledger) site actually gets -- see that file's own `sites.test.ts` pin for the backend half.
  it("agrees with backend/models/sites.ts's DEFAULT_THEME_COLORS for the fields both declare", () => {
    expect(AESTHETIC_DEFAULT_COLORS.ledger).toEqual({
      colorPrimary: '#c14a52',
      colorAccent: '#c14a52',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7'
    })
  })
})
