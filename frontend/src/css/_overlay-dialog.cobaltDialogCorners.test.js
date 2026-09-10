import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2864 ("Cobalt corner-radius fix: MainOverlayDialog"): `ui-iteration/README.md` Part
 * 1.2 traces the Cobalt dialog corner fringe to `.w-dialog-panel` itself carrying a solid fill, a
 * `border-radius` AND `overflow: hidden` together -- a dark, flat-cornered `.card-header` clipped
 * by a filled ancestor's rounded `overflow: hidden` leaves a light antialiasing sliver at the two
 * top corners. The fix moves the fill/round/clip onto the header and body themselves.
 *
 * OpenProject #3000 moved the `.main-overlay` rule this suite covers out of `layouts/MainLayout.vue`
 * (where it lived scoped only by class name, invisible to `AdminLayout.vue`'s own separate async
 * `<style>` chunk) into this shared `_overlay-dialog.scss` partial -- this file moved with it,
 * unchanged in substance, since the assertions are still about the same rule.
 *
 * `_overlay-dialog.scss` is a plain global partial, so this is plain SCSS source with no compiled
 * stylesheet in this test environment to assert live values against -- the established pattern for
 * that (`cobaltTokens.test.js`, and this file's own `MainOverlayDialog.test.js` sibling, which
 * already reads this same rule's source for the `is-half-sized` rule) is a direct source-text
 * assertion.
 */

const source = readFileSync(join(import.meta.dirname, '_overlay-dialog.scss'), 'utf-8')

// Isolate the `.main-overlay { ... }` rule so every assertion below reads against the right block
// rather than risking a match against some unrelated part of this stylesheet.
const overlayBlockStart = source.indexOf('.main-overlay {')
const mainOverlaySource = overlayBlockStart === -1 ? '' : source.slice(overlayBlockStart)

describe('_overlay-dialog.scss .main-overlay block', () => {
  it('exists', () => {
    expect(overlayBlockStart).toBeGreaterThan(-1)
    expect(mainOverlaySource.length).toBeGreaterThan(0)
  })
})

describe('Cobalt dialog panel: no fill, no clip', () => {
  it('the panel keeps its radius (for the box-shadow) but draws no fill and does not clip', () => {
    expect(mainOverlaySource).toMatch(
      /@at-root \.body--cobalt & \{\s*border-top: 0;\s*border-radius: var\(--radius-dialog\);\s*background: transparent;\s*overflow: visible;\s*\}/
    )
  })

  it('no longer clips with overflow: hidden', () => {
    // -> Strips `/* ... */` comments first, since the block's own prose explains the OLD, now-fixed
    //    `overflow: hidden` clip by name -- a plain substring/regex check without this would fail on
    //    the comment rather than testing the declaration it describes.
    const withoutComments = mainOverlaySource.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(/overflow:\s*hidden/)
  })
})

describe('Cobalt dialog header/body: round and fill themselves', () => {
  it("rounds .card-header's own top corners, scoped under .main-overlay", () => {
    expect(mainOverlaySource).toContain(
      '@at-root .body--cobalt & .card-header {\n        border-radius: var(--radius-dialog) var(--radius-dialog) 0 0;\n      }'
    )
  })

  it("fills and rounds the first body sibling's outer bottom-left corner", () => {
    expect(mainOverlaySource).toMatch(
      /@at-root \.body--cobalt & \.card-header \+ \* \{\s*background: var\(--float-bg\);\s*overflow: auto;\s*border-bottom-left-radius: var\(--radius-dialog\);\s*\}/
    )
  })

  it("fills and rounds the last body sibling's outer bottom-right corner", () => {
    expect(mainOverlaySource).toMatch(
      /@at-root \.body--cobalt & \.card-header ~ \*:last-child \{\s*background: var\(--float-bg\);\s*overflow: auto;\s*border-bottom-right-radius: var\(--radius-dialog\);\s*\}/
    )
  })

  it('reuses the existing --float-bg surface token rather than inventing a new custom property', () => {
    const newCustomProps = mainOverlaySource.match(/--[a-z-]+:\s*(?!var\()/g) || []
    expect(newCustomProps).toEqual([])
  })
})

describe('Ledger is untouched', () => {
  it('keeps its flat panel with the ink-strip border-top, independent of the Cobalt rules above', () => {
    expect(mainOverlaySource).toContain('border-top: 10px solid var(--color-dark-5);')
    expect(mainOverlaySource).toContain('@at-root .body--light &')
    expect(mainOverlaySource).toContain('@at-root .body--dark &')
  })
})
