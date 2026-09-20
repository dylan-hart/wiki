import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, 'SideDialog.vue'), 'utf-8')

/**
 * Brace-depth counting rather than a regex over the whole file: both `sideDialogs` and
 * `SIDE_DIALOG_TITLES` nest an object literal per entry, so a naive "match every `word:`" scan
 * would also pick up their inner keys.
 */
function topLevelKeys(constName) {
  const declStart = source.indexOf(`const ${constName} = {`)
  if (declStart === -1) {
    throw new Error(`const ${constName} not found in SideDialog.vue`)
  }
  const braceStart = source.indexOf('{', declStart)
  let depth = 0
  let braceEnd = -1
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') {
      depth--
      if (depth === 0) {
        braceEnd = i
        break
      }
    }
  }
  // -> Strips `//`-to-end-of-line comments first, so a commented-out entry can never be picked up
  //    as a real key by the purely textual scan below.
  const body = source
    .slice(braceStart + 1, braceEnd)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  // -> Only keys at nesting depth 0 within this object's own body -- skips the ones inside each
  //    entry's own nested call.
  const keys = []
  let nested = 0
  const keyPattern = /(\w+):/g
  let match
  while ((match = keyPattern.exec(body))) {
    const before = body.slice(0, match.index)
    const opens = (before.match(/[{(]/g) || []).length
    const closes = (before.match(/[})]/g) || []).length
    nested = opens - closes
    if (nested === 0) {
      keys.push(match[1])
    }
  }
  return keys.sort()
}

/**
 * `SideDialog`'s `<w-dialog>` gets its accessible name from `SIDE_DIALOG_TITLES`, keyed by which
 * `sideDialogs` child is loaded. A key in one map but not the other leaves that one screen's dialog
 * unnamed with no visible symptom, so this guards the two staying in lockstep -- cheaper than
 * mounting each dynamically-imported child dialog for real.
 */
describe('SideDialog accessible-name map', () => {
  it('SIDE_DIALOG_TITLES covers exactly the same keys as sideDialogs', () => {
    expect(topLevelKeys('SIDE_DIALOG_TITLES')).toEqual(topLevelKeys('sideDialogs'))
  })

  it('is not accidentally empty -- both maps still have at least the two known panels', () => {
    expect(topLevelKeys('sideDialogs')).toEqual(['PageBacklinksDialog', 'PagePropertiesDialog'])
  })
})

/**
 * A source-text scan: no suite here renders real Chromium layout for Cobalt-only CSS, so this
 * guards the rule text against regression, not the rendered corners.
 */
describe('SideDialog Cobalt corner-radius fix', () => {
  const styleBlock = source.slice(source.indexOf('<style'), source.indexOf('</style>'))
  const panelBlock = styleBlock.slice(
    styleBlock.indexOf('.floating-sidepanel {'),
    styleBlock.lastIndexOf('}')
  )

  it('makes the panel transparent and non-clipping under Cobalt', () => {
    expect(panelBlock).toMatch(
      /\.body--cobalt \.floating-sidepanel \.w-dialog-panel {\s*background: transparent;\s*overflow: visible;/
    )
  })

  it('rounds the header band to the side-dialog radii (top-left only)', () => {
    expect(panelBlock).toMatch(
      /\.body--cobalt \.floating-sidepanel \.w-toolbar {\s*border-radius: 12px 0 0 0;/
    )
  })

  it('rounds and fills the body band to the side-dialog radii (bottom-left only)', () => {
    expect(panelBlock).toMatch(
      /\.body--cobalt \.floating-sidepanel \.w-scroll-area {\s*border-radius: 0 0 0 12px;\s*background-color: var\(--color-white\);/
    )
    expect(panelBlock).toMatch(
      /\.body--cobalt\.body--dark \.floating-sidepanel \.w-scroll-area {\s*background-color: var\(--color-dark-3\);/
    )
  })

  it('keeps every Cobalt corner-radius rule scoped inside .floating-sidepanel, out of MainOverlayDialog', () => {
    const outsidePanel =
      styleBlock.slice(0, styleBlock.indexOf('.floating-sidepanel {')) +
      styleBlock.slice(styleBlock.lastIndexOf('}') + 1)
    expect(outsidePanel).not.toMatch(/border-radius: 12px 0 0 0/)
    expect(outsidePanel).not.toMatch(/border-radius: 0 0 0 12px/)
  })
})

/**
 * Both dialogs mounted here wrap their content in one root `<w-card>`, the panel's direct child,
 * and `WCard.vue`'s own Cobalt radius is smaller than the panel's, which the toolbar and scroll-area
 * above round themselves to. Left filled, the card's smaller corner shows through as a mismatched
 * notch just inside the header's wider curve. Source-text scan, as above.
 */
describe('SideDialog Cobalt card fringe (OpenProject #2895)', () => {
  const styleBlock = source.slice(source.indexOf('<style'), source.indexOf('</style>'))
  const panelBlock = styleBlock.slice(
    styleBlock.indexOf('.floating-sidepanel {'),
    styleBlock.lastIndexOf('}')
  )

  it('stops the card filling itself, or drawing its own edge, under Cobalt', () => {
    expect(panelBlock).toMatch(
      /\.body--cobalt \.floating-sidepanel \.w-card {\s*background: transparent;\s*box-shadow: none;/
    )
  })

  it('leaves the card rule out of every other file -- it belongs to the side panel alone', () => {
    const outsidePanel =
      styleBlock.slice(0, styleBlock.indexOf('.floating-sidepanel {')) +
      styleBlock.slice(styleBlock.lastIndexOf('}') + 1)
    expect(outsidePanel).not.toMatch(/\.w-card(?![\w-])/)
  })
})
