import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import NavSidebar from './NavSidebar.vue'
import { useSiteStore } from '@/stores/site'

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 721. Mounting at all is
 * itself a meaningful check: this component's `<style lang="scss">` was rewritten from physical
 * `left`/`right`/`border-left` declarations to logical `inset-inline-*`/`border-inline-*` ones (the
 * edge-notch triangle and the open-group rail), and Vite's Sass pipeline would fail the whole render
 * on a malformed declaration -- a compile error here, not a failed assertion, is what would catch a
 * typo in that rewrite.
 *
 * The actual mirroring under `dir="rtl"` cannot be asserted from here: happy-dom's CSS engine does
 * not resolve logical properties against `direction` the way a real layout engine does (verified
 * separately, against real Chromium, while making this change -- see the task's notes). What IS
 * asserted here is the one thing that stayed JS-driven rather than becoming pure CSS: `sidebarPosition`
 * (a SITE setting) and the reader's text direction are two independent axes, and `sidebarPosition`
 * alone must still be what decides whether `sidebar-nav--flipped` is applied -- switching locale must
 * not silently flip it too.
 */
async function mountSidebar(sidebarPosition) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.theme.sidebarPosition = sidebarPosition

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(NavSidebar, {
    global: {
      plugins: [router, i18n]
    }
  })
}

describe('NavSidebar', () => {
  it('applies sidebar-nav--flipped only when sidebarPosition is "right"', async () => {
    const defaultSidebar = await mountSidebar('left')
    expect(defaultSidebar.classes()).not.toContain('sidebar-nav--flipped')

    const flippedSidebar = await mountSidebar('right')
    expect(flippedSidebar.classes()).toContain('sidebar-nav--flipped')
  })

  /**
   * A static check on the source rather than a rendered assertion, for the reason the file header
   * above gives: happy-dom cannot resolve a logical property against `direction`, so the only way
   * left to catch a stray physical declaration sneaking back into this `<style>` block is to grep
   * for one. Specifically the open-group rail's own border: it sits right next to two pseudo-element
   * "elbows" that already read `inset-inline-start`, and a `border-left` here would point the
   * straight run of the rail at a different edge than its own turns once `dir="rtl"` moves them.
   *
   * Excludes the `<script>` block's `thumbStyle.right` (the scroll-thumb's position within its own
   * track, a native-scrollbar convention this custom control is matching -- not a text-direction
   * concern), which is why this greps the `<style>` block specifically rather than the whole file.
   */
  it('keeps the open-group rail on a logical (inline-start) border, not a physical one', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(dir, 'NavSidebar.vue'), 'utf-8')
    const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

    expect(styleBlock).not.toMatch(/border-left\s*:/)
    expect(styleBlock).not.toMatch(/border-right\s*:/)
    expect(styleBlock).toMatch(/border-inline-start\s*:\s*10px/)
  })
})
