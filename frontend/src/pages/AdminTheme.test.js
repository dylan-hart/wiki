import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminTheme from './AdminTheme.vue'
import { contrastRatio, getAccessibleColor } from '@/helpers/accessibility'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

/**
 * Task 754: `getAccessibleColor` now has real substitutes for every themeable color name, and this
 * page is where they should actually show up -- a live preview swatch per color under the admin's
 * own `userStore.cvd` setting, plus a WCAG AA contrast warning for the pairings that matter
 * (`colorHeader`/`colorSidebar` against the white chrome text, `colorPrimary` against the page
 * background, and -- since task 1678 -- `colorSecondary`/`colorAccent` against that same white
 * chrome text, matching the fg/bg pairing `WBtn.vue` uses for every solid button in the app).
 */
async function mountPage(theme, cvd = 'none') {
  stubApi({ 'sites/site-a?strict=true': { id: 'site-a', theme } })

  const router = await createTestRouter(['/'])

  // -> Real message for the one key a test needs to read back (the computed ratio); everything else
  //    stays untranslated (`createTestI18n` keeps `missingWarn`/`fallbackWarn` off), matching
  //    upstream `en.json`.

  const { wrapper } = mountWithApp(AdminTheme, {
    messages: {
      admin: {
        theme: {
          contrastWarning:
            'Contrast ratio is {ratio}, below the WCAG AA minimum of 4.5:1 for this color against the text drawn over it.'
        }
      }
    },
    router,
    stores: { admin: { currentSiteId: 'site-a' }, user: { cvd } },
    // -> Opts out of `mountWithApp`'s default `teleport: true` stub: the contrast-warning test below
    //    reads the tooltip back out of `document.body`, where `WTooltip` really teleports it.
    stubs: {}
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
  /*
    The chrome's foreground is Cardinal's ink now, not white (`CHROME_TEXT_COLOR`), so this check has
    turned around: what it warns about is a header or sidebar too DARK to read ink over, where it
    used to be one too light to read white over. Same rule, opposite end of the ramp.
  */
  it('warns when colorHeader is too dark for the ink header text', async () => {
    const wrapper = await mountPage({
      colorPrimary: '#c14a52',
      colorSecondary: '#3f7a66',
      colorAccent: '#c14a52',
      colorHeader: '#1c2233',
      colorSidebar: '#f0f2f7'
    })

    expect(wrapper.findAll('.text-negative, [color="negative"]').length).toBeGreaterThan(0)
  })

  it('does not warn when every color has plenty of contrast against the text drawn over it', async () => {
    // -> The app's own `resetColors()` defaults, which is the point: a fresh install and a reset
    //    theme both have to come out clean, not merely close.
    const wrapper = await mountPage({
      colorPrimary: '#c14a52',
      colorSecondary: '#3f7a66',
      colorAccent: '#c14a52',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7'
    })

    const warningIcons = wrapper.findAll('[data-icon="la:exclamation-triangle"]')
    expect(warningIcons.length).toBe(0)
  })

  it('warns on colorPrimary when it is too close to the (light) page background', async () => {
    const wrapper = await mountPage({
      colorPrimary: '#fefefe',
      colorSecondary: '#3f7a66',
      colorAccent: '#c14a52',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7'
    })

    const warningIcons = wrapper.findAll('[data-icon="la:exclamation-triangle"]')
    expect(warningIcons.length).toBeGreaterThan(0)
  })
})

describe('AdminTheme — WCAG AA contrast warning checks secondary and accent (task 1678)', () => {
  it('raises the warning for both secondary and accent, paired against white the same way WBtn renders solid buttons', async () => {
    // -> The 3.x defaults these two used to carry (#02c39a / #FF9800), which were previously exempt
    // from the check entirely (`contrastPairFor` returned null for both) -- so the theme screen
    // reported a clean bill of health for the colors that actually failed worst. Kept as the
    // fixture even though neither is a default any more: they are still exactly the shape of value
    // this check exists to catch.
    const wrapper = await mountPage({
      colorPrimary: '#c14a52',
      colorSecondary: '#02c39a',
      colorAccent: '#FF9800',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7'
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
