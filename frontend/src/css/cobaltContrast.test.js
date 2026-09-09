import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { contrastRatio, WCAG_AA_CONTRAST } from '../helpers/accessibility.js'
import { AESTHETIC_DEFAULT_COLORS } from '../helpers/aestheticDefaults.js'

/**
 * OpenProject #2782 ("Contrast test for the Cobalt token block, light + dark"), the "Verification"
 * step 3 `ui-redesign-cobalt/HANDOFF.md` calls for directly: run the codebase's existing contrast
 * check (`helpers/accessibility.js`, `WCAG_AA_CONTRAST`) over the Cobalt token block
 * programmatically, every text token against every surface it is specified for in the handoff's
 * tables, for both aesthetics.
 *
 * This lives beside `cobaltTokens.test.js` / `cobaltDarkTokens.test.js` rather than literally next
 * to `helpers/accessibility.test.js` (the WP text's other suggested spot) because it needs the same
 * thing those two already established: `tailwind.css` is plain CSS with no compiled stylesheet or
 * layout engine in this test environment, so every value here is read out of the SOURCE TEXT, not
 * re-hardcoded. Two admin-configurable roles the handoff's tables name -- "Sidebar ground" and
 * "Header bar" -- have no `--color-*` token in this file at all (they are the `--q-sidebar`/
 * `--q-header` brand colors); their Cobalt defaults are read from `helpers/aestheticDefaults.js`
 * instead, the one other real source for them, rather than a third hardcoded copy of the same hex.
 *
 * `cobaltTokens.test.js` and `cobaltDarkTokens.test.js` used to each carry their own small, ad hoc
 * "clears WCAG AA" describe block with hand-typed hex literals -- exactly the kind of second copy
 * this file exists to replace. Both were removed in the same change that added this file, so there
 * is exactly one place doing this now.
 */

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'tailwind.css')
const source = readFileSync(CSS_PATH, 'utf-8')

/** Finds `--name: value;` (or a multi-line value up to the next `--` or closing brace) in a slice. */
function declaredValue(slice, name) {
  const re = new RegExp(`--${name}:\\s*([\\s\\S]*?);`, 'm')
  const match = slice.match(re)
  return match ? match[1].replace(/\s+/g, ' ').trim() : undefined
}

// Same slicing technique as the two sibling files: the Cobalt light block runs from its own
// selector to the next top-level `\n}`, and the dark block (layered after it) the same way.
const lightBlockStart = source.indexOf('body.body--cobalt {')
const lightBlockEnd = lightBlockStart === -1 ? -1 : source.indexOf('\n}', lightBlockStart)
const lightSource = lightBlockStart === -1 ? '' : source.slice(lightBlockStart, lightBlockEnd)

const darkBlockStart = source.indexOf('body.body--cobalt.body--dark {')
const darkBlockEnd = darkBlockStart === -1 ? -1 : source.indexOf('\n}', darkBlockStart)
const darkSource = darkBlockStart === -1 ? '' : source.slice(darkBlockStart, darkBlockEnd)

// The one indirection either Cobalt block uses (`--color-sidebar-active-text` / `--page-header-fg`
// both point at it) -- resolved from the base :root rather than hardcoded, same source-text rule.
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

/** Resolves a plain hex value or the one `var(--color-white)` indirection either block writes. */
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
 * Composites a `rgb(r g b / a)` custom-property value over an opaque hex background, the way a
 * browser paints a translucent fill -- for the handful of Cobalt tokens that are washes rather than
 * flat surfaces (the header search field, the dark tag chip / avatar plate fills). Never a
 * hand-typed "what that looks like" hex: the math runs on the actual declared token string.
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

describe('Cobalt light: every text/surface pairing the handoff specifies clears AA', () => {
  // Sidebar ground and Header bar are the admin-configurable --q-sidebar / --q-header brand colors,
  // not tokens in this file -- their Cobalt defaults come from aestheticDefaults.js (OpenProject
  // #2768), the one other real source for them.
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
  // Ramp-rung roles per the dark block's own doc comment: -5 the page ground, -3 a card/dialog body.
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
      // avatar-plate uses the same fill and text-role values as the tag chip in Cobalt dark.
      expect(darkToken('color-avatar-plate-bg')).toBe(darkToken('color-tag-chip-bg'))
      expect(darkToken('color-avatar-plate-text')).toBe(darkToken('color-tag-chip-text'))
    })

    it('the lightened accent text over the accent wash, composited on the raised (card) surface', () => {
      const composited = compositeOverHex(darkToken('color-accent-wash-dark'), raisedSurface)
      expect(meetsAA(darkToken('color-accent-dark'), composited)).toBe(true)
    })
  })
})

describe('Documented gaps -- no implemented value exists yet to test, or the pairing is approximate', () => {
  // These are recorded rather than silently dropped, per the epic coordination note's instruction
  // to keep a known gap flagged consistently across the parallel Cobalt work packages instead of
  // resolving it differently in each one.

  it('Sidebar ground and Header bar have no Cobalt-dark override slot (OpenProject #2772/#2773 gap)', () => {
    // The dark block's own header comment: the handoff's dark "Sidebar"/"Header bar" rows have no
    // `--q-*` dark override slot in the current architecture, left for future work alongside #2768.
    expect(darkSource).not.toMatch(/--color-admin-sidebar-bg:/)
    expect(darkSource).not.toMatch(/--q-/)
  })

  it('"Positive text" and code-block syntax colors are not declared as tokens in this file', () => {
    // Only --color-positive-fill is a token here; the handoff's separate "Positive text" hex, and
    // the code-block syntax highlight colors, are not custom properties this file owns.
    expect(lightSource).not.toMatch(/--color-positive-text:/)
  })

  it('header search placeholder over its translucent wash is a near-miss the handoff never claims meets AA', () => {
    // --color-header-search-bg is `rgb(255 255 255 / 0.16)` over the header bar, not a flat surface,
    // and the handoff states no explicit ratio for this row (unlike every pairing asserted above).
    // Composited for real (not hand-typed) it lands just under the normal-text floor.
    const headerBar = AESTHETIC_DEFAULT_COLORS.cobalt.colorHeader
    const composited = compositeOverHex(lightToken('color-header-search-bg'), headerBar)
    expect(meetsAA(lightToken('color-header-search-placeholder'), composited)).toBe(false)
  })
})
