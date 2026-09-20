import { afterEach, describe, expect, it } from 'vitest'

import MainLayout from './MainLayout.vue'
import { useMinWidth } from '@/composables/screen'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Pure reactive-value coverage; `MainLayout.footerClearance.test.js` is the real-browser geometry
 * proof that the CSS consuming these properties behaves.
 *
 * `useMinWidth` is driven directly on the ref rather than through a `matchMedia` mock: the
 * composable caches one ref per breakpoint at module level, so a fresh mock cannot reach a
 * breakpoint another test in the same run already set.
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

function insetStartVar(wrapper) {
  return wrapper.element.style.getPropertyValue('--sidebar-inset-inline-start')
}

function insetEndVar(wrapper) {
  return wrapper.element.style.getPropertyValue('--sidebar-inset-inline-end')
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
    //    at the floor width.
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

    // -> A site with no sidebar must not inset the footer bar as though a column were occupied.
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

    // -> Unconditional on viewport width by design: `Index.vue`'s own media query, not this
    //    computed, is what decides whether the footer reads the value below the breakpoint.
    expect(currentWidthVar(wrapper)).toBe('255px')
  })
})

/**
 * The width is split across two directional properties so `Index.vue`'s footer rule can inset from
 * whichever edge the sidebar renders on without itself branching on `sidebarPosition`.
 */
describe('MainLayout --sidebar-inset-inline-* (OpenProject #3142)', () => {
  afterEach(() => {
    useMinWidth(1200).value = true
    useMinWidth(600).value = true
  })

  it('puts the width on the START property for the default left-positioned sidebar', async () => {
    useMinWidth(1200).value = true

    const { wrapper } = await mountLayout('/')

    expect(insetStartVar(wrapper)).toBe('255px')
    expect(insetEndVar(wrapper)).toBe('0px')
  })

  it('puts the width on the END property when sidebarPosition is "right"', async () => {
    useMinWidth(1200).value = true

    const { wrapper, siteStore } = await mountLayout('/')
    siteStore.theme.sidebarPosition = 'right'
    await wrapper.vm.$nextTick()

    expect(insetEndVar(wrapper)).toBe('255px')
    expect(insetStartVar(wrapper)).toBe('0px')
  })

  it('is 0px on both properties when the site has no sidebar at all, even with sidebarPosition "right"', async () => {
    useMinWidth(1200).value = true

    const { wrapper, siteStore } = await mountLayout('/')
    siteStore.theme.sidebarPosition = 'right'
    siteStore.showSideNav = false
    await wrapper.vm.$nextTick()

    expect(insetStartVar(wrapper)).toBe('0px')
    expect(insetEndVar(wrapper)).toBe('0px')
  })
})
