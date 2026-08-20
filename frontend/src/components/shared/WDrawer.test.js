import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import WDrawer from './WDrawer.vue'

/**
 * OpenProject #834 ("RTL regression pass: linklist rendering + zoom/toolbar mirroring"), item 2:
 * zoom + RTL interaction (upstream discussion #2626, "Hebrew nav bar layout breaking at non-100%
 * zoom").
 *
 * `.w-layout`'s CSS Grid places `WDrawer`'s `ldrawer`/`rdrawer` areas by LOGICAL column order, which
 * the Grid spec itself mirrors under `dir="rtl"` -- column 1 (`ldrawer`, the site sidebar's default)
 * renders at the visual RIGHT once the document goes RTL. `WDrawer` had three places that still
 * assumed `side="left"` means the physical left unconditionally, which is exactly true at the
 * wide/grid breakpoint (where the grid does the mirroring for free) but silently wrong at the
 * narrow/overlay one (`position: fixed`, entirely outside the grid, so nothing mirrors it):
 *
 *   - the fixed-position anchor (`left-0`/`right-0` -> `start-0`/`end-0`)
 *   - the border facing `main` (`border-l`/`border-r` -> `border-e`/`border-s`)
 *   - the open/close slide transition (`margin-left`/`margin-right` -> `margin-inline-start`/`-end`)
 *
 * `useMinWidth`'s breakpoint (`overlayBelow`, 1200px for the site sidebar) reads CSS pixel viewport
 * width, which is exactly what browser zoom changes -- so a reader who is fine at 100% zoom (wide
 * mode, grid-mirrored, looks correct) can cross into narrow/overlay mode at another zoom level and
 * hit the un-mirrored physical positioning below, which is the "breaks at non-100% zoom" shape the
 * upstream discussion describes rather than a plain always-broken RTL bug.
 *
 * `@vue/test-utils` stubs `<transition>` by default, so `wrapper.element` resolves to the
 * `<transition-stub>` wrapper rather than the real `<aside>` -- every assertion below reads classes
 * off `wrapper.find('.w-drawer')`, the `<aside>` itself, instead of the bare `wrapper`.
 */

function stubMatchMedia(widthPx) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query) => {
      const minWidth = Number(query.match(/min-width:\s*(\d+)px/)[1])
      return {
        matches: widthPx >= minWidth,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {}
      }
    })
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('WDrawer overlay/narrow breakpoint (below `overlayBelow`, e.g. a zoomed-in viewport)', () => {
  // -> Each test uses its OWN `overlayBelow` value. `useMinWidth` (`composables/screen.js`) caches
  //    one shared `matchMedia` listener per exact breakpoint number at module scope, for the whole
  //    app's real benefit (one listener per breakpoint, not one per caller) -- but that means reusing
  //    a breakpoint number across tests in this file would read the FIRST test's stubbed width, not
  //    the current test's, since the already-imported module instance never gets torn down between
  //    `it()`s the way `screen.test.js`'s own `vi.resetModules()` + dynamic re-import does for that
  //    file. A distinct number per test sidesteps the cache instead of fighting it.
  it('anchors a start-side (`side="left"`) drawer with the logical inset-inline-start utility, not the physical left one', () => {
    stubMatchMedia(320)
    const wrapper = mount(WDrawer, {
      props: { modelValue: true, side: 'left', overlayBelow: 1201 }
    })
    const classes = wrapper.find('.w-drawer').classes()

    expect(classes).toContain('start-0')
    expect(classes).not.toContain('left-0')
    expect(classes).not.toContain('right-0')
    expect(classes).not.toContain('end-0')
  })

  it('anchors an end-side (`side="right"`) drawer with the logical inset-inline-end utility, not the physical right one', () => {
    stubMatchMedia(320)
    const wrapper = mount(WDrawer, {
      props: { modelValue: true, side: 'right', overlayBelow: 1202 }
    })
    const classes = wrapper.find('.w-drawer').classes()

    expect(classes).toContain('end-0')
    expect(classes).not.toContain('right-0')
    expect(classes).not.toContain('left-0')
    expect(classes).not.toContain('start-0')
  })

  it('adds neither inset utility once the viewport is wide (no longer overlaying, so nothing to anchor)', () => {
    stubMatchMedia(1600)
    const wrapper = mount(WDrawer, {
      props: { modelValue: true, side: 'left', overlayBelow: 1203 }
    })
    const classes = wrapper.find('.w-drawer').classes()

    expect(classes).not.toContain('start-0')
    expect(classes).not.toContain('end-0')
  })
})

describe('WDrawer border facing `main`', () => {
  it('uses the logical inline-end border for a start-side drawer', () => {
    const wrapper = mount(WDrawer, { props: { modelValue: true, side: 'left', bordered: true } })
    const classes = wrapper.find('.w-drawer').classes()

    expect(classes).toContain('border-e')
    expect(classes).not.toContain('border-l')
    expect(classes).not.toContain('border-r')
  })

  it('uses the logical inline-start border for an end-side drawer', () => {
    const wrapper = mount(WDrawer, { props: { modelValue: true, side: 'right', bordered: true } })
    const classes = wrapper.find('.w-drawer').classes()

    expect(classes).toContain('border-s')
    expect(classes).not.toContain('border-l')
    expect(classes).not.toContain('border-r')
  })
})

describe('WDrawer slide transition', () => {
  it('collapses both sides with a logical inline margin, never a physical left/right one', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'WDrawer.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

    expect(styleBlock).not.toMatch(/margin-left\s*:/)
    expect(styleBlock).not.toMatch(/margin-right\s*:/)
    expect(styleBlock).toMatch(
      /\.w-drawer--left\.w-drawer-enter-from,\s*\n\s*\.w-drawer--left\.w-drawer-leave-to\s*\{\s*margin-inline-start:/
    )
    expect(styleBlock).toMatch(
      /\.w-drawer--right\.w-drawer-enter-from,\s*\n\s*\.w-drawer--right\.w-drawer-leave-to\s*\{\s*margin-inline-end:/
    )
  })
})
