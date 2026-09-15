import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

import ProfileInfo from './ProfileInfo.vue'
import ProfileOverlay from '@/components/ProfileOverlay.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { mountWithApp } from '../../test/mount.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

function mountPage() {
  // -> Editing is only allowed once `canEdit` (gated on this feature flag) is true; every field is
  //    readonly otherwise.

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

/**
 * OpenProject #2623: this screen compared against `ui-redesign/Cardinal Wiki - Profile 3x.dc.html`,
 * the one design file that draws it. Each claim below names the glyph or measurement the mockup
 * carries, so a later drift reads as a design regression rather than as an unexplained failure.
 *
 * One disagreement found by that comparison is deliberately NOT pinned here, because fixing it
 * belongs to somebody else:
 *
 *   - `.w-section-header`'s own padding and `margin-block-end`. The Profile sheet draws the band at
 *     `9px 20px` with nothing under it; the primitives sheet draws the same band at `0 14px` over a
 *     38px box; the code draws `6px 16px` with a 12px trailing margin. Reconciling the three is
 *     #2631's whole subject, and the band has 11 callers. Only the CALLER-side gap is asserted below.
 *
 * The segmented control's fill was ALSO flagged here at the time (the design filled the selected
 * segment `#e4676b` under white text, 3.26:1 -- under the AA floor `helpers/accessibility.test.js`
 * pins -- so `toggle-color="primary"`, `#c14a52` at 4.81:1, stood against that pre-Cobalt mockup on
 * purpose). OpenProject #2810's Cobalt-mockup diff superseded that reasoning: the Cobalt mockup's own
 * chrome table (`ui-redesign-cobalt/HANDOFF.md`) names the selected-segment fill as the ACCENT role,
 * not primary, and Cobalt's `--color-accent` (`#c8303c`) clears 5.3:1 -- no AA conflict to route
 * around. `toggle-color` is now `"accent"` everywhere in this file; it renders identically under
 * Ledger, whose `colorAccent` default equals `colorPrimary` (`#c14a52`), so this comparison's own
 * assertions are unaffected. See `docs/cobalt-mockup-diff-signoff.md` row 10.
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
      `mt-*` utility on a band is what put a 24px hole there instead. There is no save bar any more
      (Task #3220) for one to sit on.
    */
    const bands = wrapper.findAll('.w-section-header')
    expect(bands.length).toBe(3)
    for (const band of bands) {
      expect(band.classes().some((cls) => cls.startsWith('mt-'))).toBe(false)
    }
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
 * OpenProject #2810: row 10 (Profile) of `docs/cobalt-mockup-diff-signoff.md` was never diffed
 * against `ui-redesign-cobalt/Cardinal Wiki - Profile 3x - Cobalt.dc.html`. That diff found the
 * Preferences card's four `w-btn-toggle`s (Time format, Aesthetic, Appearance, Colour vision) all
 * filling their selected segment from `--color-primary` where the mockup's selected-segment fill is
 * the ACCENT role (`ui-redesign-cobalt/HANDOFF.md`'s chrome table, "Accent fill carrying WHITE text
 * ... selected segment", `#c8303c`/5.3:1) -- invisible under Ledger only because its `colorPrimary`
 * and `colorAccent` defaults are identical (`#c14a52`).
 */
describe('ProfileInfo against Cardinal Wiki - Profile 3x - Cobalt.dc.html (OpenProject #2810)', () => {
  it('fills every settings-row toggle selection from the segment-selected role', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    const toggleLabels = [
      'profile.timeFormat',
      'profile.aesthetic',
      'profile.appearance',
      'profile.cvd'
    ]
    expect.assertions(toggleLabels.length * 2)
    for (const label of toggleLabels) {
      const toggle = wrapper.find(`[role="radiogroup"][aria-label="${label}"]`)
      expect(toggle.exists()).toBe(true)
      const selected = toggle.find('[aria-checked="true"]')
      /*
        `--color-segment-selected`, not `--color-accent` directly: the mockup's ask is "the accent
        under Cobalt", and the two aesthetics answer it differently -- Ledger fills a selected
        segment with the site's primary (what `WBtnToggle` has always drawn, and what its own
        Aesthetic Setting card shows), Cobalt with the accent. The token carries both, so no caller
        names a tone; `css/cobaltTokens.test.js` pins the two values.
      */
      expect(selected.attributes('style')).toContain(
        'background-color: var(--color-segment-selected)'
      )
    }
  })
})

/**
 * OpenProject #3060: Time Format, Aesthetic, Light/Dark Mode and Color Vision Deficiency each wrap
 * their `w-btn-toggle` in a flanking `w-item-section side`, which the shared `WItemSection.vue`
 * responsive stacking (OpenProject #2822/#2823) deliberately excludes -- only two ADJACENT MAIN
 * sections (`.w-item-section--main + .w-item-section--main`) collapse to field-over-value on a
 * narrow row, the same shape Pronouns/Job Title already use. Dropping `side` on these four rows'
 * value section is the whole fix; this asserts the resulting DOM shape rather than re-proving the
 * container-query mechanism itself, which `WItem.responsiveStacking.test.js` already covers in a
 * real browser.
 *
 * OpenProject #3088: Content Width (added later, by Feature #3051 / Task #3068) kept `side` and
 * was left right-aligned and non-stacking, unlike the four rows above -- it joins the same
 * assertion here now that it has been converted too.
 */
describe('ProfileInfo toggle-style fields collapse to field-over-value (OpenProject #3060)', () => {
  it('wraps Time Format/Aesthetic/Appearance/CVD/Content Width in a MAIN section, not a flanking `side` one', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })
    const wrapper = mountPage()
    await flushPromises()

    const toggleLabels = [
      'profile.timeFormat',
      'profile.aesthetic',
      'profile.appearance',
      'profile.cvd',
      'profile.contentWidth'
    ]
    expect.assertions(toggleLabels.length * 4)
    for (const label of toggleLabels) {
      const toggle = wrapper.find(`[role="radiogroup"][aria-label="${label}"]`)
      expect(toggle.exists()).toBe(true)

      const valueSection = toggle.element.closest('.w-item-section')
      expect(valueSection.classList.contains('w-item-section--side')).toBe(false)
      expect(valueSection.classList.contains('w-item-section--main')).toBe(true)

      // -> Immediately preceded by the label's own MAIN section -- the two-adjacent-MAIN-sections
      //    shape Pronouns/Job Title already have, which is what the container query keys off.
      const labelSection = valueSection.previousElementSibling
      expect(labelSection.classList.contains('w-item-section--main')).toBe(true)
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
 * `{ skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT }` for the same reason the two API-key dialog suites take it: `npm ci`
 * installs the Playwright library, not the browser binary.
 */
describe(
  'ProfileInfo settings-row rhythm, real layout (OpenProject #2623)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let metrics

    beforeAll(async () => {
      browser = await chromium.launch()

      globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

      /*
        Mounted for its stylesheet as much as for its markup: Vitest's `css: true` reads an SFC's
        `<style>` block and injects it into this document's head, so mounting the card is what
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

/**
 * Feature #2608, Task #2642: the profile authors first and last name as two fields, and shows the
 * derived display name rather than hiding it -- the WP's own reasoning being that an override
 * nobody can trigger is not an override. All three are sent on every save; the server
 * (`models/users.ts#updateUser`) is the one place that decides whether a submitted `name` counts as
 * authoring it, which is why nothing here tracks whether the field was typed into.
 */
function mountProfile(profile) {
  globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve(profile) })
  return mountWithApp(ProfileInfo, {
    messages: {
      common: { actions: { saveChanges: 'Save Changes' } },
      profile: {
        firstName: 'First Name',
        lastName: 'Last Name',
        displayName: 'Display Name'
      }
    },
    stores: {
      site: (store) => {
        store.features.profile = true
      }
    }
  }).wrapper
}

const FULL_PROFILE = {
  name: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  location: '',
  jobTitle: '',
  pronouns: '',
  timezone: 'UTC',
  dateFormat: '',
  timeFormat: '12h',
  appearance: 'site',
  cvd: 'none'
}

describe('ProfileInfo first/last/display name (Feature #2608)', () => {
  it('renders all three name fields, each labelled on the input itself', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    // -> These three carry `aria-label`, which `WInput` puts on the `<input>` -- never on an
    //    ancestor, so an `[aria-label] input` selector could not match them.
    expect(wrapper.find('input[aria-label="First Name"]').exists()).toBe(true)
    expect(wrapper.find('input[aria-label="Last Name"]').exists()).toBe(true)
    expect(wrapper.find('input[aria-label="Display Name"]').exists()).toBe(true)
  })

  it('fills the two halves and the display name from the loaded profile', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    expect(wrapper.find('input[aria-label="First Name"]').element.value).toBe('Jane')
    expect(wrapper.find('input[aria-label="Last Name"]').element.value).toBe('Doe')
    expect(wrapper.find('input[aria-label="Display Name"]').element.value).toBe('Jane Doe')
  })

  it('sends all three name fields on save', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    await wrapper.vm.save()
    await flushPromises()

    const [url, options] = globalThis.API_CLIENT.put.mock.calls.at(-1)
    expect(url).toBe('users/profile')
    expect(options.json).toMatchObject({
      name: 'Jane Doe',
      firstName: 'Jane',
      lastName: 'Doe'
    })
  })

  /*
    The half-edit case, and the reason `composables/displayName.js` exists at all. The server reads a
    submitted `name` that differs from what the halves derive to as a deliberate override and marks
    the account authored for good -- so a form that left a stale display name in the payload while
    the reader edited only their first name would silently, permanently freeze their display name.
    The field tracks instead, and the reader sees what the account is about to be called.
  */
  it('re-derives the display name as a half is edited, so the payload is never stale', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    await wrapper.find('input[aria-label="First Name"]').setValue('Janet')
    await flushPromises()

    expect(wrapper.find('input[aria-label="Display Name"]').element.value).toBe('Janet Doe')

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      name: 'Janet Doe',
      firstName: 'Janet',
      lastName: 'Doe'
    })
  })

  it('stops re-deriving once the display name is overridden, and sends the override', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    await wrapper.find('input[aria-label="Display Name"]').setValue('Countess Lovelace')
    await wrapper.find('input[aria-label="First Name"]').setValue('Janet')
    await flushPromises()

    expect(wrapper.find('input[aria-label="Display Name"]').element.value).toBe('Countess Lovelace')

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      name: 'Countess Lovelace',
      firstName: 'Janet'
    })
  })

  it('resumes deriving when the override is typed back to the derived value', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    await wrapper.find('input[aria-label="Display Name"]').setValue('Countess Lovelace')
    // -> Typing the derived value back in is the server's own "put this back on derivation" write,
    //    so the form must treat it the same way rather than inventing a second rule.
    await wrapper.find('input[aria-label="Display Name"]').setValue('Jane Doe')
    await wrapper.find('input[aria-label="First Name"]').setValue('Janet')
    await flushPromises()

    expect(wrapper.find('input[aria-label="Display Name"]').element.value).toBe('Janet Doe')
  })

  it('loads an already-authored name without overwriting it from the halves', async () => {
    const wrapper = mountProfile({ ...FULL_PROFILE, name: 'Countess Lovelace' })
    await flushPromises()

    expect(wrapper.find('input[aria-label="Display Name"]').element.value).toBe('Countess Lovelace')

    await wrapper.find('input[aria-label="First Name"]').setValue('Janet')
    await flushPromises()

    expect(wrapper.find('input[aria-label="Display Name"]').element.value).toBe('Countess Lovelace')
  })

  it("re-reads the server's derived display name out of the save response", async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    // -> The server is the authority on what the name ended up being; the page must show what came
    //    back rather than whatever it happened to submit.
    globalThis.API_CLIENT.put.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          profile: { ...FULL_PROFILE, firstName: 'Janet', name: 'Janet Doe' }
        })
    })

    await wrapper.vm.save()
    await flushPromises()

    expect(wrapper.find('input[aria-label="Display Name"]').element.value).toBe('Janet Doe')
    expect(wrapper.find('input[aria-label="First Name"]').element.value).toBe('Janet')
  })

  it('loads and sends the aesthetic choice the same way appearance already works', async () => {
    const wrapper = mountProfile({ ...FULL_PROFILE, aesthetic: 'cobalt' })
    await flushPromises()

    // -> WBtnToggle draws each option as a labelled button; the test i18n resolves the untranslated
    //    profile.aesthetic* keys to themselves, so the aesthetic toggle's own aria-label is distinct
    //    from the appearance toggle's.
    const aestheticToggle = wrapper.find('[aria-label="profile.aesthetic"]')
    expect(aestheticToggle.exists()).toBe(true)
    expect(wrapper.find('[aria-label="profile.appearance"]').exists()).toBe(true)

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      aesthetic: 'cobalt',
      appearance: 'site'
    })
  })

  /*
    OpenProject #3052: the two prefs used to share one "Appearance" row/label with both toggles side
    by side in a flex-wrap div. Each now gets its own row with its own label and hint, so the two
    toggles must resolve to two distinct `.w-item` ancestors, not a shared one.
  */
  it('gives the aesthetic and light/dark toggles separate rows, each with its own label', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    const aestheticToggle = wrapper.find('[aria-label="profile.aesthetic"]')
    const appearanceToggle = wrapper.find('[aria-label="profile.appearance"]')
    expect(aestheticToggle.exists()).toBe(true)
    expect(appearanceToggle.exists()).toBe(true)

    const aestheticRow = aestheticToggle.element.closest('.w-item')
    const appearanceRow = appearanceToggle.element.closest('.w-item')
    expect(aestheticRow).not.toBe(null)
    expect(appearanceRow).not.toBe(null)
    expect(aestheticRow).not.toBe(appearanceRow)

    // -> Each row carries its own label and hint text now, rather than one row describing both.
    expect(aestheticRow.textContent).toContain('profile.aesthetic')
    expect(aestheticRow.textContent).toContain('profile.aestheticHint')
    expect(appearanceRow.textContent).toContain('profile.appearance')
    expect(appearanceRow.textContent).toContain('profile.appearanceHint')
  })

  it('patches userStore.aesthetic on save, the same way appearance already does', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ ...FULL_PROFILE, aesthetic: 'ledger' })
    })
    const { wrapper, userStore } = mountWithApp(ProfileInfo, {
      messages: { common: { actions: { saveChanges: 'Save Changes' } } },
      stores: {
        site: (store) => {
          store.features.profile = true
        }
      }
    })
    await flushPromises()

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(userStore.aesthetic).toBe('ledger')
  })

  it('defaults the aesthetic choice to site when the profile carries none', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      aesthetic: 'site'
    })
  })

  /**
   * Feature #3051 / Task #3068: `contentWidth` follows the same load/send/patch/default shape
   * `aesthetic` already exercises above.
   */
  it('loads and sends the contentWidth choice the same way aesthetic already works', async () => {
    const wrapper = mountProfile({ ...FULL_PROFILE, contentWidth: 'full' })
    await flushPromises()

    // -> WBtnToggle draws each option as a labelled button; the test i18n resolves the untranslated
    //    profile.contentWidth* keys to themselves, so this toggle's own aria-label is distinct from
    //    the aesthetic/appearance toggles'.
    const contentWidthToggle = wrapper.find('[aria-label="profile.contentWidth"]')
    expect(contentWidthToggle.exists()).toBe(true)

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      contentWidth: 'full'
    })
  })

  it('patches userStore.contentWidth on save, the same way aesthetic already does', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ ...FULL_PROFILE, contentWidth: 'measured' })
    })
    const { wrapper, userStore } = mountWithApp(ProfileInfo, {
      messages: { common: { actions: { saveChanges: 'Save Changes' } } },
      stores: {
        site: (store) => {
          store.features.profile = true
        }
      }
    })
    await flushPromises()

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(userStore.contentWidth).toBe('measured')
  })

  it('defaults the contentWidth choice to site when the profile carries none', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      contentWidth: 'site'
    })
  })

  it('carries a mononym through: an empty last name is loaded and sent as empty', async () => {
    const wrapper = mountProfile({
      ...FULL_PROFILE,
      name: 'Prince',
      firstName: 'Prince',
      lastName: ''
    })
    await flushPromises()

    expect(wrapper.find('input[aria-label="Last Name"]').element.value).toBe('')

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      name: 'Prince',
      firstName: 'Prince',
      lastName: ''
    })
  })
})

/**
 * Task #3220 (Epic #3219): the explicit Save button is gone -- a field change auto-applies,
 * debounced, with no toast on success (ambient, the point is removing the need to think about
 * saving at all) but a toast, plus inline error state where it can be pinned to a field, on failure.
 */
describe('ProfileInfo auto-save (Task #3220)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders no Save button at all', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    expect(wrapper.find('.actions-bar').exists()).toBe(false)
    expect(wrapper.findAll('button').some((btn) => btn.text().includes('Save Changes'))).toBe(false)
  })

  it('does not save merely from loading the initial profile', async () => {
    mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('saves automatically, debounced, once a field is edited -- with no explicit trigger', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    await wrapper.find('input[aria-label="First Name"]').setValue('Janet')
    await flushPromises()
    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      firstName: 'Janet'
    })
  })

  it('collapses several edits inside the debounce window into a single save', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    await wrapper.find('input[aria-label="First Name"]').setValue('Ja')
    await vi.advanceTimersByTimeAsync(400)
    await wrapper.find('input[aria-label="First Name"]').setValue('Jan')
    await vi.advanceTimersByTimeAsync(400)
    await wrapper.find('input[aria-label="First Name"]').setValue('Janet')
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      firstName: 'Janet'
    })
  })

  it('raises no success toast once an auto-save completes', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })
    notifyQueue.splice(0, notifyQueue.length)

    await wrapper.find('input[aria-label="First Name"]').setValue('Janet')
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(notifyQueue.some((n) => n.type === 'positive')).toBe(false)
  })

  it('still raises a failure toast when an auto-save fails, so nothing is silently lost', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    const err = new Error('network')
    globalThis.API_CLIENT.put.mockImplementation(() => {
      throw err
    })
    notifyQueue.splice(0, notifyQueue.length)

    await wrapper.find('input[aria-label="First Name"]').setValue('Janet')
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative' })
  })

  it('puts an inline error on the timezone field for a server-rejected time zone', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    const err = new Error('Bad Request')
    err.data = {
      ok: false,
      error: 'userProfileInvalidTimezone',
      statusCode: 400,
      message: 'Not a recognized IANA time zone.'
    }
    globalThis.API_CLIENT.put.mockImplementationOnce(() => {
      throw err
    })

    await wrapper.vm.save()
    await flushPromises()

    const timezoneField = wrapper.find('[aria-label="admin.general.defaultTimezone"]')
    expect(timezoneField.exists()).toBe(true)
    expect(timezoneField.element.closest('.w-item').textContent).toContain(
      'Not a recognized IANA time zone.'
    )
  })

  it('clears a field-level error once a fresh save is attempted', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    const err = new Error('Bad Request')
    err.data = {
      ok: false,
      error: 'userProfileInvalidTimezone',
      statusCode: 400,
      message: 'Not a recognized IANA time zone.'
    }
    globalThis.API_CLIENT.put.mockImplementationOnce(() => {
      throw err
    })
    await wrapper.vm.save()
    await flushPromises()
    expect(wrapper.text()).toContain('Not a recognized IANA time zone.')

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(wrapper.text()).not.toContain('Not a recognized IANA time zone.')
  })
})

/**
 * OpenProject #3281: `aesthetic`/`appearance`/`contentWidth`/`cvd` used to mount pre-selected on a
 * hardcoded default (`'site'`/`'none'`), then flash to the real saved value once `users/profile`
 * resolved. `state.config`'s initial value for all four is now `null`, and `WBtnToggle`'s own
 * selection check (`opt.value === modelValue`) is false for every segment when `modelValue` is
 * `null`, so no segment should render selected until the real value lands.
 */
describe('ProfileInfo theme toggles have no pre-fetch flash (OpenProject #3281)', () => {
  const toggleLabels = [
    'profile.aesthetic',
    'profile.appearance',
    'profile.contentWidth',
    'profile.cvd'
  ]

  function expectNoSegmentSelected(wrapper) {
    for (const label of toggleLabels) {
      const toggle = wrapper.find(`[role="radiogroup"][aria-label="${label}"]`)
      expect(toggle.exists()).toBe(true)
      expect(toggle.find('[aria-checked="true"]').exists()).toBe(false)
    }
  }

  it('renders every theme toggle with no segment selected before the profile fetch resolves', async () => {
    let resolveProfile
    globalThis.API_CLIENT.get.mockReturnValue({
      json: () =>
        new Promise((resolve) => {
          resolveProfile = resolve
        })
    })

    const wrapper = mountPage()
    await nextTick()

    expectNoSegmentSelected(wrapper)

    // -> Once the fetch resolves, the real values take over -- confirming this isn't merely a
    //    permanently-blank control, but genuinely a race that now resolves the right way.
    resolveProfile({
      ...FULL_PROFILE,
      aesthetic: 'cobalt',
      contentWidth: 'full',
      cvd: 'protanopia'
    })
    await flushPromises()

    const aestheticToggle = wrapper.find('[role="radiogroup"][aria-label="profile.aesthetic"]')
    expect(aestheticToggle.find('[aria-checked="true"]').exists()).toBe(true)
  })

  it('leaves every theme toggle blank, with the load-failed toast, when the profile fetch fails', async () => {
    notifyQueue.splice(0, notifyQueue.length)
    globalThis.API_CLIENT.get.mockReturnValue({
      json: () => Promise.reject(new Error('network'))
    })

    const wrapper = mountPage()
    await flushPromises()

    expectNoSegmentSelected(wrapper)
    expect(
      notifyQueue.some((n) => n.type === 'negative' && n.message === 'profile.infoLoadingFailed')
    ).toBe(true)
  })
})
