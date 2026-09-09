import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, 'SideDialog.vue'), 'utf-8')

/**
 * Extracts the top-level property names of a `const NAME = { ... }` object literal from raw source,
 * by brace-depth counting rather than a regex over the whole file -- both `sideDialogs` and
 * `SIDE_DIALOG_TITLES` nest their own object literals per entry (`defineAsyncComponent({...})`, and
 * an arrow function respectively), so a naive "match every `word:`" scan would also pick up their
 * inner `loader:`/`loadingComponent:` keys.
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
  // -> Strips `//`-to-end-of-line comments first, so a commented-out entry (as `AdminLayout.vue`'s
  //    equivalent `overlays` map has) can never be picked up as a real key by the purely textual scan
  //    below.
  const body = source
    .slice(braceStart + 1, braceEnd)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  // -> Only keys at nesting depth 0 within this object's own body -- skips `loader:`/`loadingComponent:`
  //    inside each entry's nested `defineAsyncComponent({...})` call.
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
 * OpenProject #2356: `SideDialog`'s `<w-dialog>` gets its accessible name from a small lookup map
 * (`SIDE_DIALOG_TITLES`) keyed by which child `sideDialogs` component is currently loaded -- there is
 * no title of its own to read, since the loaded child owns the only visible heading. A key present in
 * one map but not the other is exactly the failure mode that would silently leave that one screen's
 * dialog unnamed with no visible symptom, so this guards the two maps staying in lockstep rather than
 * asserting against a full, heavier mount of each real (dynamically-imported) child dialog.
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
 * OpenProject #2865: under `.body--cobalt`, the panel itself must stop clipping/filling and the
 * header/body bands must carry the side-specific radii instead -- a source-text scan since no
 * suite in this codebase renders real Chromium layout for Cobalt-only CSS (that gap is documented
 * risk, not something this guard tries to close). This only guards regression of the rule text,
 * not the actual rendered corners.
 */
describe('SideDialog Cobalt corner-radius fix', () => {
  const styleBlock = source.slice(source.indexOf('<style'), source.indexOf('</style>'))
  const panelBlock = styleBlock.slice(
    styleBlock.indexOf('.floating-sidepanel {'),
    styleBlock.lastIndexOf('}')
  )

  it('makes the panel transparent and non-clipping under Cobalt', () => {
    expect(panelBlock).toMatch(
      /\.w-dialog-panel\s*{[^}]*@at-root \.body--cobalt & {[^}]*background: transparent;[^}]*overflow: visible;/s
    )
  })

  it('rounds the header band to the side-dialog radii (top-left only)', () => {
    expect(panelBlock).toMatch(
      /\.w-toolbar\s*{[^}]*@at-root \.body--cobalt & {[^}]*border-radius: 12px 0 0 0;/s
    )
  })

  it('rounds and fills the body band to the side-dialog radii (bottom-left only)', () => {
    expect(panelBlock).toMatch(
      /\.w-scroll-area\s*{[^}]*@at-root \.body--cobalt & {[^}]*border-radius: 0 0 0 12px;[^}]*background-color: var\(--color-white\);/s
    )
    expect(panelBlock).toMatch(
      /@at-root \.body--cobalt\.body--dark & {[^}]*background-color: var\(--color-dark-3\);/s
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
