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

/**
 * OpenProject #2630 -- the code-token palette in `frontend/src/css/_page-contents.scss`, pinned
 * against the ground each form is ACTUALLY drawn on.
 *
 * The pairing is the whole point here for the same reason it is above, and this is the case that
 * proves it: the Cardinal second pass moved the rendered code block onto ink in BOTH themes
 * (`--content-surface-code: var(--color-ink)`, `#1c2233`, and `--color-dark-6`, `#0f1219`) but left
 * the token palette at GitHub's LIGHT theme -- a set of dark inks meant for a white ground. Nothing
 * failed, because nothing was checking the pair; on screen `--content-code-string` (`#0a3069`) was
 * rendering at 1.24:1, which is a string literal that is not there.
 *
 * So each palette is listed with its own ground, and a future edit that reaches for a white-ground
 * palette again fails here rather than shipping an unreadable code block.
 */
describe('rendered code-token palette (frontend/src/css/_page-contents.scss)', () => {
  /** `--color-ink`: the code block's ground in the LIGHT theme -- a dark island on a white page. */
  const CODE_GROUND = '#1c2233'
  /** `--color-dark-6`, the deepest well: the code block's ground in the DARK theme. */
  const CODE_GROUND_DARK = '#0f1219'

  /**
   * The light theme's set. Cardinal's own hues, one per token class -- accent for keywords, positive
   * for strings, warning for numbers and attributes, the lightened chrome slate for titles, the
   * custom-block purple lifted onto ink for types, and the two dark text tiers for comments and meta.
   */
  const LIGHT_THEME_TOKENS = {
    addition: '#7fc4a8',
    attr: '#e0b86a',
    comment: '#8792ab',
    deletion: '#f08287',
    keyword: '#f08287',
    meta: '#9aa6bd',
    number: '#e0b86a',
    string: '#7fc4a8',
    title: '#8ea6cf',
    type: '#c79ad2'
  }

  /**
   * The dark theme's set -- a genuinely second palette, not the same values reused. On a light page
   * the block is a dark island and these tones are held back so it does not glare out of a white
   * column; on a dark page it is the deepest well of an already-dark surface, and each is lifted a
   * step so a code block is not coloured in exactly the language of the panels around it.
   */
  const DARK_THEME_TOKENS = {
    addition: '#95d9bd',
    attr: '#f0cc84',
    comment: '#98a4bb',
    deletion: '#ff9ba0',
    keyword: '#ff9ba0',
    meta: '#adb8cd',
    number: '#f0cc84',
    string: '#95d9bd',
    title: '#a5bde0',
    type: '#d8afe2'
  }

  /** The set the print block keeps, where the block really is drawn on white. */
  const PRINT_TOKENS = {
    addition: '#1a7f37',
    attr: '#0550ae',
    comment: '#6a737d',
    deletion: '#cf222e',
    keyword: '#cf222e',
    meta: '#57606a',
    number: '#0550ae',
    string: '#0a3069',
    title: '#7c3aed',
    type: '#953800'
  }

  it('clears AA for every light-theme token on the ink ground the block is drawn on', () => {
    for (const [name, hex] of Object.entries(LIGHT_THEME_TOKENS)) {
      expect(meetsWcagAA(hex, CODE_GROUND), `${name} (${hex}) vs ${CODE_GROUND}`).toBe(true)
    }
  })

  it('clears AA for every dark-theme token on the deep-well ground', () => {
    for (const [name, hex] of Object.entries(DARK_THEME_TOKENS)) {
      expect(meetsWcagAA(hex, CODE_GROUND_DARK), `${name} (${hex}) vs ${CODE_GROUND_DARK}`).toBe(
        true
      )
    }
  })

  it('clears AA for every print token on paper, which is the ground print actually uses', () => {
    for (const [name, hex] of Object.entries(PRINT_TOKENS)) {
      expect(meetsWcagAA(hex, '#ffffff'), `${name} (${hex}) vs white`).toBe(true)
    }
  })

  it('gives the two palettes genuinely different values rather than one reused for both', () => {
    for (const name of Object.keys(LIGHT_THEME_TOKENS)) {
      expect(DARK_THEME_TOKENS[name], name).not.toBe(LIGHT_THEME_TOKENS[name])
    }
  })

  /*
   * The regression this suite exists for. Every one of the eight token classes the screen palette
   * used to carry was under the floor on the ground it was painted on, and `string` was invisible.
   */
  it('would fail if the screen palette went back to the white-ground set it shipped with', () => {
    for (const [name, hex] of Object.entries(PRINT_TOKENS)) {
      expect(meetsWcagAA(hex, CODE_GROUND), `${name} (${hex}) vs ${CODE_GROUND}`).toBe(false)
    }
    expect(contrastRatio('#0a3069', CODE_GROUND)).toBeLessThan(1.5)
  })

  /*
   * A diff line puts its token on a wash of its own colour laid over the block, not on the block --
   * so the pairing that has to clear the floor is the token against the COMPOSITED row, which is
   * always a step closer to the token than the bare ground is.
   */
  describe('diff rows, where the token sits on a wash of its own hue', () => {
    /** Composites an `rgba(fg, alpha)` wash over `bg`, per-channel in sRGB -- what a browser paints. */
    function composite(fgHex, bgHex, alpha) {
      const channel = (hex, start) => Number.parseInt(hex.slice(start, start + 2), 16)
      const mix = (start) =>
        Math.round(channel(fgHex, start) * alpha + channel(bgHex, start) * (1 - alpha))
      return `#${[1, 3, 5].map((start) => mix(start).toString(16).padStart(2, '0')).join('')}`
    }

    // Both washes are the token's own colour at 16%, in both themes.
    const WASH_ALPHA = 0.16

    it('clears AA for an added and a removed line in the light theme', () => {
      for (const hex of [LIGHT_THEME_TOKENS.addition, LIGHT_THEME_TOKENS.deletion]) {
        const row = composite(hex, CODE_GROUND, WASH_ALPHA)
        expect(meetsWcagAA(hex, row), `${hex} on its own wash (${row})`).toBe(true)
      }
    })

    it('clears AA for an added and a removed line in the dark theme', () => {
      for (const hex of [DARK_THEME_TOKENS.addition, DARK_THEME_TOKENS.deletion]) {
        const row = composite(hex, CODE_GROUND_DARK, WASH_ALPHA)
        expect(meetsWcagAA(hex, row), `${hex} on its own wash (${row})`).toBe(true)
      }
    })

    /*
     * And why print drops the washes entirely rather than carrying them over: composited on paper
     * they take the token that sits on them BELOW the floor, which is the whole reason the print
     * block sets both to `transparent` instead of reusing the screen alpha.
     */
    it('is why print drops the wash: on paper the same pair would fall under the floor', () => {
      for (const hex of [PRINT_TOKENS.addition, PRINT_TOKENS.deletion]) {
        const row = composite(hex, '#ffffff', 0.12)
        expect(meetsWcagAA(hex, row), `${hex} on its own wash (${row})`).toBe(false)
      }
      // -> On the white it actually prints on, both clear it comfortably.
      expect(meetsWcagAA(PRINT_TOKENS.addition, '#ffffff')).toBe(true)
      expect(meetsWcagAA(PRINT_TOKENS.deletion, '#ffffff')).toBe(true)
    })
  })
})

/**
 * OpenProject #2630 -- the two small mono marks that sit IN prose rather than in the code block:
 * an inline `code` chip and a `<kbd>` plate. Both are `--content-code-ink` on
 * `--content-surface-alt`, and the dark theme has to move the ink as well as the ground.
 *
 * The defect this pins: `code`'s colour was the literal `var(--color-slate)` in BOTH themes while
 * only its ground switched, which put `#38465f` on `#242b3a` -- 1.09:1, a chip with nothing legible
 * in it. The dark Ledger draws the same chip in the lightened chrome tone.
 */
describe('inline code and kbd chips (frontend/src/css/_page-contents.scss)', () => {
  const CHIP_INK = '#38465f' // --color-slate
  const CHIP_INK_DARK = '#8ea6cf' // --color-slate-light
  const CHIP_GROUND = '#eef1f7' // --color-tint
  const CHIP_GROUND_DARK = '#242b3a' // --color-dark-2

  it('clears AA in both themes, each ink on its own ground', () => {
    expect(meetsWcagAA(CHIP_INK, CHIP_GROUND)).toBe(true)
    expect(meetsWcagAA(CHIP_INK_DARK, CHIP_GROUND_DARK)).toBe(true)
  })

  it('would fail if the dark theme kept the light ink, which is what it used to do', () => {
    expect(meetsWcagAA(CHIP_INK, CHIP_GROUND_DARK)).toBe(false)
    expect(contrastRatio(CHIP_INK, CHIP_GROUND_DARK)).toBeLessThan(1.5)
  })
})
