import { describe, expect, it } from 'vitest'

import { contrastRatio, getAccessibleColor, WCAG_AA_CONTRAST } from './accessibility.js'

// -> `accessibility.js` exported this composition of its own two exports, with no non-test caller
//    anywhere in the app (`AdminTheme.vue` compares `contrastRatio` against the threshold inline).
//    It is an assertion helper, so it lives with the assertions.
const meetsWcagAA = (hexA, hexB) => contrastRatio(hexA, hexB) >= WCAG_AA_CONTRAST

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

describe('contrastRatio()', () => {
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

/**
 * Every color a solid `WBtn`/chip/header/status mark can be painted, PAIRED WITH THE FOREGROUND IT
 * IS ACTUALLY DRAWN UNDER. Values mirror the CSS tokens at `frontend/src/css/tailwind.css` (and
 * their SCSS twins in `_theme.scss`).
 *
 * The pairing is the whole point, and it is what changed when the app moved onto Cardinal. Before,
 * every fill drew WHITE text, so one list checked against `#ffffff` said everything. Cardinal has
 * two tones of each colour -- a bright FILL and a darker TEXT tone -- and picks a foreground per
 * tone: the darker tone carries white, the brighter fill carries `--color-ink` (`#1c2233`) or no
 * text at all. Checking a `-fill` against white would fail, correctly, because nothing draws that
 * combination; checking it against nothing at all would be the regression this file exists to catch.
 *
 * So a token here is listed with the ground it is paired with in the design, and every pair clears
 * WCAG AA. An edit that swaps a brand token for its brighter sibling without also moving the
 * foreground fails this test rather than shipping a 3.2:1 button.
 */
const INK = '#1c2233'
const INK_DARK = '#14171f'
/** `tailwind.css`'s Cardinal dark ramp -- `-3` is the panel a dark-mode card is painted. */
const DARK_3 = '#1b1f2a'

const SHIPPED_PALETTE_PAIRS = [
  // -- The brand tokens `WBtn`/chips resolve to, all of which carry a white label ----------
  { name: 'primary', hex: '#c14a52', on: '#ffffff' },
  { name: 'secondary', hex: '#3f7a66', on: '#ffffff' },
  { name: 'accent', hex: '#c14a52', on: '#ffffff' },
  { name: 'positive', hex: '#3f7a66', on: '#ffffff' },
  { name: 'negative', hex: '#c14a52', on: '#ffffff' },
  { name: 'info', hex: '#38465f', on: '#ffffff' },
  // -> The one brand token whose fill takes dark ink rather than white. Cardinal has no gold dark
  //    enough to carry a white label AND still read as a warning, so the foreground moves instead.
  { name: 'warning', hex: '#d9a441', on: INK },
  // -- The chrome: a white band and the cooler tint, both drawing their contents in ink ----
  { name: 'header', hex: '#ffffff', on: INK },
  { name: 'sidebar', hex: '#f0f2f7', on: INK },
  // -- The bright fills: under `--color-ink`, never under white ----------------------------
  { name: 'accent-fill', hex: '#e4676b', on: INK },
  { name: 'positive-fill', hex: '#5f9c86', on: INK },
  { name: 'warning-fill', hex: '#d9a441', on: INK },
  { name: 'negative-fill', hex: '#e4676b', on: INK },
  // -- Dark theme: the accent lightens and its fills take dark ink -------------------------
  { name: 'accent-dark', hex: '#f08287', on: INK_DARK },
  // -> The two filled toasts DARKEN on ink rather than lightening, so they keep a white label.
  { name: 'positive-dark', hex: '#3f7a66', on: '#ffffff' },
  { name: 'negative-dark', hex: '#a83f45', on: '#ffffff' },
  { name: 'warning-fill (dark)', hex: '#d9a441', on: INK_DARK }
]

describe('shipped palette tokens (frontend/src/css/tailwind.css)', () => {
  it('clears WCAG AA (4.5:1) against the foreground each is actually paired with', () => {
    for (const { name, hex, on } of SHIPPED_PALETTE_PAIRS) {
      expect(meetsWcagAA(hex, on), `${name} (${hex}) vs ${on}`).toBe(true)
    }
  })

  /*
   * The trap this palette is shaped around: swapping a brand token for the brighter fill of the same
   * hue looks like a no-op in a diff and drops a button's label to ~3:1.
   */
  it('would fail if a brand token were swapped for its brighter fill under a white label', () => {
    expect(meetsWcagAA('#e4676b', '#ffffff')).toBe(false)
    expect(meetsWcagAA('#5f9c86', '#ffffff')).toBe(false)
    expect(meetsWcagAA('#d9a441', '#ffffff')).toBe(false)
    expect(meetsWcagAA('#f08287', '#ffffff')).toBe(false)
  })
})

/**
 * The Cardinal text tiers, on the ground each is specified against. Nothing lighter than
 * `--color-text-caption` carries text on paper -- `--color-slate-soft` and `--color-slate-faint` are
 * for hairlines, icon strokes and separators, and the second assertion is what keeps someone from
 * reaching for one as a "subtle" text colour.
 */
describe('Cardinal text tiers', () => {
  const PAPER = '#f5f6f9'

  it('every light tier clears AA on white AND on paper', () => {
    for (const hex of ['#1c2233', '#2f3a4f', '#4e5d7d', '#57668a']) {
      expect(meetsWcagAA(hex, '#ffffff'), `${hex} vs white`).toBe(true)
      expect(meetsWcagAA(hex, PAPER), `${hex} vs paper`).toBe(true)
    }
  })

  it('every dark tier clears AA on ink AND on the panel a card is painted', () => {
    for (const hex of ['#e6eaf2', '#9aa6bd', '#8792ab']) {
      expect(meetsWcagAA(hex, INK_DARK), `${hex} vs ink`).toBe(true)
      expect(meetsWcagAA(hex, DARK_3), `${hex} vs dark-3`).toBe(true)
    }
  })

  it('the two faint slates are NOT text colours on white', () => {
    expect(meetsWcagAA('#64789f', '#ffffff')).toBe(false)
    expect(meetsWcagAA('#8a99b8', '#ffffff')).toBe(false)
  })

  /*
   * Accent text is SURFACE-QUALIFIED, and this is the assertion that says where the boundary
   * actually falls. `--color-accent` (#c14a52) clears the floor on white and nowhere else: on paper
   * it is 4.45:1, a hair under, and on the two tinted strips 4.25:1 / 4.29:1. So anything off white
   * -- paper included, not just the tints -- takes `--color-accent-strong` (#a83f45), which clears
   * all four. Links use the strong tone everywhere for that reason.
   */
  it('accent text is surface-qualified: white takes the accent, everything else the strong tone', () => {
    expect(meetsWcagAA('#c14a52', '#ffffff')).toBe(true)

    for (const ground of [PAPER, '#eef1f7', '#f0f2f7']) {
      expect(meetsWcagAA('#c14a52', ground), `accent on ${ground}`).toBe(false)
      expect(meetsWcagAA('#a83f45', ground), `accent-strong on ${ground}`).toBe(true)
    }
  })
})

// Task 1687: pins the placeholder and muted-text tokens above AA in both themes, so a future edit
// to any of these shipped values fails the suite instead of silently regressing back below AA.
describe('placeholder and muted-text token pinning', () => {
  /**
   * Composites `fg` over `bg` at `alphaPercent`% opacity the same way a `text-<color>/<alpha>`
   * Tailwind utility renders -- a plain per-channel lerp in sRGB space, no gamma correction -- so a
   * pinned value here matches what the browser actually paints for `WInput.vue`'s placeholder.
   */
  function compositeOpacity(fgHex, bgHex, alphaPercent) {
    const alpha = alphaPercent / 100
    const channel = (hex, start) => Number.parseInt(hex.slice(start, start + 2), 16)
    const mix = (start) =>
      Math.round(channel(fgHex, start) * alpha + channel(bgHex, start) * (1 - alpha))
    return `#${[1, 3, 5].map((start) => mix(start).toString(16).padStart(2, '0')).join('')}`
  }

  // frontend/src/css/tailwind.css's Cardinal dark ramp -- `-3` is the panel ground WInput.vue's
  // dark-theme placeholder and `--color-muted-dark` are measured against.
  const DARK_3 = '#1b1f2a'

  describe('WInput.vue placeholder (`/54`, up from the `/40` that failed AA)', () => {
    it('clears AA for black-on-white in light theme', () => {
      const rendered = compositeOpacity('#000000', '#ffffff', 54)
      expect(meetsWcagAA(rendered, '#ffffff')).toBe(true)
      expect(contrastRatio(rendered, '#ffffff')).toBeGreaterThanOrEqual(WCAG_AA_CONTRAST)
    })

    it('clears AA for white-on-dark-3 in dark theme', () => {
      const rendered = compositeOpacity('#ffffff', DARK_3, 54)
      expect(meetsWcagAA(rendered, DARK_3)).toBe(true)
      expect(contrastRatio(rendered, DARK_3)).toBeGreaterThanOrEqual(WCAG_AA_CONTRAST)
    })
  })

  describe('`--color-muted` / `--color-muted-dark` (tailwind.css)', () => {
    // Cardinal's own secondary text tiers (`--color-text-secondary` / `--color-text-secondary-dark`)
    // rather than a step of the neutral Material grey ramp -- see the token comment in tailwind.css.
    const MUTED = '#4e5d7d'
    const MUTED_DARK = '#9aa6bd'

    it('`--color-muted` clears AA on a white (light-theme) ground', () => {
      expect(meetsWcagAA(MUTED, '#ffffff')).toBe(true)
      expect(contrastRatio(MUTED, '#ffffff')).toBeGreaterThanOrEqual(WCAG_AA_CONTRAST)
    })

    it('`--color-muted-dark` clears AA on the dark-3 (dark-theme) ground', () => {
      expect(meetsWcagAA(MUTED_DARK, DARK_3)).toBe(true)
      expect(contrastRatio(MUTED_DARK, DARK_3)).toBeGreaterThanOrEqual(WCAG_AA_CONTRAST)
    })

    it('would have failed before this task -- grey-6 on white, grey-7 on dark-3', () => {
      expect(meetsWcagAA('#9e9e9e', '#ffffff')).toBe(false)
      expect(meetsWcagAA('#757575', DARK_3)).toBe(false)
    })
  })
})
