import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mountWithApp } from '../../test/mount.js'
import { pendingProfileSaves } from '../composables/profileSaving.js'

import WDialog from './shared/WDialog.vue'

import MainOverlayDialog from './MainOverlayDialog.vue'

/*
  Every entry in `overlays` is a real, dynamically-imported SFC with its own mount cost and
  network/store setup -- PageHistoryOverlay alone pulls in Monaco's diff viewer -- so the ones the
  behavioral describes actually open are stubbed. Specifiers are written exactly as
  `MainOverlayDialog.vue` writes them, so they resolve to the same module ids.

  `__esModule: true` is required, not decoration: `defineAsyncComponent` unwraps `.default` only from
  a namespace it recognises as an ES module, and Vitest's proxy around the mock THROWS on any export
  the factory did not declare -- surfacing as unhandled rejections beside a green run rather than as
  a failure.
*/
vi.mock('./PageHistoryOverlay.vue', () => ({
  __esModule: true,
  default: { template: '<div class="page-history-overlay-stub" />' }
}))
vi.mock('./NavEditOverlay.vue', () => ({
  __esModule: true,
  default: { template: '<div class="nav-edit-overlay-stub" />' }
}))
vi.mock('./ProfileOverlay.vue', () => ({
  __esModule: true,
  default: { template: '<div class="profile-overlay-stub" />' }
}))

const source = readFileSync(join(import.meta.dirname, 'MainOverlayDialog.vue'), 'utf-8')

/**
 * Brace-depth counting rather than a regex over the whole file: both `overlays` and `OVERLAY_TITLES`
 * nest their own object literals per entry, so a naive "match every `word:`" scan would also pick up
 * their inner keys.
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
  // -> Strip `//`-to-end-of-line comments first, so a commented-out entry can never be picked up as
  //    a real key by the purely textual scan below.
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

describe('MainOverlayDialog overlay-opts pass-through', () => {
  it('forwards siteStore.overlayOpts to the mounted overlay as the overlay-opts prop', () => {
    expect(source).toContain(
      '<component :is="overlays[siteStore.overlay]" :overlay-opts="siteStore.overlayOpts" />'
    )
  })
})

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
    // -> The floor lives in the shared `css/_overlay-dialog.css` partial, asserted here too, since
    //    a `50vw` with no floor anywhere would be crushed on a phone.
    expect(source).toContain("width: '50vw'")
    expect(source).toContain("height: '50vh'")
    expect(source).toContain(':class="{ \'is-half-sized\': isHalfSized }"')

    const overlayDialogCss = readFileSync(
      join(import.meta.dirname, '..', 'css', '_overlay-dialog.css'),
      'utf-8'
    )
    expect(overlayDialogCss).toContain('&.is-half-sized > .w-dialog-viewport > .w-dialog-panel')
    expect(overlayDialogCss).toContain('min-width: min(560px, 100%)')
    expect(overlayDialogCss).toContain('min-height: 420px')
  })
})

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

  it('reads overlayIsShown one-way and writes back through a $patch, not a plain v-model', () => {
    expect(source).not.toMatch(/v-model="siteStore\.overlayIsShown"/)
    expect(source).toContain(':model-value="siteStore.overlayIsShown"')
    expect(source).toContain('@update:model-value="onDialogModelUpdate"')
    expect(source).toMatch(
      /function onDialogModelUpdate\(value\) \{\s*if \(!value\) \{\s*if \(siteStore\.overlay === 'Profile' && pendingProfileSaves\.value > 0\) \{\s*return\s*\}\s*siteStore\.\$patch\(\{ overlay: '' \}\)/
    )
  })
})

/**
 * A real mount rather than a source scan, because the behavior under test is a chain no assertion on
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
    //    unmount; an open one left mounted carries its depth and Escape handler into the next test.
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
   * Rollback is destructive, so an Escape with `PageHistoryOverlay`'s restore confirmation open must
   * close only the confirmation, never the overlay underneath it. `composables/escapeStack.js` is a
   * LIFO stack walked top-down, stopping at the first handler that does not decline, and the confirm
   * registers after the overlay.
   *
   * A plain `WDialog` stands in for the confirm (`WConfirmDialog` wraps exactly one, non-persistent
   * whenever a cancel button is shown). What matters is the stacking, not which component is on top.
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

describe('MainOverlayDialog Profile close-while-saving guard (OpenProject #3282)', () => {
  const mounted = []

  beforeEach(() => {
    pendingProfileSaves.value = 0
  })

  afterEach(() => {
    while (mounted.length) {
      mounted.pop().unmount()
    }
    pendingProfileSaves.value = 0
  })

  async function openOverlay(overlay) {
    const result = mountWithApp(MainOverlayDialog, {
      stores: { site: { overlay } }
    })
    mounted.push(result.wrapper)
    await flushPromises()
    return result
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return nextTick()
  }

  it('refuses to close Profile on Escape while a save is pending', async () => {
    const { siteStore } = await openOverlay('Profile')
    pendingProfileSaves.value = 1

    await pressEscape()

    expect(siteStore.overlay).toBe('Profile')
    expect(siteStore.overlayIsShown).toBe(true)
  })

  it('closes Profile on Escape once the pending count drops back to zero', async () => {
    const { siteStore } = await openOverlay('Profile')
    pendingProfileSaves.value = 1

    await pressEscape()
    expect(siteStore.overlay).toBe('Profile')

    pendingProfileSaves.value = 0
    await pressEscape()

    expect(siteStore.overlay).toBe('')
  })

  it('leaves PageHistory dismissible on Escape even while pendingProfileSaves is nonzero', async () => {
    const { siteStore } = await openOverlay('PageHistory')
    pendingProfileSaves.value = 1

    await pressEscape()

    expect(siteStore.overlay).toBe('')
  })
})
