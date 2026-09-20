import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import AdminTheme from './AdminTheme.vue'
import { contrastRatio, getAccessibleColor } from '@/helpers/accessibility'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

async function mountPage(theme, cvd = 'none') {
  stubApi({ 'sites/site-a?strict=true': { id: 'site-a', theme } })

  const router = await createTestRouter(['/'])

  // -> Only the one key a test reads the computed ratio back out of is translated; every other
  //    `t()` resolves to its key literal.

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
    The chrome draws its text in ink, not white (`CHROME_TEXT_COLOR`), so the header/sidebar warning
    fires on a colour too DARK to read over rather than one too light.
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

    const warningIcons = wrapper.findAll('[data-icon="tabler:alert-triangle"]')
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

    const warningIcons = wrapper.findAll('[data-icon="tabler:alert-triangle"]')
    expect(warningIcons.length).toBeGreaterThan(0)
  })
})

describe('AdminTheme — WCAG AA contrast warning checks secondary and accent (task 1678)', () => {
  it('raises the warning for both secondary and accent, paired against white the same way WBtn renders solid buttons', async () => {
    // -> Both fixtures are the shape of value this check exists to catch: a mid-tone that reads fine
    // on its own but fails against the white text a solid button draws over it.
    const wrapper = await mountPage({
      colorPrimary: '#c14a52',
      colorSecondary: '#02c39a',
      colorAccent: '#FF9800',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7'
    })

    // -> Only secondary and accent fail here -- primary/header/sidebar are all the passing defaults.
    const warningIcons = wrapper.findAll('[data-icon="tabler:alert-triangle"]')
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

describe('AdminTheme — resetColors() is aesthetic-aware (OpenProject #2768)', () => {
  it("resets to Ledger's defaults when the loaded theme has no aesthetic (today's/pre-#2769 shape)", async () => {
    const wrapper = await mountPage({
      colorPrimary: '#123456',
      colorSecondary: '#654321',
      colorAccent: '#abcdef',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    // -> Index 0: the Appearance card's own "Reset defaults" button -- Code Blocks and Fonts each
    // render their own sibling with the same label further down the page.
    await wrapper.findAll('.acrylic-btn')[0].trigger('click')

    expect(wrapper.vm.state.config.colorPrimary).toBe('#c14a52')
    expect(wrapper.vm.state.config.colorAccent).toBe('#c14a52')
    expect(wrapper.vm.state.config.colorHeader).toBe('#ffffff')
    expect(wrapper.vm.state.config.colorSidebar).toBe('#f0f2f7')
    // -> Unaffected by the aesthetic -- reset to their own single default either way.
    expect(wrapper.vm.state.config.colorSecondary).toBe('#3f7a66')
    expect(wrapper.vm.state.config.dark).toBe(false)
  })

  it("resets to Cobalt's own defaults when the loaded theme is on the cobalt aesthetic", async () => {
    const wrapper = await mountPage({
      aesthetic: 'cobalt',
      colorPrimary: '#123456',
      colorSecondary: '#654321',
      colorAccent: '#abcdef',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    await wrapper.findAll('.acrylic-btn')[0].trigger('click')

    expect(wrapper.vm.state.config.colorPrimary).toBe('#1f4fd6')
    expect(wrapper.vm.state.config.colorAccent).toBe('#c8303c')
    expect(wrapper.vm.state.config.colorHeader).toBe('#1f4fd6')
    expect(wrapper.vm.state.config.colorSidebar).toBe('#10194a')
    expect(wrapper.vm.state.config.colorSecondary).toBe('#3f7a66')
  })

  // -> Starts `dark: true` on purpose: a fixture starting `false` cannot tell "preserved" apart from
  // "forced off", so a `resetColors()` that clears dark mode would still pass.
  it('leaves dark mode untouched by Reset Defaults', async () => {
    const wrapper = await mountPage({
      dark: true,
      colorPrimary: '#123456',
      colorSecondary: '#654321',
      colorAccent: '#abcdef',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    await wrapper.findAll('.acrylic-btn')[0].trigger('click')

    expect(wrapper.vm.state.config.dark).toBe(true)
  })

  it('leaves dark mode untouched by switching aesthetic', async () => {
    const wrapper = await mountPage({
      dark: true,
      aesthetic: 'ledger',
      colorPrimary: '#123456',
      colorSecondary: '#654321',
      colorAccent: '#abcdef',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    await wrapper.vm.onAestheticChange('cobalt')

    expect(wrapper.vm.state.config.dark).toBe(true)
  })
})

describe('AdminTheme — Aesthetic setting row (OpenProject #2769)', () => {
  it('renders Aesthetic as the first row of the Appearance card, above Dark mode', async () => {
    const wrapper = await mountPage({
      colorPrimary: '#c14a52',
      colorSecondary: '#3f7a66',
      colorAccent: '#c14a52',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7'
    })

    const rows = wrapper.findAll('.admin-theme .w-settings-card')[0].findAll('.w-settings-row')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0].find('[data-icon="tabler:layout-grid"]').exists()).toBe(true)
    expect(rows[1].find('[data-icon="tabler:bulb"]').exists()).toBe(true)
  })

  it('defaults to the ledger aesthetic when the loaded theme carries none', async () => {
    const wrapper = await mountPage({
      colorPrimary: '#c14a52',
      colorSecondary: '#3f7a66',
      colorAccent: '#c14a52',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7'
    })

    expect(wrapper.vm.state.config.aesthetic).toBe('ledger')
  })

  it('does not reset the colors merely from loading a Cobalt theme', async () => {
    const wrapper = await mountPage({
      aesthetic: 'cobalt',
      colorPrimary: '#123456',
      colorSecondary: '#654321',
      colorAccent: '#abcdef',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    expect(wrapper.vm.state.config.aesthetic).toBe('cobalt')
    expect(wrapper.vm.state.config.colorPrimary).toBe('#123456')
    expect(wrapper.vm.state.config.colorAccent).toBe('#abcdef')
    expect(wrapper.vm.state.config.colorHeader).toBe('#000000')
    expect(wrapper.vm.state.config.colorSidebar).toBe('#1976D2')
  })

  it('switching to Cobalt resets the color pickers to Cobalt defaults before save', async () => {
    const wrapper = await mountPage({
      aesthetic: 'ledger',
      colorPrimary: '#123456',
      colorSecondary: '#654321',
      colorAccent: '#abcdef',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    await wrapper.vm.onAestheticChange('cobalt')

    expect(wrapper.vm.state.config.aesthetic).toBe('cobalt')
    expect(wrapper.vm.state.config.colorPrimary).toBe('#1f4fd6')
    expect(wrapper.vm.state.config.colorAccent).toBe('#c8303c')
    expect(wrapper.vm.state.config.colorHeader).toBe('#1f4fd6')
    expect(wrapper.vm.state.config.colorSidebar).toBe('#10194a')
  })

  it('switching back to Ledger resets the color pickers to Ledger defaults before save', async () => {
    const wrapper = await mountPage({
      aesthetic: 'cobalt',
      colorPrimary: '#123456',
      colorSecondary: '#654321',
      colorAccent: '#abcdef',
      colorHeader: '#000000',
      colorSidebar: '#1976D2'
    })

    await wrapper.vm.onAestheticChange('ledger')

    expect(wrapper.vm.state.config.aesthetic).toBe('ledger')
    expect(wrapper.vm.state.config.colorPrimary).toBe('#c14a52')
    expect(wrapper.vm.state.config.colorAccent).toBe('#c14a52')
    expect(wrapper.vm.state.config.colorHeader).toBe('#ffffff')
    expect(wrapper.vm.state.config.colorSidebar).toBe('#f0f2f7')
  })

  it('includes aesthetic in the save payload', async () => {
    const wrapper = await mountPage({
      aesthetic: 'cobalt',
      colorPrimary: '#1f4fd6',
      colorSecondary: '#3f7a66',
      colorAccent: '#c8303c',
      colorHeader: '#1f4fd6',
      colorSidebar: '#10194a'
    })

    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
    const [, options] = API_CLIENT.put.mock.calls[0]
    expect(options.json.theme.aesthetic).toBe('cobalt')
  })
})

describe('AdminTheme — Appearance card color rows match the mockup icon (OpenProject #2809)', () => {
  it('gives every color row the palette icon, not the color-swatch icon', async () => {
    const wrapper = await mountPage({
      colorPrimary: '#c14a52',
      colorSecondary: '#3f7a66',
      colorAccent: '#c14a52',
      colorHeader: '#ffffff',
      colorSidebar: '#f0f2f7'
    })

    const rows = wrapper.findAll('.admin-theme .w-settings-card')[0].findAll('.w-settings-row')
    // -> Aesthetic and Dark mode are the first two rows; every row after them is a color row.
    const colorRows = rows.slice(2)
    expect(colorRows.length).toBe(5)
    for (const row of colorRows) {
      expect(row.find('[data-icon="tabler:palette"]').exists()).toBe(true)
      expect(row.find('[data-icon="tabler:color-swatch"]').exists()).toBe(false)
    }
  })
})
