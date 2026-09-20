import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import MainLayout from './MainLayout.vue'
import { useSiteStore } from '@/stores/site'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * `NavSidebar` is a minimal fake rather than the real `NavSidebarItem.vue` tree: this suite covers
 * only `MainLayout.vue`'s own measurement/clamping/reactivity, which cares about nothing more than
 * "a `.truncate` span exists somewhere under the mounted `NavSidebar`'s root element".
 *
 * `happy-dom` runs no layout engine, so `clientWidth`/`scrollWidth`/`offsetParent` report nothing
 * meaningful -- all three are overridden at the `HTMLElement.prototype` level, keyed off each
 * rendered span's `data-test-id`. Per label, `chrome` is its row's icon/padding/indentation
 * overhead (depth-dependent, hence per-label rather than one constant) and `natural` its intrinsic
 * un-clipped text width.
 *
 * `measureSidebarWidth()` temporarily opts a label OUT of cross-axis stretch
 * (`alignSelf = 'flex-start'`) for one synchronous read, so the `clientWidth` mock honours that
 * too. `scrollWidth` is derived from `clientWidth` rather than handed its own number because that
 * is the DOM invariant this bug is about: it can never report LESS than `clientWidth`. Modelling
 * that generically is what makes "shrinks back down ..." below a real regression test -- an
 * implementation that reads `scrollWidth` while still stretched floors at the already-grown width
 * and can never shrink.
 */

const widths = new Map()

function setLabelMetrics(id, { chrome = 0, natural = 0, visible = true } = {}) {
  widths.set(id, { chrome, natural, visible })
}

/** Read by the `clientWidth` mock, so it reflects whatever width `MainLayout.vue` has ACTUALLY
 *  applied at the moment a test reads it, the same as a real browser would. */
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
        // -> Opted out of cross-axis stretch: an un-stretched flex item shrinks to its content.
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
      // -> The real DOM invariant: never less than `clientWidth`, whichever state that reports.
      return Math.max(this.clientWidth, entry.natural)
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      const entry = widths.get(this.dataset?.testId)
      if (!entry) {
        // -> No metrics entry means it is not a `.truncate` label being measured; default visible
        //    so a stray read never accidentally excludes a real label.
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

/** Several ticks, not one: the deep `nav.items` watch and the `MutationObserver` callback each
 *  defer their own `measureSidebarWidth()` through a further `nextTick`, on top of the re-render. */
async function settle() {
  await nextTick()
  await nextTick()
  await nextTick()
}

/** Read off the DOM rather than a `<script setup>` internal, which is not part of the component's
 *  public instance -- this exercises the real `sidebarWidth` computed end to end. */
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
    // The hidden label alone would need 500, a distinctly larger figure, so a leak is easy to spot.
    expect(sidebarWidthOf(wrapper)).toBe(300)
  })

  it('shrinks back down once the nav tree no longer holds the wide label', async () => {
    setLabelMetrics('wide', { chrome: 100, natural: 500 })
    const { wrapper, siteStore } = await mountLayout([{ id: 'wide', label: 'A very long one' }])
    await settle()
    // 600, clamped to the cap
    expect(sidebarWidthOf(wrapper)).toBe(510)

    setLabelMetrics('narrow', { chrome: 100, natural: 180 })
    siteStore.nav.items = [{ id: 'narrow', label: 'Short' }]
    await settle()
    // Well below the previous grown width: it really shrinks rather than only ratcheting upward.
    expect(sidebarWidthOf(wrapper)).toBe(280)
  })

  it('re-measures when a descendant toggles its inline style, as a folder expanding/collapsing would', async () => {
    setLabelMetrics('a', { chrome: 100, natural: 200 })
    const { wrapper } = await mountLayout([{ id: 'a', label: 'Alpha' }])
    await settle()
    expect(sidebarWidthOf(wrapper)).toBe(300)

    // Appending a descendant is a plain `childList` mutation the observer never watches, so on its
    // own it changes nothing.
    setLabelMetrics('b', { chrome: 100, natural: 260 })
    const root = wrapper.get('.sidebar-nav').element
    const newSpan = document.createElement('span')
    newSpan.className = 'truncate'
    newSpan.dataset.testId = 'b'
    newSpan.setAttribute('style', 'display:none')
    root.appendChild(newSpan)

    // The actual trigger: an inline-`style` mutation on an existing node, exactly what `v-show`
    // does when an expansion item opens. No `nav.items` change and no Vue re-render at all, so only
    // the `MutationObserver` can be what notices.
    newSpan.setAttribute('style', 'display:block')
    await settle()

    expect(sidebarWidthOf(wrapper)).toBe(360)
  })
})
