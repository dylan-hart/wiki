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

  const knownOverlays = [
    'BlockPicker',
    'EditorMarkdownConfig',
    'FileManager',
    'Inbox',
    'NavEdit',
    'PageHistory',
    'Profile',
    'TableEditor',
    'Welcome'
  ].sort()

  it(`is not accidentally empty -- still has all ${knownOverlays.length} known overlays`, () => {
    expect(topLevelKeys('overlays')).toEqual(knownOverlays)
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

/**
 * OpenProject #2543 follow-up: Profile and Inbox are short, focused forms/lists, not a file browser
 * or a block gallery -- a full-screen panel dwarfed either one, so they render at roughly half the
 * viewport instead. Checked against the source rather than a full mount, matching this file's other
 * checks: every `overlays` entry is a real, dynamically-imported SFC with its own mount cost.
 */
describe('MainOverlayDialog half-sized overlays', () => {
  it('drives full-width/full-height and width/height off isHalfSized, not a fixed true', () => {
    expect(source).toContain(':full-width="!isHalfSized"')
    expect(source).toContain(':full-height="!isHalfSized"')
    expect(source).toContain(':width="isHalfSized ? HALF_SIZE.width : null"')
    expect(source).toContain(':height="isHalfSized ? HALF_SIZE.height : null"')
  })

  it('only Profile and Inbox are half-sized -- every other overlay stays full-screen', () => {
    expect(source).toMatch(
      /isHalfSized = computed\(\(\) => siteStore\.overlay === 'Profile' \|\| siteStore\.overlay === 'Inbox'\)/
    )
  })

  it('sizes HALF_SIZE at half the viewport, with the floor on the panel and no ceiling', () => {
    // -> The design draws `50vw`/`50vh` with a `min(560px, 100%)` / `420px` floor and nothing above
    //    it (`ui-redesign/Cardinal Wiki - Inbox 3x.dc.html`). The floor belongs on the panel rather
    //    than on the dialog's own box, so it lives in `MainLayout.vue`'s `.is-half-sized` rule --
    //    which this asserts too, since a `50vw` with no floor anywhere would be crushed on a phone.
    expect(source).toContain("width: '50vw'")
    expect(source).toContain("height: '50vh'")
    expect(source).toContain(':class="{ \'is-half-sized\': isHalfSized }"')

    const layout = readFileSync(
      join(import.meta.dirname, '..', 'layouts', 'MainLayout.vue'),
      'utf-8'
    )
    expect(layout).toContain('&.is-half-sized > .w-dialog-viewport > .w-dialog-panel')
    expect(layout).toContain('min-width: min(560px, 100%)')
    expect(layout).toContain('min-height: 420px')
  })
})

/**
 * Follow-up feedback on WP 2531/2532: Profile, Inbox and FileManager dismiss on a backdrop click or
 * Escape, like an ordinary modal, since none of the three can lose in-progress work to a stray click
 * (a settings save, an inbox action, a file op each commit immediately) -- every other entry
 * (BlockPicker, NavEdit, PageHistory, TableEditor, Welcome) keeps the persistent, Close-button-only
 * behavior it already had, since those genuinely can sit mid-edit with real state to lose.
 */
describe('MainOverlayDialog dismissible overlays', () => {
  it('drives persistent off isDismissible, not a fixed true', () => {
    expect(source).toContain(':persistent="!isDismissible"')
    expect(source).not.toMatch(/<w-dialog[^>]*\bpersistent\b(?!="!isDismissible")/)
  })

  it('only Profile, Inbox and FileManager are dismissible', () => {
    expect(source).toMatch(
      /DISMISSIBLE_OVERLAYS = new Set\(\['Profile', 'Inbox', 'FileManager'\]\)/
    )
  })

  /**
   * `siteStore.overlayIsShown` is a Pinia getter (computed from `state.overlay`), which has no
   * setter -- a plain `v-model` on `<w-dialog>` assigns to it directly and Vue warns "target is
   * readonly" instead of closing anything. Latent for as long as every entry was `persistent` (WDialog
   * never had a reason to emit `update:model-value`), and only reachable once backdrop/Escape dismissal
   * above was turned on. Fixed by reading the getter one-way (`:model-value`) and writing through the
   * same `overlay: ''` `$patch` every overlay's own Close button already uses.
   */
  it('reads overlayIsShown one-way and writes back through a $patch, not a plain v-model', () => {
    expect(source).not.toMatch(/v-model="siteStore\.overlayIsShown"/)
    expect(source).toContain(':model-value="siteStore.overlayIsShown"')
    expect(source).toContain('@update:model-value="onDialogModelUpdate"')
    expect(source).toMatch(
      /function onDialogModelUpdate\(value\) \{\s*if \(!value\) \{\s*siteStore\.\$patch\(\{ overlay: '' \}\)/
    )
  })
})
