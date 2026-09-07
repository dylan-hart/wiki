import { describe, expect, it } from 'vitest'

import {
  AESTHETIC_DEFAULT_COLORS,
  AESTHETIC_STATUS_COLORS,
  aestheticDefaultColors,
  aestheticStatusColors
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

describe('aestheticStatusColors', () => {
  it("returns Ledger's existing fixed status-color defaults for 'ledger'", () => {
    expect(aestheticStatusColors('ledger')).toEqual({
      colorPositive: '#3f7a66',
      colorNegative: '#c14a52',
      colorInfo: '#38465f',
      colorWarning: '#d9a441'
    })
  })

  it("returns Cobalt's own status-color defaults for 'cobalt', distinct where Cobalt's own hue differs", () => {
    expect(aestheticStatusColors('cobalt')).toEqual({
      colorPositive: '#177a5e',
      colorNegative: '#c8303c',
      colorInfo: '#1e2a5e',
      colorWarning: '#d9a441'
    })
  })

  it('falls back to ledger for an unknown or missing aesthetic', () => {
    expect(aestheticStatusColors(undefined)).toEqual(AESTHETIC_STATUS_COLORS.ledger)
    expect(aestheticStatusColors('something-else')).toEqual(AESTHETIC_STATUS_COLORS.ledger)
  })

  // `warning` deliberately stays `#d9a441` in both aesthetics -- `ui-redesign-cobalt/HANDOFF.md`'s
  // "the amber warning keeps `#d9a441`" note -- so this only asserts the three that DO change.
  it('changes positive, negative and info between the two aesthetics', () => {
    const { ledger, cobalt } = AESTHETIC_STATUS_COLORS
    for (const key of ['colorPositive', 'colorNegative', 'colorInfo']) {
      expect(cobalt[key]).not.toBe(ledger[key])
    }
    expect(cobalt.colorWarning).toBe(ledger.colorWarning)
  })

  // Every fill/text pair here is drawn exactly as `composables/notify.js`'s `PRESETS` draws it
  // (white text on positive/negative/info, `--color-ink` on warning) -- a regression here would ship
  // an inaccessible toast under Cobalt the same way the Ledger pins in `helpers/accessibility.test.js`
  // guard for Ledger.
  it('clears WCAG AA under the same foreground notify.js draws each preset with', () => {
    const WHITE = '#ffffff'
    const COBALT_INK = '#10194a'

    function relativeLuminance(hex) {
      const [r, g, b] = hex
        .replace('#', '')
        .match(/.{2}/g)
        .map((part) => {
          const c = Number.parseInt(part, 16) / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    function contrastRatio(a, b) {
      const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
      return (lighter + 0.05) / (darker + 0.05)
    }

    const cobalt = AESTHETIC_STATUS_COLORS.cobalt
    expect(contrastRatio(cobalt.colorPositive, WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(cobalt.colorNegative, WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(cobalt.colorInfo, WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(cobalt.colorWarning, COBALT_INK)).toBeGreaterThanOrEqual(4.5)
  })
})
