import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Cobalt dialog corner fringe: a solid fill, a `border-radius` AND `overflow: hidden` together
 * on `.w-dialog-panel` clip the flat-cornered `.card-header` inside it, leaving a light antialiasing
 * sliver at the two top corners. The fix moves the fill/round/clip onto the header and body
 * themselves, so these assertions pin down that the panel keeps only its radius.
 *
 * `_overlay-dialog.css` is a plain global partial with no compiled stylesheet in this test
 * environment to read live values from, so these are direct source-text assertions.
 */

const source = readFileSync(join(import.meta.dirname, '_overlay-dialog.css'), 'utf-8')

// Isolate the `.main-overlay` rule so no assertion below matches an unrelated part of the sheet.
const overlayBlockStart = source.indexOf('.main-overlay {')
const mainOverlaySource = overlayBlockStart === -1 ? '' : source.slice(overlayBlockStart)

describe('_overlay-dialog.css .main-overlay block', () => {
  it('exists', () => {
    expect(overlayBlockStart).toBeGreaterThan(-1)
    expect(mainOverlaySource.length).toBeGreaterThan(0)
  })
})

describe('Cobalt dialog panel: no fill, no clip', () => {
  it('the panel keeps its radius (for the box-shadow) but draws no fill and does not clip', () => {
    expect(mainOverlaySource).toMatch(
      /\.body--cobalt & \{\s*border-top: 0;\s*border-radius: var\(--radius-dialog\);\s*background: transparent;\s*overflow: visible;\s*\}/
    )
  })

  it('no longer clips with overflow: hidden', () => {
    // -> Strips comments first: the block's own prose names the `overflow: hidden` clip it warns
    //    against, so an unstripped check would fail on the prose rather than on the declaration.
    const withoutComments = mainOverlaySource.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(/overflow:\s*hidden/)
  })
})

describe('Cobalt dialog header/body: round and fill themselves', () => {
  it("rounds .card-header's own top corners, scoped under .main-overlay", () => {
    expect(mainOverlaySource).toContain(
      '.body--cobalt & .card-header {\n        border-radius: var(--radius-dialog) var(--radius-dialog) 0 0;\n      }'
    )
  })

  it("fills and rounds the first body sibling's outer bottom-left corner", () => {
    expect(mainOverlaySource).toMatch(
      /\.body--cobalt & \.card-header \+ \* \{\s*background: var\(--float-bg\);\s*overflow: auto;\s*border-bottom-left-radius: var\(--radius-dialog\);\s*\}/
    )
  })

  it("fills and rounds the last body sibling's outer bottom-right corner", () => {
    expect(mainOverlaySource).toMatch(
      /\.body--cobalt & \.card-header ~ \*:last-child \{\s*background: var\(--float-bg\);\s*overflow: auto;\s*border-bottom-right-radius: var\(--radius-dialog\);\s*\}/
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
    expect(mainOverlaySource).toContain('.body--light &')
    expect(mainOverlaySource).toContain('.body--dark &')
  })
})
