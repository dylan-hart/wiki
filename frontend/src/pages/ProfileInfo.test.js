import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileInfo from './ProfileInfo.vue'
import ProfileOverlay from '@/components/ProfileOverlay.vue'
import { mountWithApp } from '../../test/mount.js'
import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #2074: `ProfileInfo.vue`'s "Save Changes" button used to draw a different check from the
 * one every `Admin*.vue` settings page draws for the identical "commit these settings" action
 * (`icon="tabler:check"` + `t('common.actions.apply')`). That action is settled on `tabler:check`, so
 * this page's Save button must not drift to a ringed variant -- `tabler:circle-check` is the one
 * sitting closest to it in the set.
 */
function mountPage() {
  // -> The Save button only renders once editing is allowed (`canEdit`, gated on this feature flag).

  return mountWithApp(ProfileInfo, {
    messages: {
      common: {
        actions: {
          saveChanges: 'Save Changes'
        }
      }
    },
    stores: {
      site: (store) => {
        store.features.profile = true
      }
    }
  }).wrapper
}

describe('ProfileInfo "Save Changes" icon (OpenProject #2074)', () => {
  it('uses the settled tabler:check save/commit glyph, not tabler:circle-check', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.find('[data-icon="tabler:check"]').exists()).toBe(true)
    expect(wrapper.find('[data-icon="tabler:circle-check"]').exists()).toBe(false)
  })
})

/**
 * OpenProject #2623: this screen compared against `ui-redesign/Cardinal Wiki - Profile 3x.dc.html`,
 * the one design file that draws it. Each claim below names the glyph or measurement the mockup
 * carries, so a later drift reads as a design regression rather than as an unexplained failure.
 *
 * Two disagreements found by that comparison are deliberately NOT pinned here, because fixing either
 * belongs to somebody else:
 *
 *   - `.w-section-header`'s own padding and `margin-block-end`. The Profile sheet draws the band at
 *     `9px 20px` with nothing under it; the primitives sheet draws the same band at `0 14px` over a
 *     38px box; the code draws `6px 16px` with a 12px trailing margin. Reconciling the three is
 *     #2631's whole subject, and the band has 11 callers. Only the CALLER-side gap is asserted below.
 *   - the segmented control's fill. The design fills the selected segment `#e4676b` under white
 *     text, which is 3.26:1 -- under the AA floor `helpers/accessibility.test.js` pins -- so
 *     `toggle-color="primary"` (`#c14a52`, 4.81:1 both ways) stands against the mockup on purpose.
 */
describe('ProfileInfo against Cardinal Wiki - Profile 3x.dc.html (OpenProject #2623)', () => {
  it('draws the glyphs the design draws, not the ones that were there before', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    // -> The design draws an ID card, a sun and an OPEN eye for these three rows
    for (const icon of ['tabler:id', 'tabler:sun', 'tabler:eye']) {
      expect(wrapper.find(`[data-icon="${icon}"]`).exists()).toBe(true)
    }
    for (const icon of ['tabler:address-book', 'tabler:bulb', 'tabler:eye-off']) {
      expect(wrapper.find(`[data-icon="${icon}"]`).exists()).toBe(false)
    }
  })

  it("gives every field the design's 34px frame rather than the dense 28px one", async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    const controls = wrapper.findAll('.w-input-control')
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) {
      expect(control.classes()).toContain('min-h-[34px]')
      expect(control.classes()).not.toContain('w-input-control--dense')
    }
  })

  it('sets the read-only email in the mono face the design gives it', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    // -> WInput puts `aria-label` on the <input> itself, and the test i18n resolves a missing key to
    //    the key, so this is the email row's own control
    const email = wrapper.find('input[aria-label="profile.email"]')
    expect(email.exists()).toBe(true)
    expect(email.attributes('readonly')).toBeDefined()
    expect(email.classes()).toContain('font-mono')
  })

  it('runs each section band flush against the row before it', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    /*
      The design stacks band, rows, band, rows with nothing between them: the strip IS the seam. A
      `mt-*` utility on a band -- or on the save bar -- is what put a 24px hole there instead.
    */
    const bands = wrapper.findAll('.w-section-header')
    expect(bands.length).toBe(3)
    for (const band of bands) {
      expect(band.classes().some((cls) => cls.startsWith('mt-'))).toBe(false)
    }
    expect(
      wrapper
        .find('.actions-bar')
        .classes()
        .some((cls) => cls.startsWith('mt-'))
    ).toBe(false)
  })

  it('leaves the content column its own padding to draw, and the separators unspaced', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    /*
      `py-4` on the page put 16px above the first band, which the design runs flush to the top of the
      column. `ProfileOverlay.vue`'s stylesheet is the single owner of the column's padding now, so
      that every section agrees rather than each restating it.
    */
    expect(wrapper.classes()).toContain('w-page')
    expect(wrapper.classes().some((cls) => cls.startsWith('py-') || cls.startsWith('pt-'))).toBe(
      false
    )

    /*
      WSeparator's `spaced` prop is emitted as an inline `margin-block`. The design's rule between two
      rows carries no vertical space at all -- the 14px of row padding on each side is the gap.
    */
    const separators = wrapper.findAll('.w-separator')
    expect(separators.length).toBeGreaterThan(0)
    for (const separator of separators) {
      expect(separator.attributes('style') ?? '').not.toContain('margin-block')
    }
  })
})

/**
 * The claims above that are MEASUREMENTS rather than class names, checked where a measurement can
 * actually be taken. jsdom runs no layout engine -- `min-h-[34px]` being on an element proves the
 * class is there, not that a 34px field is what renders, and a padding declared in
 * `ProfileOverlay.vue`'s stylesheet is not visible from the markup at all. This reassembles the real
 * thing in a real browser: the app's own compiled Tailwind, plus the SFC styles Vitest injected into
 * this document while mounting, around the markup an actual mount produced.
 *
 * The container carries `.layout-profile-body` because that is what the rhythm rules are scoped to --
 * `ProfileOverlay.vue` is the card these sections render inside, and its stylesheet is the single
 * owner of the content column's padding.
 *
 * `{ skip: !hasChromium() }` for the same reason the two API-key dialog suites take it: `npm ci`
 * installs the Playwright library, not the browser binary.
 */
describe(
  'ProfileInfo settings-row rhythm, real layout (OpenProject #2623)',
  { skip: !hasChromium() },
  () => {
    let browser
    let metrics

    beforeAll(async () => {
      browser = await chromium.launch()

      globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

      /*
        Mounted for its stylesheet as much as for its markup: Vitest's `css: true` compiles an SFC's
        `<style lang="scss">` and injects it into this document's head, so mounting the card is what
        puts `.layout-profile-body`'s rules within reach of the harvest below.
      */
      const overlay = mountWithApp(ProfileOverlay, {}).wrapper
      const wrapper = mountPage()
      await flushPromises()

      const appCss = await buildAppCss()
      const sfcCss = [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${sfcCss}</style></head>` +
            `<body class="body--light"><div class="layout-profile-body" style="width:720px">` +
            `${wrapper.html()}</div></body></html>`
        )
        metrics = await page.evaluate(() => {
          const px = (value) => Number.parseFloat(value)
          const row = document.querySelector('.w-page > .w-item')
          const rowStyle = getComputedStyle(row)
          const plate = row.querySelector('.blueprint-icon')
          const label = row.querySelector('.w-item-section--main')
          const separator = document.querySelector('.w-page > .w-separator')
          const separatorStyle = getComputedStyle(separator)
          return {
            rowPaddingBlock: [px(rowStyle.paddingTop), px(rowStyle.paddingBottom)],
            rowPaddingInline: [px(rowStyle.paddingLeft), px(rowStyle.paddingRight)],
            edgeToPlate: plate.getBoundingClientRect().left - row.getBoundingClientRect().left,
            plateToLabel: label.getBoundingClientRect().left - plate.getBoundingClientRect().right,
            separatorMarginInline: [px(separatorStyle.marginLeft), px(separatorStyle.marginRight)],
            separatorMarginBlock: [px(separatorStyle.marginTop), px(separatorStyle.marginBottom)],
            fieldHeights: [...document.querySelectorAll('.w-input-control')].map(
              (el) => el.getBoundingClientRect().height
            )
          }
        })
      } finally {
        await page.close()
      }

      overlay.unmount()
    }, 180000)

    afterAll(async () => {
      await browser?.close()
    })

    it("pads a row to the design's 14px / 20px", () => {
      expect(metrics.rowPaddingBlock).toEqual([14, 14])
      expect(metrics.rowPaddingInline).toEqual([20, 20])
    })

    it('sets the icon plate 20px in from the row edge and 14px off its label', () => {
      expect(metrics.edgeToPlate).toBeCloseTo(20, 0)
      expect(metrics.plateToLabel).toBeCloseTo(14, 0)
    })

    it('insets the rule between two rows by 20px, with no vertical space of its own', () => {
      expect(metrics.separatorMarginInline).toEqual([20, 20])
      expect(metrics.separatorMarginBlock).toEqual([0, 0])
    })

    it("renders a field at the design's 34px, not the dense 28px", () => {
      expect(metrics.fieldHeights.length).toBeGreaterThan(0)
      for (const height of metrics.fieldHeights) {
        expect(height).toBeGreaterThanOrEqual(34)
      }
    })
  }
)
