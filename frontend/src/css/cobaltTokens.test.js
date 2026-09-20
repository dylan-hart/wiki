import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `tailwind.css` is plain CSS, not a module whose custom properties anything here can read live, and
 * this environment has neither a compiled stylesheet of it nor a layout engine to resolve `var()`
 * cascades against -- so these assertions read its SOURCE TEXT directly. Contrast over these tokens
 * belongs to `cobaltContrast.test.js`, the one place that measures it.
 *
 * A `--q-*` override under `body.body--cobalt` would silently beat a site's own saved brand color;
 * those defaults belong to `helpers/aestheticDefaults.js` instead, which is why one test forbids it.
 */

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'tailwind.css')
const source = readFileSync(CSS_PATH, 'utf-8')

// A missing block yields an empty Cobalt slice rather than throwing at module load, so every token
// test fails informatively instead of the file erroring out at collection time.
const cobaltBlockStart = source.indexOf('body.body--cobalt {')
const ledgerSource = cobaltBlockStart === -1 ? source : source.slice(0, cobaltBlockStart)
const cobaltBlockEnd = cobaltBlockStart === -1 ? -1 : source.indexOf('\n}', cobaltBlockStart)
const cobaltSource = cobaltBlockStart === -1 ? '' : source.slice(cobaltBlockStart, cobaltBlockEnd)

describe('body.body--cobalt block', () => {
  it('exists in tailwind.css', () => {
    expect(cobaltBlockStart).toBeGreaterThan(-1)
  })
})

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
    // -> A 0-blur, 1px-spread ring rather than a drop shadow, so every plate reading `--shadow-card`
    //    gets its Cobalt hairline from this one value with no per-consumer change.
    'shadow-card': { ledger: 'none', cobalt: '0 0 0 1px #dfe5f5' },
    // -> `none` under both: a button is no plate, so there is nothing to give a ring to instead.
    'shadow-primary': { ledger: 'none', cobalt: 'none' },
    'border-card': { ledger: '1px solid var(--color-hairline)', cobalt: '0' },
    'corner-marks': { ledger: 'block', cobalt: 'none' },
    'nav-active-inset': {
      ledger: 'inset 2px 0 0 var(--color-accent)',
      cobalt: 'inset 3px 0 0 #ff4d5a'
    },
    'page-header-bg': {
      ledger: 'var(--color-white)',
      cobalt: '#1f4fd6'
    },
    'page-header-fg': { ledger: 'var(--color-ink)', cobalt: 'var(--color-white)' },
    'page-header-radius': { ledger: '0', cobalt: '8px' },
    // -> The banner sits on its own solid fill, not low-contrast on the paper ground, so it needs
    //    neither a glow nor a ring in its place.
    'page-header-shadow': { ledger: 'none', cobalt: 'none' },
    // -> Two direction-specific tokens, not one shared value: `Index.vue` feeds `margin-inline` and
    //    `margin-block-start` separately, and only the horizontal gap is non-zero under Cobalt.
    'page-header-margin-inline': { ledger: '0', cobalt: '24px' },
    'page-header-margin-block-start': { ledger: '0', cobalt: '0' },
    // -> An overlay sits on the scrim rather than on the page, so Cobalt drops the shadow with no
    //    ring in its place; Ledger keeps its own values.
    'shadow-menu': {
      ledger:
        '0 1px 5px rgb(0 0 0 / 0.2), 0 2px 2px rgb(0 0 0 / 0.14), 0 3px 1px -2px rgb(0 0 0 / 0.12)',
      cobalt: 'none'
    },
    'shadow-dialog': { ledger: '0 0 30px rgb(0 0 0 / 0.4)', cobalt: 'none' }
  }

  it.each(Object.entries(shapeTokens))(
    '--%s has the Ledger no-op default and the Cobalt value',
    (name, { ledger, cobalt }) => {
      expect(declaredValue(ledgerSource, name), `--${name} Ledger default`).toBe(ledger)
      expect(declaredValue(cobaltSource, name), `--${name} Cobalt value`).toBe(cobalt)
    }
  )
})

describe('Cobalt color tokens', () => {
  const colorTokens = {
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
    // The block declares no `--q-accent` override, so the accent tag chip's text is the only
    // white-text-bearing role available to check here directly.
    expect(declaredValue(cobaltSource, 'color-tag-chip-accent-text')).toBe('#c8303c')
    expect(cobaltSource).not.toMatch(/#ff4d5a.*white|white.*#ff4d5a/i)
  })
})

describe('admin-configurable brand colors are left alone', () => {
  it('declares no --q-* override inside body.body--cobalt', () => {
    /*
      Anchored to match a DECLARATION, not a mention: the block's own comments name `--q-*` tokens to
      explain why each is left to the admin default, and a bare substring match would read those
      explanations as the violation they warn against.
    */
    expect(cobaltSource).not.toMatch(/^\s*--q-[a-z-]+\s*:/m)
  })
})

describe('Cobalt tokens added by the screen-level pass', () => {
  const addedTokens = {
    'header-fg': { ledger: 'var(--color-ink)', cobalt: '#fff' },
    'header-icon': { ledger: 'var(--color-slate-soft)', cobalt: '#fff' },
    'header-search-fg': { ledger: 'var(--color-text-body)', cobalt: '#fff' },
    'header-search-border': { ledger: 'var(--color-hairline)', cobalt: 'transparent' },
    'sidebar-actions-text': { ledger: 'var(--color-slate)', cobalt: '#c5cff5' },
    'dialog-header-bg': { ledger: 'var(--color-dark-2)', cobalt: '#1c2a70' },
    // -> An accent fill carrying white text, so the accent tone and never `--color-accent-fill`.
    'account-avatar-bg': { ledger: 'var(--color-slate)', cobalt: 'var(--color-accent)' },
    'segment-selected': { ledger: 'var(--color-primary)', cobalt: 'var(--color-accent)' },
    'tree-root-icon': { ledger: 'var(--color-slate-soft)', cobalt: 'var(--color-accent-strong)' },
    slate: { ledger: '#38465f', cobalt: '#1e2a5e' },
    'slate-soft': { ledger: '#64789f', cobalt: '#7b88bd' },
    'slate-faint': { ledger: '#8a99b8', cobalt: '#b6bfe0' },
    'slate-nav-icon': { ledger: '#6d7893', cobalt: '#7f8ed1' },
    rule: { ledger: '#c9d2e2', cobalt: '#c8d2ee' }
  }

  it.each(Object.entries(addedTokens))(
    '--color-%s carries each aesthetic’s own value',
    (name, { ledger, cobalt }) => {
      expect(declaredValue(ledgerSource, `color-${name}`), `--color-${name} Ledger`).toBe(ledger)
      expect(declaredValue(cobaltSource, `color-${name}`), `--color-${name} Cobalt`).toBe(cobalt)
    }
  )

  /*
    Every Ledger value here has to be the do-nothing one -- transparent, `0`, `none`: a section
    written as `background: var(--float-bg); padding: var(--float-pad)` must render under Ledger
    exactly as it did before the token existed, or the rule is a Cobalt feature with a Ledger
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
