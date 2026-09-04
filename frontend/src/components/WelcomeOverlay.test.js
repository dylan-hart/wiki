import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import WelcomeOverlay from './WelcomeOverlay.vue'
import { useFlagsStore } from '@/stores/flags'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/**
 * Regression coverage for task 799: with exactly one editor enabled, "Create the Homepage" used to
 * still require opening a one-item menu and clicking its only entry. It should instead call
 * `pageStore.pageCreate` directly, skipping the menu.
 */
async function mountOverlay({ editors = {}, experimental = false } = {}) {
  setActivePinia(createPinia())

  const siteStore = useSiteStore()
  siteStore.editors = { asciidoc: false, markdown: false, wysiwyg: false, ...editors }
  siteStore.locales = { primary: 'en' }

  const flagsStore = useFlagsStore()
  flagsStore.experimental = experimental

  const pageStore = usePageStore()
  pageStore.pageCreate = vi.fn().mockResolvedValue()

  const userStore = useUserStore()
  userStore.permissions = []

  const router = await createTestRouter(['/:pathMatch(.*)*'])

  const i18n = createTestI18n()

  const wrapper = mount(WelcomeOverlay, {
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  return { wrapper, pageStore }
}

describe('WelcomeOverlay: create homepage button', () => {
  it('calls pageCreate directly, skipping the menu, when exactly one editor is enabled', async () => {
    const { wrapper, pageStore } = await mountOverlay({ editors: { markdown: true } })

    // -> No menu should even be in the DOM when there is nothing to pick between
    expect(wrapper.findComponent({ name: 'WMenu' }).exists()).toBe(false)

    await wrapper.find('button.w-btn').trigger('click')
    await flushPromises()

    expect(pageStore.pageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ editor: 'markdown' })
    )

    wrapper.unmount()
  })

  it('keeps the menu, not calling pageCreate on the button click alone, when several editors are enabled', async () => {
    const { wrapper, pageStore } = await mountOverlay({
      editors: { markdown: true, wysiwyg: true },
      experimental: true
    })

    expect(wrapper.findComponent({ name: 'WMenu' }).exists()).toBe(true)

    await wrapper.find('button.w-btn').trigger('click')
    await flushPromises()

    expect(pageStore.pageCreate).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('leaves the menu present (no editor to create with) when no editor is enabled at all', async () => {
    const { wrapper, pageStore } = await mountOverlay()

    expect(wrapper.findComponent({ name: 'WMenu' }).exists()).toBe(true)

    await wrapper.find('button.w-btn').trigger('click')
    await flushPromises()

    expect(pageStore.pageCreate).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})

/**
 * OpenProject #2499: `.welcome` was hardcoded to a light theme (white radial-gradient background,
 * `#eee` border, `$grey-9` text) with no `body--dark` branch at all, so the overlay rendered as a
 * bright, jarring full-screen light panel even in dark mode. Fixed by adding a
 * `@at-root .body--dark &` branch, the same additive pattern `Login.vue`'s structurally similar
 * full-screen `.auth` screen already uses.
 *
 * Asserted against the source text rather than a computed style: jsdom's CSS engine does not
 * reliably resolve a compound `@at-root .body--dark &` selector the way a real browser would, so a
 * `getComputedStyle` assertion here would not actually prove the rule is wired up (see
 * `PageToc.test.js` for the same source-based-assertion precedent on a different SCSS fix).
 */
describe('WelcomeOverlay: dark mode', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'WelcomeOverlay.vue'),
    'utf-8'
  )

  it('gives .welcome a body--dark override for background, border and text color', () => {
    const welcomeRule = source.match(/\.welcome\s*\{[\s\S]*?\n\}\n/)[0]

    expect(welcomeRule).toMatch(/@at-root\s+\.body--dark\s+&\s*\{/)
    expect(welcomeRule).toMatch(/@at-root\s+\.body--dark\s+&\s*\{[^}]*background:[^}]*\$dark-6/)
    expect(welcomeRule).toMatch(/@at-root\s+\.body--dark\s+&\s*\{[^}]*color:\s*\$blue-grey-1/)
    expect(welcomeRule).toMatch(/@at-root\s+\.body--dark\s+&\s*\{[^}]*border:[^}]*\$dark-4/)
  })

  it('still keeps the light-mode background/border/color as the default (unguarded) values', () => {
    expect(source).toMatch(/background: #fff radial-gradient\(ellipse, #fff, #ddd\);/)
    expect(source).toMatch(/color: \$grey-9;/)
    expect(source).toMatch(/border: 1px solid #eee;/)
  })

  it('gives the decorative .welcome-bg glow a dark override too, so no white halo remains', () => {
    const bgRule = source.match(/&-bg\s*\{[\s\S]*?\n {2}\}\n/)[0]

    expect(bgRule).toMatch(/@at-root\s+\.body--dark\s+&\s*\{[^}]*\$dark-6/)
  })
})
