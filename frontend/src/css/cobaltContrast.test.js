import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { contrastRatio, WCAG_AA_CONTRAST } from '../helpers/accessibility.js'
import { AESTHETIC_DEFAULT_COLORS } from '../helpers/aestheticDefaults.js'

/**
 * The one place the Cobalt token block's contrast is checked -- a second copy would be hand-typed
 * hex literals drifting from the stylesheet.
 *
 * There is no compiled stylesheet or layout engine here, so every value is read out of
 * `tailwind.css`'s SOURCE TEXT rather than re-hardcoded. "Sidebar ground" and "Header bar" have no
 * `--color-*` token at all (they are the admin-configurable `--q-sidebar`/`--q-header` brand
 * colors), so their Cobalt defaults come from `helpers/aestheticDefaults.js`, the one other real
 * source for them.
 */

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'tailwind.css')
const source = readFileSync(CSS_PATH, 'utf-8')

function declaredValue(slice, name) {
  const re = new RegExp(`--${name}:\\s*([\\s\\S]*?);`, 'm')
  const match = slice.match(re)
  return match ? match[1].replace(/\s+/g, ' ').trim() : undefined
}

// `\n}` at column 0 is the block's own closing brace -- nested rules close indented.
const lightBlockStart = source.indexOf('body.body--cobalt {')
const lightBlockEnd = lightBlockStart === -1 ? -1 : source.indexOf('\n}', lightBlockStart)
const lightSource = lightBlockStart === -1 ? '' : source.slice(lightBlockStart, lightBlockEnd)

const darkBlockStart = source.indexOf('body.body--cobalt.body--dark {')
const darkBlockEnd = darkBlockStart === -1 ? -1 : source.indexOf('\n}', darkBlockStart)
const darkSource = darkBlockStart === -1 ? '' : source.slice(darkBlockStart, darkBlockEnd)

const colorWhite = declaredValue(source, 'color-white')

describe('Cobalt light and dark blocks are present to test against', () => {
  it('both exist in tailwind.css, dark layered after light', () => {
    expect(lightBlockStart).toBeGreaterThan(-1)
    expect(darkBlockStart).toBeGreaterThan(lightBlockStart)
  })

  it('resolved --color-white for the one var() indirection either block uses', () => {
    expect(colorWhite).toBe('#fff')
  })
})

function resolveColor(value) {
  return value === 'var(--color-white)' ? colorWhite : value
}

function lightToken(name) {
  return resolveColor(declaredValue(lightSource, name))
}

function darkToken(name) {
  return resolveColor(declaredValue(darkSource, name))
}

/**
 * A few Cobalt fills are translucent washes rather than flat surfaces (the header search field, the
 * dark tag chip / avatar plate), so text over them has to be measured against the composite a
 * browser actually paints, not against the wash's own value.
 */
function compositeOverHex(rgba, baseHex) {
  const match = rgba.match(/rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)/)
  if (!match) {
    throw new Error(`not a rgb(r g b / a) value: ${rgba}`)
  }
  const [, r, g, b, alpha] = match.map(Number)
  const base = baseHex.replace('#', '')
  const baseChannel = (start) => Number.parseInt(base.slice(start, start + 2), 16)
  const mix = (fg, bg) => Math.round(fg * alpha + bg * (1 - alpha))
  const toHex = (n) => n.toString(16).padStart(2, '0')
  return `#${toHex(mix(r, baseChannel(0)))}${toHex(mix(g, baseChannel(2)))}${toHex(mix(b, baseChannel(4)))}`
}

const meetsAA = (fg, bg) => contrastRatio(fg, bg) >= WCAG_AA_CONTRAST

/**
 * WCAG SC 1.4.11 (Non-text Contrast), distinct from `WCAG_AA_CONTRAST`'s 4.5:1 SC 1.4.3 bar for
 * TEXT. A focus/hover ring is a UI component outline, so it is held to this lower bar.
 */
const WCAG_NON_TEXT_CONTRAST = 3
const meetsNonTextAA = (fg, bg) => contrastRatio(fg, bg) >= WCAG_NON_TEXT_CONTRAST

/**
 * Falls back to the light block for a token the dark block doesn't restate (`--color-slate-soft`,
 * for one) -- the normal cascade for a property Cobalt-dark never overrides.
 */
function resolveVar(value, { light, dark }) {
  const match = value?.match(/^var\(--(.+)\)$/)
  if (!match) {
    return resolveColor(value)
  }
  const name = match[1]
  const fromDark = dark ? declaredValue(dark, name) : undefined
  const fromLight = light ? declaredValue(light, name) : undefined
  return resolveColor(fromDark ?? fromLight)
}

describe('Cobalt light: every text/surface pairing the handoff specifies clears AA', () => {
  const sidebarGround = AESTHETIC_DEFAULT_COLORS.cobalt.colorSidebar
  const headerBar = AESTHETIC_DEFAULT_COLORS.cobalt.colorHeader

  const pairings = {
    'header eyebrow on the header bar': [lightToken('color-header-eyebrow'), headerBar],
    'sidebar text on the sidebar ground': [lightToken('color-sidebar-text'), sidebarGround],
    'sidebar secondary text on the sidebar ground': [
      lightToken('color-sidebar-text-secondary'),
      sidebarGround
    ],
    'sidebar kicker/icon tint on the sidebar ground': [
      lightToken('color-sidebar-kicker'),
      sidebarGround
    ],
    'sidebar active item white text on the active fill': [
      lightToken('color-sidebar-active-text'),
      lightToken('color-sidebar-active-bg')
    ],
    'admin sidebar text on the admin sidebar ground': [
      lightToken('color-admin-sidebar-text'),
      lightToken('color-admin-sidebar-bg')
    ],
    'admin sidebar icon on the admin sidebar ground': [
      lightToken('color-admin-sidebar-icon'),
      lightToken('color-admin-sidebar-bg')
    ],
    'footer text on the footer strip': [
      lightToken('color-footer-text'),
      lightToken('color-footer-bg')
    ],
    'footer link on the footer strip': [
      lightToken('color-footer-link'),
      lightToken('color-footer-bg')
    ],
    'ink/headings on the paper ground': [lightToken('color-ink'), lightToken('color-paper')],
    'body text on the paper ground': [lightToken('color-text-body'), lightToken('color-paper')],
    'secondary text on the paper ground': [
      lightToken('color-text-secondary'),
      lightToken('color-paper')
    ],
    'caption text on the paper ground': [
      lightToken('color-text-caption'),
      lightToken('color-paper')
    ],
    'h2 on the paper ground': [lightToken('color-heading-h2'), lightToken('color-paper')],
    'avatar plate text on the avatar plate fill': [
      lightToken('color-avatar-plate-text'),
      lightToken('color-avatar-plate-bg')
    ],
    'white text on the admin-default accent fill (Edit button, Draft badge, count badges)': [
      colorWhite,
      AESTHETIC_DEFAULT_COLORS.cobalt.colorAccent
    ],
    'accent text on white (active TOC entry, Reset defaults)': [
      AESTHETIC_DEFAULT_COLORS.cobalt.colorAccent,
      colorWhite
    ],
    'link text (accent-strong) on white': [lightToken('color-accent-strong'), colorWhite],
    'page header title on the flat banner': [colorWhite, lightToken('page-header-bg')],
    'tag chip text on the tag chip fill': [
      lightToken('color-tag-chip-text'),
      lightToken('color-tag-chip-bg')
    ],
    'accent tag chip text on the accent tag chip fill': [
      lightToken('color-tag-chip-accent-text'),
      lightToken('color-tag-chip-accent-bg')
    ]
  }

  it.each(Object.entries(pairings))('%s', (_role, [fg, bg]) => {
    expect(fg, 'foreground token resolved').toBeTruthy()
    expect(bg, 'background token resolved').toBeTruthy()
    expect(meetsAA(fg, bg), `${fg} on ${bg} => ${contrastRatio(fg, bg).toFixed(2)}:1`).toBe(true)
  })

  it('keeps the header eyebrow at its specified #dfe6ff, not the rejected #b9c8ff (4.1:1, below AA)', () => {
    expect(lightToken('color-header-eyebrow')).toBe('#dfe6ff')
    expect(meetsAA('#b9c8ff', headerBar)).toBe(false)
  })
})

describe('Cobalt dark: every text/surface pairing the handoff specifies clears AA', () => {
  // Ramp rungs: -5 is the page ground, -3 a card/dialog body.
  const appGround = darkToken('color-dark-5')
  const raisedSurface = darkToken('color-dark-3')

  const pairings = {
    'body text on the app ground': [darkToken('color-text-dark'), appGround],
    'secondary text on the app ground': [darkToken('color-text-secondary-dark'), appGround],
    'caption text on the app ground': [darkToken('color-text-caption-dark'), appGround],
    'body text on the raised (card) surface': [darkToken('color-text-dark'), raisedSurface],
    'secondary text on the raised (card) surface': [
      darkToken('color-text-secondary-dark'),
      raisedSurface
    ],
    'caption text on the raised (card) surface': [
      darkToken('color-text-caption-dark'),
      raisedSurface
    ],
    'h2/rail icon tone on the app ground': [darkToken('color-heading-h2'), appGround],
    'link (accent-strong) on the app ground': [darkToken('color-accent-strong'), appGround],
    'h2/rail icon tone on the raised (card) surface': [
      darkToken('color-heading-h2'),
      raisedSurface
    ],
    'link (accent-strong) on the raised (card) surface': [
      darkToken('color-accent-strong'),
      raisedSurface
    ],
    'lightened accent text on the raised (card) surface': [
      darkToken('color-accent-dark'),
      raisedSurface
    ]
  }

  it.each(Object.entries(pairings))('%s', (_role, [fg, bg]) => {
    expect(fg, 'foreground token resolved').toBeTruthy()
    expect(bg, 'background token resolved').toBeTruthy()
    expect(meetsAA(fg, bg), `${fg} on ${bg} => ${contrastRatio(fg, bg).toFixed(2)}:1`).toBe(true)
  })

  describe('translucent fills, composited over the surface they sit on before checking text', () => {
    it('tag chip / avatar plate text over their translucent fill, composited on the app ground', () => {
      const composited = compositeOverHex(darkToken('color-tag-chip-bg'), appGround)
      expect(meetsAA(darkToken('color-tag-chip-text'), composited)).toBe(true)
      expect(darkToken('color-avatar-plate-bg')).toBe(darkToken('color-tag-chip-bg'))
      expect(darkToken('color-avatar-plate-text')).toBe(darkToken('color-tag-chip-text'))
    })

    it('the lightened accent text over the accent wash, composited on the raised (card) surface', () => {
      const composited = compositeOverHex(darkToken('color-accent-wash-dark'), raisedSurface)
      expect(meetsAA(darkToken('color-accent-dark'), composited)).toBe(true)
    })
  })
})

// `.w-input-control`'s Cobalt overrides are separate rules from the token blocks above, and sit
// inside `@layer components` -- hence `\n  }`, indented, as their closing brace.
const ringLightBlockStart = source.indexOf('body.body--cobalt .w-input-control {')
const ringLightBlockEnd =
  ringLightBlockStart === -1 ? -1 : source.indexOf('\n  }', ringLightBlockStart)
const ringLightSource =
  ringLightBlockStart === -1 ? '' : source.slice(ringLightBlockStart, ringLightBlockEnd)

const ringDarkBlockStart = source.indexOf('body.body--cobalt.body--dark .w-input-control {')
const ringDarkBlockEnd =
  ringDarkBlockStart === -1 ? -1 : source.indexOf('\n  }', ringDarkBlockStart)
const ringDarkSource =
  ringDarkBlockStart === -1 ? '' : source.slice(ringDarkBlockStart, ringDarkBlockEnd)

describe('Cobalt WInput/WSelect focus ring (OpenProject #3028)', () => {
  it('both override rules are present, dark layered after light', () => {
    expect(ringLightBlockStart).toBeGreaterThan(-1)
    expect(ringDarkBlockStart).toBeGreaterThan(ringLightBlockStart)
  })

  // The ring is an inset box-shadow, so it is drawn against the control's own surface
  // (`WInput`/`WSelect`'s `bg-surface dark:bg-dark-3`), not the page behind it.
  const controlSurfaceLight = colorWhite
  const controlSurfaceDark = darkToken('color-dark-3')

  it("both rules re-point --w-input-ring-active at Cobalt's accent-strong hue, not the neutral ramp", () => {
    expect(declaredValue(ringLightSource, 'w-input-ring-active')).toBe('var(--color-accent-strong)')
    expect(declaredValue(ringDarkSource, 'w-input-ring-active')).toBe('var(--color-accent-strong)')
  })

  it('both rules re-point --w-input-ring-hover at --color-slate-soft, the hue-distinct half-step', () => {
    expect(declaredValue(ringLightSource, 'w-input-ring-hover')).toBe('var(--color-slate-soft)')
    expect(declaredValue(ringDarkSource, 'w-input-ring-hover')).toBe('var(--color-slate-soft)')
  })

  it('the pre-existing --w-input-ring-error override survives untouched', () => {
    expect(declaredValue(ringDarkSource, 'w-input-ring-error')).toBe('var(--color-accent-fill)')
  })

  describe('the focused (active) ring clears the 4.5:1 text-contrast bar against the control face', () => {
    const cases = {
      'light, against the white control surface': [
        resolveVar(declaredValue(ringLightSource, 'w-input-ring-active'), {
          light: lightSource
        }),
        controlSurfaceLight
      ],
      'dark, against the raised (dark-3) control surface': [
        resolveVar(declaredValue(ringDarkSource, 'w-input-ring-active'), {
          light: lightSource,
          dark: darkSource
        }),
        controlSurfaceDark
      ]
    }

    it.each(Object.entries(cases))('%s', (_role, [fg, bg]) => {
      expect(fg, 'ring-active token resolved').toBeTruthy()
      expect(bg, 'control surface resolved').toBeTruthy()
      expect(meetsAA(fg, bg), `${fg} on ${bg} => ${contrastRatio(fg, bg).toFixed(2)}:1`).toBe(true)
    })
  })

  describe('the hover ring clears the 3:1 non-text-contrast bar (WCAG 1.4.11) against the control face', () => {
    const cases = {
      'light, against the white control surface': [
        resolveVar(declaredValue(ringLightSource, 'w-input-ring-hover'), {
          light: lightSource
        }),
        controlSurfaceLight
      ],
      'dark, against the raised (dark-3) control surface': [
        resolveVar(declaredValue(ringDarkSource, 'w-input-ring-hover'), {
          light: lightSource,
          dark: darkSource
        }),
        controlSurfaceDark
      ]
    }

    it.each(Object.entries(cases))('%s', (_role, [fg, bg]) => {
      expect(fg, 'ring-hover token resolved').toBeTruthy()
      expect(bg, 'control surface resolved').toBeTruthy()
      expect(
        meetsNonTextAA(fg, bg),
        `${fg} on ${bg} => ${contrastRatio(fg, bg).toFixed(2)}:1`
      ).toBe(true)
    })
  })
})

describe('Documented gaps -- no implemented value exists yet to test, or the pairing is approximate', () => {
  it('Sidebar ground and Header bar have no Cobalt-dark override slot (OpenProject #2772/#2773 gap)', () => {
    expect(darkSource).not.toMatch(/--color-admin-sidebar-bg:/)
    expect(darkSource).not.toMatch(/--q-/)
  })

  it('"Positive text" and code-block syntax colors are not declared as tokens in this file', () => {
    expect(lightSource).not.toMatch(/--color-positive-text:/)
  })

  it('header search placeholder over its translucent wash is a near-miss the handoff never claims meets AA', () => {
    const headerBar = AESTHETIC_DEFAULT_COLORS.cobalt.colorHeader
    const composited = compositeOverHex(lightToken('color-header-search-bg'), headerBar)
    expect(meetsAA(lightToken('color-header-search-placeholder'), composited)).toBe(false)
  })
})
