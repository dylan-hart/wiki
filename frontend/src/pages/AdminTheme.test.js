import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import AdminTheme from './AdminTheme.vue'
import { useAdminStore } from '@/stores/admin'
import { useUserStore } from '@/stores/user'
import { contrastRatio, getAccessibleColor } from '@/helpers/accessibility'

/**
 * Task 754: `getAccessibleColor` now has real substitutes for every themeable color name, and this
 * page is where they should actually show up -- a live preview swatch per color under the admin's
 * own `userStore.cvd` setting, plus a WCAG AA contrast warning for the pairings that matter
 * (`colorHeader`/`colorSidebar` against the white chrome text, `colorPrimary` against the page
 * background, and -- since task 1678 -- `colorSecondary`/`colorAccent` against that same white
 * chrome text, matching the fg/bg pairing `WBtn.vue` uses for every solid button in the app).
 */
async function mountPage(theme, cvd = 'none') {
  setActivePinia(createPinia())
  const adminStore = useAdminStore()
  adminStore.currentSiteId = 'site-a'
  const userStore = useUserStore()
  userStore.cvd = cvd

  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'sites/site-a?strict=true') {
      return { json: () => Promise.resolve({ id: 'site-a', theme }) }
    }
    return { json: () => Promise.resolve(undefined) }
  })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    // -> Real message for the one key a test needs to read back (the computed ratio); everything
    // else stays untranslated (`missingWarn`/`fallbackWarn` off), matching upstream `en.json`.
    messages: {
      en: {
        admin: {
          theme: {
            contrastWarning:
              'Contrast ratio is {ratio}, below the WCAG AA minimum of 4.5:1 for this color against the text drawn over it.'
          }
        }
      }
    },
    missingWarn: false,
    fallbackWarn: false
  })

  const wrapper = mount(AdminTheme, {
    global: {
      plugins: [router, i18n]
    }
  })
  await flushPromises()

  return wrapper
}

describe('AdminTheme — CVD preview swatches', () => {
  it("previews every color swatch under the admin's own CVD setting, not the base color", async () => {
    const wrapper = await mountPage(
      {
        colorPrimary: '#123456',
        colorSecondary: '#654321',
        colorAccent: '#abcdef',
        colorHeader: '#000000',
        colorSidebar: '#1976D2'
      },
      'protanopia'
    )

    const swatches = wrapper.findAll('.cvd-preview-swatch')
    expect(swatches.length).toBe(5)

    const expectedAccent = getAccessibleColor('accent', '#abcdef', 'protanopia')
    const accentSwatch = swatches.find((s) => s.attributes('style')?.includes(expectedAccent))
    expect(accentSwatch).toBeTruthy()
  })

  it('matches the base color when the admin has no CVD setting active', async () => {
    const wrapper = await mountPage({
      colorPrimary: '#123456',
      colorSecondary: '#02C39A',
      colorAccent: '#FF9800',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    const swatches = wrapper.findAll('.cvd-preview-swatch')
    expect(swatches[0].attributes('style')).toContain('#123456')
  })
})

describe('AdminTheme — WCAG AA contrast warning', () => {
  it('warns when colorHeader is too light for the white header text', async () => {
    const wrapper = await mountPage({
      colorPrimary: '#1976D2',
      colorSecondary: '#02C39A',
      colorAccent: '#FF9800',
      colorHeader: '#fff9c4',
      colorSidebar: '#1976D2'
    })

    expect(wrapper.findAll('.text-negative, [color="negative"]').length).toBeGreaterThan(0)
  })

  it('does not warn when every color has plenty of contrast against the text drawn over it', async () => {
    const wrapper = await mountPage({
      colorPrimary: '#1976D2',
      // -> Dark enough to clear WCAG AA against the white chrome text -- unlike the app's own
      // `resetColors()` defaults (`#02C39A` / `#FF9800`), which is exactly the pair task 1678 is
      // about: see the "checks secondary and accent" describe block below.
      colorSecondary: '#00695C',
      colorAccent: '#8a4b00',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    const warningIcons = wrapper.findAll('[data-icon="la:exclamation-triangle"]')
    expect(warningIcons.length).toBe(0)
  })

  it('warns on colorPrimary when it is too close to the (light) page background', async () => {
    const wrapper = await mountPage({
      colorPrimary: '#fefefe',
      colorSecondary: '#00695C',
      colorAccent: '#8a4b00',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    const warningIcons = wrapper.findAll('[data-icon="la:exclamation-triangle"]')
    expect(warningIcons.length).toBeGreaterThan(0)
  })
})

describe('AdminTheme — WCAG AA contrast warning checks secondary and accent (task 1678)', () => {
  it('raises the warning for both secondary and accent, paired against white the same way WBtn renders solid buttons', async () => {
    // -> `resetColors()`'s own defaults: previously exempt from the check entirely (`contrastPairFor`
    // returned null for these two), so the theme screen reported a clean bill of health for the
    // colors that actually fail worst.
    const wrapper = await mountPage({
      colorPrimary: '#1976D2',
      colorSecondary: '#02c39a',
      colorAccent: '#FF9800',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    // -> Only secondary and accent fail here -- primary/header/sidebar are all the passing defaults.
    const warningIcons = wrapper.findAll('[data-icon="la:exclamation-triangle"]')
    expect(warningIcons.length).toBe(2)

    const expectedSecondaryRatio = `${contrastRatio('#ffffff', '#02c39a').toFixed(1)}:1`
    const expectedAccentRatio = `${contrastRatio('#ffffff', '#FF9800').toFixed(1)}:1`
    expect(expectedSecondaryRatio).not.toBe(expectedAccentRatio)

    // -> Trigger each warning's tooltip (focusin bubbles to the shared `.w-item` trigger the
    // `WTooltip` climbs to) and read the computed ratio it renders back out of the teleported body.
    for (const [icon, expectedRatio] of [
      [warningIcons[0], expectedSecondaryRatio],
      [warningIcons[1], expectedAccentRatio]
    ]) {
      icon.element.closest('[tabindex="0"]').dispatchEvent(new Event('focusin', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 260))
      await flushPromises()
      expect(document.body.textContent).toContain(expectedRatio)
      icon.element.closest('[tabindex="0"]').dispatchEvent(new Event('focusout', { bubbles: true }))
    }
  })
})
