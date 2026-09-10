import { afterEach, describe, expect, it } from 'vitest'

import MainLayout from './MainLayout.vue'
import { useMinWidth } from '@/composables/screen'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #3032: `MainLayout.vue` mirrors its reactive `sidebarWidth` onto
 * `--sidebar-current-width`, a CSS custom property set via `:style` on the layout's own root
 * `<w-layout>` element -- `Index.vue`'s Cobalt `.w-footer` rule reads it (through plain CSS
 * inheritance) to inset from the sidebar's own edge, replacing #3018's opposite approach of
 * shrinking the sidebar to clear the footer bar instead. This suite is the pure reactive-value
 * coverage; `MainLayout.footerClearance.test.js` is the real-browser geometry proof that the CSS
 * consuming it actually behaves.
 *
 * Same direct-on-the-ref `useMinWidth` handling as this file's sibling suites (OpenProject
 * #2894/#2928's own notes explain why): a fresh `matchMedia` mock cannot reach a breakpoint another
 * test in the shared module-level cache already set.
 */

const LAYOUT_STUBS = {
  teleport: true,
  'router-view': true,
  HeaderNav: true,
  NavSidebar: true,
  MainOverlayDialog: true
}

async function mountLayout(path, options = {}) {
  const router = await createTestRouter([path], path)

  return mountWithApp(MainLayout, { router, stubs: LAYOUT_STUBS, ...options })
}

function currentWidthVar(wrapper) {
  return wrapper.element.style.getPropertyValue('--sidebar-current-width')
}

function headerNav(wrapper) {
  return wrapper.findComponent({ name: 'HeaderNav' })
}

describe('MainLayout --sidebar-current-width (OpenProject #3032)', () => {
  afterEach(() => {
    useMinWidth(1200).value = true
    useMinWidth(600).value = true
  })

  it('mirrors the full sidebar width on a wide viewport with the sidebar expanded', async () => {
    useMinWidth(1200).value = true

    const { wrapper } = await mountLayout('/')

    // -> `NavSidebar` is stubbed, so `measureSidebarWidth()` finds no `.truncate` labels and stays
    //    at the floor width (255) -- see `MainLayout.sidebarAutogrow.test.js` for the reactive
    //    measurement itself, out of scope here.
    expect(currentWidthVar(wrapper)).toBe('255px')
  })

  it('mirrors the mini-rail width once the sidebar is forced to its mini rail', async () => {
    useMinWidth(1200).value = true

    const { wrapper, pageStore } = await mountLayout('/some/wiki/page')
    pageStore.navigationMode = 'hide'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.sidebar-mini').exists()).toBe(true)
    expect(currentWidthVar(wrapper)).toBe('56px')
  })

  it('is 0px when the site has no sidebar at all, even on a wide viewport', async () => {
    useMinWidth(1200).value = true

    const { wrapper, siteStore } = await mountLayout('/')
    siteStore.showSideNav = false
    await wrapper.vm.$nextTick()

    // -> Nothing to make room for: a page/site with no sidebar must not inset the footer bar as
    //    though one were still occupying the grid column.
    expect(currentWidthVar(wrapper)).toBe('0px')
  })

  it('is 0px on a narrow viewport before the overlaying sidebar is opened', async () => {
    useMinWidth(1200).value = false

    const { wrapper } = await mountLayout('/')

    expect(currentWidthVar(wrapper)).toBe('0px')
  })

  it('mirrors the sidebar width once the narrow-viewport overlay is opened', async () => {
    useMinWidth(1200).value = false

    const { wrapper } = await mountLayout('/')

    headerNav(wrapper).vm.$emit('openSidebar')
    await wrapper.vm.$nextTick()

    // -> Unconditional on viewport width by design: `Index.vue`'s own media query is what decides
    //    whether the footer actually reads this value below the sidebar's 1200px breakpoint, not
    //    this computed -- see that file's `.w-footer` rule.
    expect(currentWidthVar(wrapper)).toBe('255px')
  })
})
