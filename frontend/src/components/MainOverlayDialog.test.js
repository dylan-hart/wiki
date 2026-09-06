import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mountWithApp } from '../../test/mount.js'

import WDialog from './shared/WDialog.vue'

import MainOverlayDialog from './MainOverlayDialog.vue'

/*
  Every entry in `overlays` is a real, dynamically-imported SFC with its own mount cost and
  network/store setup -- PageHistoryOverlay alone pulls in Monaco's diff viewer. The two the
  behavioral describe at the bottom of this file actually opens are stubbed out, so what is under
  test is `MainOverlayDialog`'s own dismissal wiring rather than whatever the child happens to do on
  mount. Both specifiers are written exactly as `MainOverlayDialog.vue` writes them; this test file
  sits in the same directory, so they resolve to the same module ids.

  `__esModule: true` is required, not decoration: `defineAsyncComponent` unwraps `.default` only from
  a namespace it recognises as an ES module, and without the flag it hands Vue the mocked namespace
  itself as the component. Vitest wraps that namespace in a proxy that THROWS on any export the
  factory did not declare, so the first internal `type.__isTeleport` probe rejects -- as three
  unhandled rejections beside a fully green run, which is the hardest shape of this to notice.
*/
vi.mock('./PageHistoryOverlay.vue', () => ({
  __esModule: true,
  default: { template: '<div class="page-history-overlay-stub" />' }
}))
vi.mock('./NavEditOverlay.vue', () => ({
  __esModule: true,
  default: { template: '<div class="nav-edit-overlay-stub" />' }
}))

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
 * Follow-up feedback on WP 2531/2532, extended by OpenProject #2638: Profile, Inbox, FileManager and
 * PageHistory dismiss on a backdrop click or Escape, like an ordinary modal, since none of the four
 * can lose in-progress work to a stray click (a settings save, an inbox action, a file op each commit
 * immediately; page history is read-only browsing). Every other entry (BlockPicker, NavEdit,
 * TableEditor, Welcome) keeps the persistent, Close-button-only behavior it already had, since those
 * genuinely can sit mid-edit with real state to lose.
 */
describe('MainOverlayDialog dismissible overlays', () => {
  it('drives persistent off isDismissible, not a fixed true', () => {
    expect(source).toContain(':persistent="!isDismissible"')
    expect(source).not.toMatch(/<w-dialog[^>]*\bpersistent\b(?!="!isDismissible")/)
  })

  it('only Profile, Inbox, FileManager and PageHistory are dismissible', () => {
    expect(source).toMatch(
      /DISMISSIBLE_OVERLAYS = new Set\(\['Profile', 'Inbox', 'FileManager', 'PageHistory'\]\)/
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

/**
 * OpenProject #2638: the source scans above prove which names are in the set; this proves the set
 * membership actually reaches the reader. `PageHistory` was persistent purely by omission, so Escape
 * did nothing at all and its own Close button was the single way out of a read-only dialog that
 * discards nothing when it closes.
 *
 * Driven through a real mount of `MainOverlayDialog` (with the two child overlays stubbed at the top
 * of this file) rather than a source scan, because the behavior under test is a chain no assertion on
 * the `new Set([...])` literal can stand in for: `isDismissible` -> `<w-dialog>`'s `persistent` prop
 * -> `WDialog#handleEscape` consuming rather than declining the keypress -> `update:model-value`
 * -> `onDialogModelUpdate`'s `$patch({ overlay: '' })`.
 *
 * The Escape is dispatched on `document`, which is where `composables/escapeStack.js` binds its one
 * shared bubble-phase listener, so the harness's default `stubs: { teleport: true }` is not in the
 * way and there is no reason to opt out of it.
 */
describe('MainOverlayDialog Escape dismissal', () => {
  const mounted = []

  afterEach(() => {
    // -> `WDialog` reference-counts `body.dataset.wDialogDepth` and only releases on close or
    //    unmount; an open dialog left mounted would carry its depth (and its Escape handler) into
    //    the next test in this file.
    while (mounted.length) {
      mounted.pop().unmount()
    }
  })

  async function openOverlay(overlay) {
    const result = mountWithApp(MainOverlayDialog, {
      stores: { site: { overlay } },
      messages: {
        'history.title': 'History',
        'navEdit.editMenuItems': 'Edit Menu Items'
      }
    })
    mounted.push(result.wrapper)
    // -> Every `overlays` entry is a `defineAsyncComponent`, so the (mocked) loader still resolves a
    //    tick later; without this the dialog is up but still rendering `LoadingGeneric`.
    await flushPromises()
    return result
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return nextTick()
  }

  it('closes the page history overlay on Escape', async () => {
    const { siteStore } = await openOverlay('PageHistory')
    expect(siteStore.overlayIsShown).toBe(true)

    await pressEscape()

    expect(siteStore.overlay).toBe('')
    expect(siteStore.overlayIsShown).toBe(false)
  })

  it('leaves an overlay that can hold unsaved edits open on Escape', async () => {
    const { siteStore } = await openOverlay('NavEdit')
    expect(siteStore.overlayIsShown).toBe(true)

    await pressEscape()

    expect(siteStore.overlay).toBe('NavEdit')
  })

  /**
   * The one risk this Bug was told to verify rather than assume: rollback is destructive, so an
   * Escape with `PageHistoryOverlay`'s restore confirmation open must close only the confirmation,
   * never the overlay underneath it. Dismissal is routed through `composables/escapeStack.js` -- a
   * LIFO stack, walked top-down, stopping at the first handler that does not decline -- and the
   * confirm registers after the overlay, so it is strictly on top.
   *
   * Stood up here with a second, plain `WDialog` standing in for the confirm (`WConfirmDialog` wraps
   * exactly one, non-persistent whenever a cancel button is shown, which the restore confirmation's
   * `cancel: true` gives it). What matters is the stacking, not which component is on top.
   */
  it('a confirmation stacked on top takes the first Escape, the overlay only the second', async () => {
    const { siteStore } = await openOverlay('PageHistory')

    const confirmClosed = vi.fn()
    const confirmOnTop = mountWithApp(WDialog, {
      props: { modelValue: true, 'onUpdate:modelValue': confirmClosed }
    })
    mounted.push(confirmOnTop.wrapper)
    await nextTick()

    await pressEscape()
    expect(confirmClosed).toHaveBeenCalledWith(false)
    expect(siteStore.overlay).toBe('PageHistory')

    // -> The confirm is driven by its own parent state in the real app; here, unmounting it is what
    //    "it closed" means to the stack -- that is what releases its handler.
    mounted.pop().unmount()
    await nextTick()

    await pressEscape()
    expect(siteStore.overlay).toBe('')
  })
})
