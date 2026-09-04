import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, 'MainOverlayDialog.vue'), 'utf-8')

/**
 * Extracts the top-level property names of a `const NAME = { ... }` object literal from raw source,
 * by brace-depth counting rather than a regex over the whole file -- both `overlays` and
 * `OVERLAY_TITLES` nest their own object literals per entry (`defineAsyncComponent({...})`, and an
 * arrow function respectively), so a naive "match every `word:`" scan would also pick up their inner
 * `loader:`/`loadingComponent:` keys.
 */
function topLevelKeys(constName) {
  const declStart = source.indexOf(`const ${constName} = {`)
  if (declStart === -1) {
    throw new Error(`const ${constName} not found in MainOverlayDialog.vue`)
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
  const keys = []
  const keyPattern = /(\w+):/g
  let match
  while ((match = keyPattern.exec(body))) {
    const before = body.slice(0, match.index)
    const opens = (before.match(/[{(]/g) || []).length
    const closes = (before.match(/[})]/g) || []).length
    if (opens - closes === 0) {
      keys.push(match[1])
    }
  }
  return keys.sort()
}

/**
 * OpenProject #2356: `MainOverlayDialog`'s `<w-dialog>` gets its accessible name from a small lookup
 * map (`OVERLAY_TITLES`) keyed by which child `overlays` component is currently loaded -- there is no
 * title of its own to read, since the loaded child owns the only visible heading. A key present in one
 * map but not the other is exactly the failure mode that would silently leave that one screen's dialog
 * unnamed with no visible symptom, so this guards the two maps staying in lockstep rather than
 * asserting against a full, heavier mount of each real (dynamically-imported) child overlay.
 */
describe('MainOverlayDialog accessible-name map', () => {
  it('OVERLAY_TITLES covers exactly the same keys as overlays', () => {
    expect(topLevelKeys('OVERLAY_TITLES')).toEqual(topLevelKeys('overlays'))
  })

  it('is not accidentally empty -- still has all eight known overlays', () => {
    expect(topLevelKeys('overlays')).toEqual(
      [
        'BlockPicker',
        'EditorMarkdownConfig',
        'FileManager',
        'Inbox',
        'NavEdit',
        'PageHistory',
        'TableEditor',
        'Welcome'
      ].sort()
    )
  })
})

/**
 * OpenProject #2530: whichever overlay is mounted must receive `siteStore.overlayOpts` as a real prop,
 * not just have it sit unread on the store -- this is the one line that actually wires the two
 * together, so it is checked directly against the source rather than through a full async-component
 * mount (every entry in `overlays` above is a real, dynamically-imported SFC with its own mount cost
 * and network/store setup; see each overlay's own test file for behavior coverage of what it does with
 * the prop once received).
 */
describe('MainOverlayDialog overlay-opts pass-through', () => {
  it('forwards siteStore.overlayOpts to the mounted overlay as the overlay-opts prop', () => {
    expect(source).toContain(
      '<component :is="overlays[siteStore.overlay]" :overlay-opts="siteStore.overlayOpts" />'
    )
  })
})
