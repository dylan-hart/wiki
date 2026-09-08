import { describe, expect, it } from 'vitest'

import {
  AESTHETIC_DEFAULT_COLORS,
  aestheticDefaultColors,
  resolveAestheticColors
} from './aestheticDefaults.js'

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

/*
  `resetColors()` only reaches a site whose administrator opens AdminTheme and saves, and the
  aesthetic is not only a site setting -- a reader can pick Cobalt for themselves on a site whose
  stored chrome is still Ledger's. `resolveAestheticColors` is what decides which of the two the app
  actually paints with, and the distinction it draws is "a colour nobody chose" against "a colour an
  administrator picked": the first follows the aesthetic, the second is left exactly as saved.
*/
describe('resolveAestheticColors', () => {
  const LEDGER_STORED = {
    colorPrimary: '#c14a52',
    colorAccent: '#c14a52',
    colorHeader: '#ffffff',
    colorSidebar: '#f0f2f7'
  }

  it('moves a site still on Ledger’s untouched defaults onto Cobalt’s', () => {
    expect(resolveAestheticColors('cobalt', LEDGER_STORED)).toMatchObject(
      aestheticDefaultColors('cobalt')
    )
  })

  it('leaves a colour the administrator actually picked exactly as saved', () => {
    const chosen = { ...LEDGER_STORED, colorHeader: '#123456' }

    expect(resolveAestheticColors('cobalt', chosen).colorHeader).toBe('#123456')
    // -> and the ones they did NOT pick still follow
    expect(resolveAestheticColors('cobalt', chosen).colorSidebar).toBe('#10194a')
  })

  it('recognises a default whatever case it was stored in', () => {
    const upper = { ...LEDGER_STORED, colorHeader: '#FFFFFF' }

    expect(resolveAestheticColors('cobalt', upper).colorHeader).toBe('#1f4fd6')
  })

  it('answers for a site with nothing stored at all', () => {
    expect(resolveAestheticColors('cobalt', undefined)).toMatchObject(
      aestheticDefaultColors('cobalt')
    )
  })

  it('deepens Cobalt’s header and sidebar on a dark ground, and nothing else', () => {
    const light = resolveAestheticColors('cobalt', LEDGER_STORED, false)
    const dark = resolveAestheticColors('cobalt', LEDGER_STORED, true)

    expect(dark.colorHeader).toBe('#1a43bd')
    expect(dark.colorSidebar).toBe('#0e1540')
    expect(dark.colorPrimary).toBe(light.colorPrimary)
    expect(dark.colorAccent).toBe(light.colorAccent)
  })

  it('leaves Ledger’s chrome alone on a dark ground, which repaints through `dark:` utilities', () => {
    expect(resolveAestheticColors('ledger', LEDGER_STORED, true)).toMatchObject(
      resolveAestheticColors('ledger', LEDGER_STORED, false)
    )
  })

  /*
    The status pair is not administrator-editable and so is not among the four above, but `App.vue`
    writes both onto `--q-positive`/`--q-negative` through this same call -- each aesthetic's TEXT
    tone, since both are drawn under a white label there.
  */
  it('carries each aesthetic’s own positive and negative text tones', () => {
    expect(resolveAestheticColors('ledger', LEDGER_STORED)).toMatchObject({
      colorPositive: '#3f7a66',
      colorNegative: '#c14a52'
    })
    expect(resolveAestheticColors('cobalt', LEDGER_STORED)).toMatchObject({
      colorPositive: '#177a5e',
      colorNegative: '#c8303c'
    })
  })
})
