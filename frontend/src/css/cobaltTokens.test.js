import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2767 ("Cobalt light token block in tailwind.css (shape + color, including the radii
 * sweep)"). `tailwind.css` is plain CSS, not a module anything here can import and read live custom
 * property values off -- there is no compiled stylesheet in this test environment (`test.css: true`
 * runs SFC `<style>` blocks through Sass, not this file) and no real layout engine to resolve `var()`
 * cascades against. Asserting against the SOURCE TEXT directly is the established pattern for this
 * (`_base.test.js`'s `.q-*` sweep, `.header`/`.bg-header` token-only check), and is what actually
 * pins the shape of a hand-edited token file down.
 *
 * This suite checks three things the acceptance criteria call for:
 *   1. every shape token from the handoff's table exists, with a Ledger no-op default and a distinct
 *      Cobalt value under `body.body--cobalt`;
 *   2. every color token from the handoff's Chrome / Paper-and-text / The-live-edge tables exists the
 *      same way, and the three accent roles stay distinct rather than collapsing into one value;
 *   3. no `cobalt:` Tailwind variant was introduced, and no `--q-*` admin-configurable brand color
 *      was given a `body.body--cobalt` override (that would silently beat a site's own saved color --
 *      see the token block's own comment, and OpenProject #2768's `aestheticDefaults.js`).
 *
 * WCAG AA contrast over these tokens is `cobaltContrast.test.js`'s job (OpenProject #2782), not
 * this file's -- it used to carry its own small hardcoded-hex "clears AA" describe block here, which
 * was consolidated into that dedicated, token-sourced suite rather than kept as a second copy.
 */

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'tailwind.css')
const source = readFileSync(CSS_PATH, 'utf-8')

// Split once on the `body.body--cobalt {` rule so "Ledger default" and "Cobalt override" assertions
// read against the correct half without each test re-deriving the split. Falls back to an empty
// Cobalt slice (rather than throwing at module load) if the block is ever removed -- every token
// test below then fails informatively instead of the whole file erroring out at collection time.
const cobaltBlockStart = source.indexOf('body.body--cobalt {')
const ledgerSource = cobaltBlockStart === -1 ? source : source.slice(0, cobaltBlockStart)
const cobaltBlockEnd = cobaltBlockStart === -1 ? -1 : source.indexOf('\n}', cobaltBlockStart)
const cobaltSource = cobaltBlockStart === -1 ? '' : source.slice(cobaltBlockStart, cobaltBlockEnd)

describe('body.body--cobalt block', () => {
  it('exists in tailwind.css', () => {
    expect(cobaltBlockStart).toBeGreaterThan(-1)
  })
})

/** Finds `--name: value;` (or a multi-line value up to the next `--` or closing brace) in a slice. */
function declaredValue(slice, name) {
  const re = new RegExp(`--${name}:\\s*([\\s\\S]*?);`, 'm')
  const match = slice.match(re)
  return match ? match[1].replace(/\s+/g, ' ').trim() : undefined
}

describe('no cobalt: Tailwind variant exists', () => {
  it('declares no @custom-variant cobalt (the aesthetic is a body-class token override, not a variant)', () => {
    expect(source).not.toMatch(/@custom-variant\s+cobalt/)
  })
})

describe('Cobalt shape tokens (radii sweep)', () => {
  const shapeTokens = {
    'radius-card': { ledger: '0', cobalt: '8px' },
    'radius-control': { ledger: '0', cobalt: '6px' },
    'radius-dialog': { ledger: '0', cobalt: '12px' },
    'radius-pill': { ledger: '0', cobalt: '12px' },
    'radius-mark': { ledger: '0', cobalt: '4px' },
    'shadow-card': { ledger: 'none', cobalt: '0 2px 10px rgb(16 25 74 / 0.08)' },
    'shadow-primary': { ledger: 'none', cobalt: '0 4px 14px rgb(200 48 60 / 0.35)' },
    'border-card': { ledger: '1px solid var(--color-hairline)', cobalt: '0' },
    'corner-marks': { ledger: 'block', cobalt: 'none' },
    'nav-active-inset': {
      ledger: 'inset 2px 0 0 var(--color-accent)',
      cobalt: 'inset 3px 0 0 #ff4d5a'
    },
    'page-header-bg': {
      ledger: 'var(--color-white)',
      cobalt: 'linear-gradient(120deg, #1f4fd6, #3d6df7)'
    },
    'page-header-fg': { ledger: 'var(--color-ink)', cobalt: 'var(--color-white)' },
    'page-header-radius': { ledger: '0', cobalt: '8px' },
    'page-header-shadow': { ledger: 'none', cobalt: '0 8px 24px rgb(31 79 214 / 0.28)' },
    'page-header-margin': { ledger: '0', cobalt: '24px' }
  }

  it.each(Object.entries(shapeTokens))(
    '--%s has the Ledger no-op default and the Cobalt value',
    (name, { ledger, cobalt }) => {
      expect(declaredValue(ledgerSource, name), `--${name} Ledger default`).toBe(ledger)
      expect(declaredValue(cobaltSource, name), `--${name} Cobalt value`).toBe(cobalt)
    }
  )

  it('shares a single --shadow-dialog value across both aesthetics (the handoff marks it "same")', () => {
    expect(declaredValue(ledgerSource, 'shadow-dialog')).toBe('0 0 30px rgb(0 0 0 / 0.4)')
    // -> Not redeclared under body.body--cobalt at all: same value, no override needed.
    expect(cobaltSource).not.toMatch(/--shadow-dialog:/)
  })
})

describe('Cobalt color tokens', () => {
  const colorTokens = {
    // Reused generic tokens, redefined for Cobalt
    ink: { ledger: '#1c2233', cobalt: '#10194a' },
    paper: { ledger: '#f5f6f9', cobalt: '#f2f5ff' },
    tint: { cobalt: '#e6edff' },
    'tint-alt': { cobalt: '#e6edff' },
    hairline: { ledger: '#dbe1ec', cobalt: '#dfe5f5' },
    'text-body': { ledger: '#2f3a4f', cobalt: '#1a2038' },
    'text-secondary': { ledger: '#4e5d7d', cobalt: '#4a5580' },
    'text-caption': { ledger: '#57668a', cobalt: '#5a6699' },
    'accent-fill': { ledger: '#e4676b', cobalt: '#ff4d5a' },
    'accent-wash': { ledger: '#fdeced', cobalt: '#ffe9eb' },
    'accent-strong': { ledger: '#a83f45', cobalt: '#1f4fd6' },
    'positive-fill': { ledger: '#5f9c86', cobalt: '#22a37f' },
    // New, narrowly-scoped chrome tokens
    'header-eyebrow': { cobalt: '#dfe6ff' },
    'header-search-bg': { cobalt: 'rgb(255 255 255 / 0.16)' },
    'header-search-placeholder': { cobalt: '#e6ecff' },
    'sidebar-text': { cobalt: '#d7deff' },
    'sidebar-text-secondary': { cobalt: '#a7b3ea' },
    'sidebar-kicker': { cobalt: '#7f8ed1' },
    'sidebar-icon': { cobalt: '#7f8ed1' },
    'sidebar-active-bg': { cobalt: '#1f4fd6' },
    'sidebar-active-text': { cobalt: 'var(--color-white)' },
    'sidebar-hairline': { cobalt: 'rgb(255 255 255 / 0.08)' },
    'admin-sidebar-bg': { cobalt: '#10194a' },
    'admin-sidebar-raised': { cobalt: '#1c2a70' },
    'admin-sidebar-hairline': { cobalt: '#27337a' },
    'admin-sidebar-text': { cobalt: '#c5cff5' },
    'admin-sidebar-icon': { cobalt: '#7f8ed1' },
    'footer-bg': { cobalt: '#10194a' },
    'footer-text': { cobalt: '#a7b3ea' },
    'footer-link': { cobalt: '#ff7a84' },
    'inner-rule': { ledger: '#e4e9f2', cobalt: '#e6edff' },
    'heading-h2': { cobalt: '#1f4fd6' },
    'heading-rule': { cobalt: 'transparent' },
    'avatar-plate-bg': { ledger: '#e9edf5', cobalt: '#dbe5ff' },
    'avatar-plate-text': { cobalt: '#1a3fb0' },
    'tag-chip-bg': { cobalt: '#dbe5ff' },
    'tag-chip-text': { cobalt: '#1a3fb0' },
    'tag-chip-border': { cobalt: 'transparent' },
    'tag-chip-accent-bg': { cobalt: '#ffe9eb' },
    'tag-chip-accent-text': { cobalt: '#c8303c' }
  }

  it.each(Object.entries(colorTokens))(
    '--color-%s exists with the right Cobalt value',
    (name, { ledger, cobalt }) => {
      if (ledger) {
        expect(declaredValue(ledgerSource, `color-${name}`), `--color-${name} Ledger default`).toBe(
          ledger
        )
      }
      expect(declaredValue(cobaltSource, `color-${name}`), `--color-${name} Cobalt value`).toBe(
        cobalt
      )
    }
  )

  it('keeps the three accent roles distinct rather than collapsing them', () => {
    const untextedFill = declaredValue(cobaltSource, 'color-accent-fill')
    const textOnWhite = declaredValue(cobaltSource, 'color-accent-strong')
    const tagAccentText = declaredValue(cobaltSource, 'color-tag-chip-accent-text')
    expect(untextedFill).toBe('#ff4d5a')
    expect(textOnWhite).not.toBe(untextedFill)
    expect(tagAccentText).not.toBe(untextedFill)
  })

  it("applies the corrected #c8303c, never the mockups' uncorrected #ff4d5a, for a fill carrying white text", () => {
    // -> This file owns no `--q-accent` override (that role is OpenProject #2768's admin-default
    //    territory), so the one white-text-bearing role it DOES declare -- the accent tag chip's text
    //    -- is the direct check available here.
    expect(declaredValue(cobaltSource, 'color-tag-chip-accent-text')).toBe('#c8303c')
    expect(cobaltSource).not.toMatch(/#ff4d5a.*white|white.*#ff4d5a/i)
  })
})

describe('admin-configurable brand colors are left alone', () => {
  it('declares no --q-* override inside body.body--cobalt', () => {
    /*
      A DECLARATION, not a mention: the block's comments name `--q-header`/`--q-sidebar`/`--q-info`
      precisely to explain why each is left to the admin default rather than overridden here, and a
      bare substring match reads those explanations as the violation they warn against.
    */
    expect(cobaltSource).not.toMatch(/^\s*--q-[a-z-]+\s*:/m)
  })
})

/*
  The tokens this pass added on top of #2767's own block, each because a screen-level diff against the
  mockups turned up a rule that could not follow the aesthetic without one. Same shape as the tables
  above -- Ledger's value is the constant the rule already drew, Cobalt's is what the mockup draws --
  and pinned here so a later edit to either half fails as a token change rather than as a screenshot
  nobody re-took.
*/
describe('Cobalt tokens added by the screen-level pass', () => {
  const addedTokens = {
    // -> The header band's own foreground: `#1f4fd6` under white type and white icon strokes
    'header-fg': { ledger: 'var(--color-ink)', cobalt: '#fff' },
    'header-icon': { ledger: 'var(--color-slate-soft)', cobalt: '#fff' },
    'header-search-fg': { ledger: 'var(--color-text-body)', cobalt: '#fff' },
    'header-search-border': { ledger: 'var(--color-hairline)', cobalt: 'transparent' },
    // -> The sidebar's own bands, which sit on the sidebar ground rather than on the app's chrome
    'sidebar-actions-text': { ledger: 'var(--color-slate)', cobalt: '#c5cff5' },
    // -> A dialog's title band: Ledger's near-black raised rung, Cobalt's own raised indigo
    'dialog-header-bg': { ledger: 'var(--color-dark-2)', cobalt: '#1c2a70' },
    // -> An accent fill carrying white text, so the accent tone and never `--color-accent-fill`
    'account-avatar-bg': { ledger: 'var(--color-slate)', cobalt: 'var(--color-accent)' },
    'segment-selected': { ledger: 'var(--color-primary)', cobalt: 'var(--color-accent)' },
    'tree-root-icon': { ledger: 'var(--color-slate-soft)', cobalt: 'var(--color-accent-strong)' },
    // -> The slate ramp, moved onto Cobalt's own indigo hue
    slate: { ledger: '#38465f', cobalt: '#1e2a5e' },
    'slate-soft': { ledger: '#64789f', cobalt: '#7b88bd' },
    'slate-faint': { ledger: '#8a99b8', cobalt: '#b6bfe0' },
    'slate-nav-icon': { ledger: '#6d7893', cobalt: '#7f8ed1' },
    rule: { ledger: '#c9d2e2', cobalt: '#c8d2ee' },
    info: { ledger: 'var(--q-info)', cobalt: 'var(--color-slate)' }
  }

  it.each(Object.entries(addedTokens))(
    '--color-%s carries each aesthetic’s own value',
    (name, { ledger, cobalt }) => {
      expect(declaredValue(ledgerSource, `color-${name}`), `--color-${name} Ledger`).toBe(ledger)
      expect(declaredValue(cobaltSource, `color-${name}`), `--color-${name} Cobalt`).toBe(cobalt)
    }
  )

  /*
    The floating-card motif, and the masthead's own pieces. Every Ledger value here has to be the
    do-nothing one -- transparent, `0`, `none` -- because that is what makes one rule express both
    aesthetics: a section written as `background: var(--float-bg); padding: var(--float-pad)` has to
    render EXACTLY as it did before under Ledger, or the rule is a Cobalt feature with a Ledger
    regression attached.
  */
  const ledgerNoOps = {
    'float-bg': 'transparent',
    'float-pad': '0',
    'float-gap': '0',
    'float-rule-display': 'block',
    'article-card-pad': '0',
    'nav-item-inset': '0',
    'page-header-icon-radius': '0',
    'page-header-action-bg': 'transparent'
  }

  it.each(Object.entries(ledgerNoOps))(
    '--%s is a no-op under Ledger, so one rule can express both aesthetics',
    (name, value) => {
      expect(declaredValue(ledgerSource, name)).toBe(value)
      expect(declaredValue(cobaltSource, name), `${name} should differ under Cobalt`).not.toBe(
        value
      )
    }
  )
})
