import { describe, expect, it } from 'vitest'

import {
  contrastRatio,
  getAccessibleColor,
  meetsWcagAA,
  WCAG_AA_CONTRAST
} from './accessibility.js'

const CVD_TYPES = ['protanopia', 'deuteranopia', 'tritanopia']

// Every color name AdminTheme.vue's `colorKeys` loop can substitute, plus the two fixed status
// colors that were already covered before this task.
const THEMEABLE_COLOR_NAMES = ['primary', 'secondary', 'accent', 'header', 'sidebar']

describe('getAccessibleColor()', () => {
  it('returns the base color unchanged when cvd is none', () => {
    for (const name of THEMEABLE_COLOR_NAMES) {
      expect(getAccessibleColor(name, '#123456', 'none')).toBe('#123456')
    }
  })

  it('returns the base color unchanged for an unrecognized cvd value', () => {
    expect(getAccessibleColor('primary', '#123456', 'made-up')).toBe('#123456')
    expect(getAccessibleColor('primary', '#123456', undefined)).toBe('#123456')
  })

  it('has a substitute for every themeable color name, under every CVD type', () => {
    for (const cvd of CVD_TYPES) {
      for (const name of THEMEABLE_COLOR_NAMES) {
        const result = getAccessibleColor(name, '#deadbe', cvd)
        expect(typeof result).toBe('string')
        expect(result).toMatch(/^#[0-9a-fA-F]{3,6}$/)
        // -> The whole point of this task: previously `accent`/`header`/`sidebar` had no entry in
        //    any of the three tables, so the site's own (possibly inaccessible) base color passed
        //    through untouched. A real substitute must actually differ from the base.
        expect(result).not.toBe('#deadbe')
      }
    }
  })

  it('gives protanopia and deuteranopia the same substitute for every color', () => {
    for (const name of THEMEABLE_COLOR_NAMES) {
      expect(getAccessibleColor(name, '#deadbe', 'protanopia')).toBe(
        getAccessibleColor(name, '#deadbe', 'deuteranopia')
      )
    }
  })

  it('still covers the two fixed status colors used outside the theme (positive/negative)', () => {
    expect(getAccessibleColor('positive', '#02C39A', 'protanopia')).not.toBe('#02C39A')
    expect(getAccessibleColor('negative', '#f03a47', 'protanopia')).not.toBe('#f03a47')
  })
})

describe('contrastRatio() / meetsWcagAA()', () => {
  it('gives black on white the maximum ratio of 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
  })

  it('gives a color against itself a ratio of 1:1', () => {
    expect(contrastRatio('#1976D2', '#1976D2')).toBeCloseTo(1, 5)
  })

  it('does not care about argument order', () => {
    expect(contrastRatio('#1976D2', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#1976D2'), 10)
  })

  it('accepts 3-digit hex shorthand the same as its expanded 6-digit form', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(contrastRatio('#000000', '#ffffff'), 10)
  })

  it('flags white text on the default header black as passing AA', () => {
    expect(meetsWcagAA('#000000', '#ffffff')).toBe(true)
  })

  it('flags white text on a light color as failing AA', () => {
    // A pale yellow is nowhere near enough contrast against white text.
    expect(meetsWcagAA('#fff9c4', '#ffffff')).toBe(false)
    expect(contrastRatio('#fff9c4', '#ffffff')).toBeLessThan(WCAG_AA_CONTRAST)
  })
})
