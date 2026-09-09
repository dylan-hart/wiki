import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import MainLayout from './MainLayout.vue'
import { useSiteStore } from '@/stores/site'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Coverage for OpenProject #2850: `MainLayout.vue`'s `SIDEBAR_WIDTH` used to be a plain `255`
 * constant. It is now a reactive value, measured off the widest currently-visible nav item
 * label's own natural (un-clipped) content width, clamped to `[255, 510]`.
 *
 * `NavSidebar` is replaced here with a minimal fake rather than mounting the real
 * `NavSidebarItem.vue` tree (#2849's own concern, tested there): this suite is only about
 * `MainLayout.vue`'s OWN measurement/clamping/reactivity logic, which cares about nothing more
 * than "a `.truncate` span exists somewhere under the mounted `NavSidebar` instance's root
 * element" -- see the epic's own coordination note for why #2850 stays isolated to
 * `MainLayout.vue` rather than reaching into `NavSidebarItem.vue`.
 *
 * `happy-dom` (the frontend's test environment) runs no real layout engine, so
 * `clientWidth`/`scrollWidth`/`offsetParent` report nothing meaningful on their own -- this suite
 * overrides all three at the `HTMLElement.prototype` level, keyed off each rendered span's
 * `data-test-id` (the same "stub the widths directly" convention `NavSidebarItem.test.js` already
 * uses for its own `checkTruncation` coverage).
 *
 * Each label carries a fixed `chrome` (its row's own icon/padding/indentation overhead --
 * `MainLayout.vue`'s own doc comment on `measureSidebarWidth` explains why this is depth-
 * dependent and therefore per-label, not a single constant) and a fixed `natural` (its intrinsic,
 * truly un-clipped text width -- what `scrollWidth` would report if nothing constrained the
 * label's own box).
 *
 * `clientWidth` is mocked as `currentDrawerWidth - chrome` while the label is stretched to fill
 * its `.w-item-section`'s cross axis (the normal, at-rest state) -- reading the ACTUAL
 * currently-applied drawer width off the real `<aside class="w-drawer">` node each time, exactly
 * as a real browser's layout would report it for a `flex-1` label filling whatever room the row's
 * current chrome leaves it. `measureSidebarWidth()` (OpenProject #2891's fix) temporarily opts a
 * label OUT of that stretch (`label.style.alignSelf = 'flex-start'`) for one synchronous read, so
 * the mock honours that too: whenever `alignSelf` reads `'flex-start'`, `clientWidth` reports the
 * label's own `natural` width instead (a flex item that isn't stretched shrinks to its content).
 *
 * `scrollWidth` is derived from `clientWidth` rather than handed its own independent number,
 * because that is the actual DOM invariant this whole bug is about: `scrollWidth` can never
 * report LESS than `clientWidth` (the scrollable region can't be smaller than the visible client
 * area), regardless of how much smaller the label's real content is. Modelling that generically
 * -- rather than handing each test a bare `scroll` value untethered from `clientWidth`, as this
 * suite used to -- is what makes "shrinks back down once the nav tree no longer holds the wide
 * label" below an actual regression test: it fails against the pre-#2891 implementation (which
 * reads `scrollWidth` while still stretched, so it floors at the current, already-grown
 * `clientWidth` and can never shrink) and passes only once `measureSidebarWidth()` genuinely
 * releases the stretch before reading.
 */

const widths = new Map()

function setLabelMetrics(id, { chrome = 0, natural = 0, visible = true } = {}) {
  widths.set(id, { chrome, natural, visible })
}

/** The real, currently-mounted `<aside class="w-drawer">` -- set by `mountLayout` below, and read
 *  by the `clientWidth` mock so it reflects whatever width `MainLayout.vue` has ACTUALLY applied
 *  at the moment a test reads it, the same as a real browser would. */
let currentDrawerEl = null

function currentDrawerWidth() {
  const style = currentDrawerEl?.getAttribute('style') ?? ''
  const match = /--w-drawer-width:\s*([\d.]+)px/.exec(style)
  return match ? Number(match[1]) : 255
}

const PATCHED_PROPS = ['clientWidth', 'scrollWidth', 'offsetParent']
let originalDescriptors

beforeEach(() => {
  widths.clear()
  currentDrawerEl = null
  originalDescriptors = Object.fromEntries(
    PATCHED_PROPS.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    ])
  )

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      const entry = widths.get(this.dataset?.testId)
      if (!entry) {
        return 0
      }
      if (this.style.alignSelf === 'flex-start') {
        // -> Opted out of cross-axis stretch (`measureSidebarWidth()`'s own trick): shrinks to its
        //    own natural content width, same as a real un-stretched flex item would.
        return entry.natural
      }
      return Math.max(0, currentDrawerWidth() - entry.chrome)
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      const entry = widths.get(this.dataset?.testId)
      if (!entry) {
        return 0
      }
      // -> The real DOM invariant: never less than `clientWidth`, whichever state that currently
      //    reports (see the suite's own header comment above).
      return Math.max(this.clientWidth, entry.natural)
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      const entry = widths.get(this.dataset?.testId)
      if (!entry) {
        // -> An element with no metrics entry of its own (the fake `NavSidebar`'s own root div,
        //    say) is never queried as a `.truncate` label, so its own visibility never matters --
        //    default true so a stray read never accidentally excludes a real label.
        return true
      }
      return entry.visible ? document.body : null
    }
  })
})

afterEach(() => {
  for (const name of PATCHED_PROPS) {
    const original = originalDescriptors[name]
    if (original) {
      Object.defineProperty(HTMLElement.prototype, name, original)
    } else {
      delete HTMLElement.prototype[name]
    }
  }
})

/** Every nav item becomes one `.truncate` span, keyed by id for the metrics map above. */
const FakeNavSidebar = defineComponent({
  name: 'NavSidebar',
  setup() {
    const siteStore = useSiteStore()
    return () =>
      h(
        'div',
        { class: 'sidebar-nav' },
        siteStore.nav.items.map((item) =>
          h('span', { class: 'truncate', key: item.id, 'data-test-id': item.id }, item.label)
        )
      )
  }
})

const LAYOUT_STUBS = {
  teleport: true,
  'router-view': true,
  HeaderNav: true,
  NavSidebar: FakeNavSidebar,
  MainOverlayDialog: true
}

/** Several ticks, not one -- the deep `siteStore.nav.items` watch and the `MutationObserver`
 *  callback each defer their own `measureSidebarWidth()` through a further `nextTick`, on top of
 *  whatever tick(s) the fake component's own re-render needs. */
async function settle() {
  await nextTick()
  await nextTick()
  await nextTick()
}

/** `WDrawer.vue` carries the resolved width as a `--w-drawer-width` custom property on its own
 *  root `<aside>` (never stubbed here) -- reading it off the DOM is what actually exercises the
 *  real `sidebarWidth` computed end to end, rather than reaching for a `<script setup>` internal
 *  that isn't part of this component's public instance. */
function sidebarWidthOf(wrapper) {
  const style = wrapper.get('aside.w-drawer').attributes('style') ?? ''
  const match = /--w-drawer-width:\s*([\d.]+)px/.exec(style)
  return match ? Number(match[1]) : null
}

async function mountLayout(items) {
  const router = await createTestRouter(['/'])
  const result = mountWithApp(MainLayout, {
    router,
    stubs: LAYOUT_STUBS,
    stores: {
      site: (store) => {
        store.nav.items = items
      }
    }
  })
  currentDrawerEl = result.wrapper.get('aside.w-drawer').element
  return result
}

describe('MainLayout auto-growing sidebar width (OpenProject #2850)', () => {
  it('floors at 255 with an empty nav tree', async () => {
    const { wrapper } = await mountLayout([])
    await settle()
    expect(sidebarWidthOf(wrapper)).toBe(255)
  })

  it('floors at 255 when every visible label already fits', async () => {
    setLabelMetrics('a', { chrome: 100, natural: 80 })
    const { wrapper } = await mountLayout([{ id: 'a', label: 'Short' }])
    await settle()
    expect(sidebarWidthOf(wrapper)).toBe(255)
  })

  it('grows to fit the widest visible label', async () => {
    setLabelMetrics('a', { chrome: 100, natural: 340 })
    const { wrapper } = await mountLayout([{ id: 'a', label: 'A rather long navigation label' }])
    await settle()
    // 100 + 340 = 440
    expect(sidebarWidthOf(wrapper)).toBe(440)
  })

  it('caps at 510 even when a label would need more', async () => {
    setLabelMetrics('a', { chrome: 50, natural: 900 })
    const { wrapper } = await mountLayout([{ id: 'a', label: 'An enormous navigation label' }])
    await settle()
    expect(sidebarWidthOf(wrapper)).toBe(510)
  })

  it('uses the widest across several visible labels, not merely the last one', async () => {
    setLabelMetrics('a', { chrome: 100, natural: 200 })
    setLabelMetrics('b', { chrome: 100, natural: 320 })
    setLabelMetrics('c', { chrome: 100, natural: 150 })
    const { wrapper } = await mountLayout([
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Bravo, the widest one here' },
      { id: 'c', label: 'Charlie' }
    ])
    await settle()
    // 100 + 320 = 420
    expect(sidebarWidthOf(wrapper)).toBe(420)
  })

  it('ignores a label whose offsetParent is null, as a collapsed folder descendant would read', async () => {
    setLabelMetrics('hidden', { chrome: 20, natural: 480, visible: false })
    setLabelMetrics('visible', { chrome: 100, natural: 200 })
    const { wrapper } = await mountLayout([
      { id: 'hidden', label: 'Deeply nested, currently collapsed' },
      { id: 'visible', label: 'Alpha' }
    ])
    await settle()
    // Only "visible" counts: 100 + 200 = 300. The hidden one alone would need 20 + 480 = 500,
    // which is a different, larger figure -- so a leak here would be easy to spot.
    expect(sidebarWidthOf(wrapper)).toBe(300)
  })

  it('shrinks back down once the nav tree no longer holds the wide label', async () => {
    setLabelMetrics('wide', { chrome: 100, natural: 500 })
    const { wrapper, siteStore } = await mountLayout([{ id: 'wide', label: 'A very long one' }])
    await settle()
    // 100 + 500 = 600, clamped to the 510 cap
    expect(sidebarWidthOf(wrapper)).toBe(510)

    setLabelMetrics('narrow', { chrome: 100, natural: 180 })
    siteStore.nav.items = [{ id: 'narrow', label: 'Short' }]
    await settle()
    // 100 + 180 = 280, well below the previous grown width -- proves it actually shrinks rather
    // than only ever ratcheting upward.
    expect(sidebarWidthOf(wrapper)).toBe(280)
  })

  it('re-measures when a descendant toggles its inline style, as a folder expanding/collapsing would', async () => {
    setLabelMetrics('a', { chrome: 100, natural: 200 })
    const { wrapper } = await mountLayout([{ id: 'a', label: 'Alpha' }])
    await settle()
    // 100 + 200 = 300
    expect(sidebarWidthOf(wrapper)).toBe(300)

    // A new, currently-hidden descendant appears in the tree -- appending it is a plain
    // `childList` mutation the observer never watches, so it changes nothing here on its own.
    setLabelMetrics('b', { chrome: 100, natural: 260 })
    const root = wrapper.get('.sidebar-nav').element
    const newSpan = document.createElement('span')
    newSpan.className = 'truncate'
    newSpan.dataset.testId = 'b'
    newSpan.setAttribute('style', 'display:none')
    root.appendChild(newSpan)

    // The actual trigger: a genuine inline-`style` mutation on an existing node -- exactly what
    // `v-show` does when `.w-expansion-item__content` opens. No `nav.items` change and no Vue
    // re-render at all; only the `MutationObserver` should be what notices this.
    newSpan.setAttribute('style', 'display:block')
    await settle()

    // 100 + 260 = 360, now the widest of the two
    expect(sidebarWidthOf(wrapper)).toBe(360)
  })
})
