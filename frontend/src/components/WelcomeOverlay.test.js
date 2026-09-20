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

async function mountOverlay({ editors = {}, experimental = false, overlayOpts } = {}) {
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
    props: overlayOpts ? { overlayOpts } : {},
    attachTo: document.body,
    global: { plugins: [router, i18n] }
  })

  return { wrapper, pageStore }
}

describe('WelcomeOverlay overlayOpts prop (OpenProject #2530)', () => {
  it('declares overlayOpts as a prop, so it does not fall through onto the rendered DOM root', async () => {
    const { wrapper } = await mountOverlay({ overlayOpts: { unused: true } })

    expect(wrapper.attributes('overlay-opts')).toBeUndefined()

    wrapper.unmount()
  })
})

describe('WelcomeOverlay: create homepage button', () => {
  it('calls pageCreate directly, skipping the menu, when exactly one editor is enabled', async () => {
    const { wrapper, pageStore } = await mountOverlay({ editors: { markdown: true } })

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
 * Asserted against the source text rather than a computed style: the DOM stand-in's CSS engine does
 * not reliably resolve a compound `.body--dark .welcome` selector the way a real browser would, so a
 * `getComputedStyle` assertion would not actually prove the rule is wired up.
 */
describe('WelcomeOverlay: dark mode', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'WelcomeOverlay.vue'),
    'utf-8'
  )

  it('gives .welcome a body--dark override for background, border and text color', () => {
    const darkRule = source.match(/\.body--dark \.welcome\s*\{[\s\S]*?\n\}\n/)[0]

    expect(darkRule).toMatch(/background:[^}]*var\(--color-dark-6\)/)
    expect(darkRule).toMatch(/color:\s*var\(--color-blue-grey-1\)/)
    expect(darkRule).toMatch(/border:[^}]*var\(--color-dark-4\)/)
  })

  it('still keeps the light-mode background/border/color as the default (unguarded) values', () => {
    expect(source).toMatch(/background: #fff radial-gradient\(ellipse, #fff, #ddd\);/)
    expect(source).toMatch(/color: var\(--color-grey-9\);/)
    expect(source).toMatch(/border: 1px solid #eee;/)
  })

  it('gives the decorative .welcome-bg glow a dark override too, so no white halo remains', () => {
    const bgDarkRule = source.match(/\.body--dark \.welcome-bg\s*\{[\s\S]*?\n\}\n/)[0]

    expect(bgDarkRule).toMatch(/var\(--color-dark-6\)/)
  })
})
