import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import WDrawer from './WDrawer.vue'

/**
 * The failure mode guarded here: `.w-layout`'s CSS Grid places `WDrawer`'s `ldrawer`/`rdrawer`
 * areas by LOGICAL column order, which the Grid spec itself mirrors under `dir="rtl"`, so
 * `side="left"` renders at the visual RIGHT in an RTL document. The grid does that mirroring for
 * free at the wide breakpoint but not at the narrow/overlay one (`position: fixed`, outside the
 * grid), and `useMinWidth`'s breakpoint reads CSS-pixel viewport width -- which browser zoom
 * changes. A physical `left`/`right`/`border-l` therefore reads correct at 100% zoom and breaks at
 * another zoom level, rather than being always-broken under RTL.
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
  // -> Each test uses its OWN `overlayBelow` value: `useMinWidth` (`composables/screen.js`) caches
  //    one shared `matchMedia` listener per exact breakpoint number at module scope, and the module
  //    instance is never torn down between `it()`s, so reusing a breakpoint number would read the
  //    FIRST test's stubbed width. A distinct number per test sidesteps the cache.
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
