import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileInfo from './ProfileInfo.vue'
import ProfileOverlay from '@/components/ProfileOverlay.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { pendingProfileSaves } from '@/composables/profileSaving'
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
  /**
   * OpenProject #3315 (Feature #3314): the THEME/TIME/ACCESSIBILITY rows -- and the sun/eye glyphs
   * that came with them -- moved out to `ProfilePreferences.vue`. Only the ID card glyph (the
   * display name row) is still this page's own; `ProfilePreferences.test.js` pins the sun/eye pair
   * now.
   */
  it('draws the glyphs the design draws, not the ones that were there before', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    expect(wrapper.find('[data-icon="tabler:id"]').exists()).toBe(true)
    for (const icon of [
      'tabler:sun',
      'tabler:eye',
      'tabler:address-book',
      'tabler:bulb',
      'tabler:eye-off'
    ]) {
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

      OpenProject #3315: down from 3 to 1 -- PREFERENCES/ACCESSIBILITY's two bands moved to
      `ProfilePreferences.vue` with the rows they headed, leaving only MY INFO's here. OpenProject
      #3316 then removed that last band too: the page itself (titled "About Me" in the sidenav) is
      the only section the identity fields need, so this page draws no `.w-section-header` at all.
    */
    const bands = wrapper.findAll('.w-section-header')
    expect(bands.length).toBe(0)
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

/*
  OpenProject #3315 (Feature #3314): the Cobalt toggle-fill signoff (OpenProject #2810) and the
  toggle-style-fields responsive-stacking pin (OpenProject #3060) both exercised ONLY the
  THEME/TIME/ACCESSIBILITY toggle rows, which moved out to `ProfilePreferences.vue` -- this page
  renders no `w-btn-toggle` at all any more. Both describes moved there verbatim (component swapped),
  rather than staying here to assert on DOM that no longer exists.
*/

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

/**
 * OpenProject #3282: save() counts itself on the shared `pendingProfileSaves` module singleton --
 * the auto-save is otherwise silent (Task #3220, no local loading indicator of its own), so this is
 * the only signal the Profile dialog's close button/dismiss guard have that a save is in flight.
 */
describe('ProfileInfo pendingProfileSaves (OpenProject #3282)', () => {
  beforeEach(() => {
    pendingProfileSaves.value = 0
  })

  it('counts save() while the PUT is in flight, and clears it on success', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    let resolvePut
    globalThis.API_CLIENT.put.mockReturnValueOnce({
      json: () =>
        new Promise((resolve) => {
          resolvePut = resolve
        })
    })

    const savePromise = wrapper.vm.save()
    await flushPromises()
    expect(pendingProfileSaves.value).toBe(1)

    resolvePut({ ok: true })
    await savePromise
    expect(pendingProfileSaves.value).toBe(0)
  })

  it('clears the count on a failed save too', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.reject(new Error('network'))
    })

    await wrapper.vm.save()

    expect(pendingProfileSaves.value).toBe(0)
  })
})

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

  /*
    OpenProject #3321: firstName no longer drives this -- the text fields now save on blur/Enter, not
    on a debounce (see the dedicated describe block below). The toggle/select fields are #3320's
    remaining scope and still go through this same debounced watch, so `aesthetic` demonstrates it
    here instead. `wrapper.vm.state` is the same escape hatch `UserCreateDialog.test.js` already
    uses for a plain `<script setup>` reactive object with no template control worth driving by hand.
  */
  it('saves automatically, debounced, once a toggle/select field is edited -- with no explicit trigger', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    wrapper.vm.state.config.aesthetic = 'cobalt'
    await flushPromises()
    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      aesthetic: 'cobalt'
    })
  })

  it('collapses several edits inside the debounce window into a single save', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    wrapper.vm.state.config.aesthetic = 'cobalt'
    await vi.advanceTimersByTimeAsync(400)
    wrapper.vm.state.config.aesthetic = 'ledger'
    await vi.advanceTimersByTimeAsync(400)
    wrapper.vm.state.config.aesthetic = 'cobalt'
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      aesthetic: 'cobalt'
    })
  })

  it('raises no success toast once an auto-save completes', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })
    notifyQueue.splice(0, notifyQueue.length)

    wrapper.vm.state.config.aesthetic = 'cobalt'
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

    wrapper.vm.state.config.aesthetic = 'cobalt'
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative' })
  })
})

/**
 * OpenProject #3321: the text fields (firstName, lastName, displayName, location, jobTitle,
 * pronouns) save on blur or Enter -- a discrete commit, not the per-keystroke debounce the
 * describe block above still exercises for the toggle/select fields. Esc reverts the field to its
 * last-saved value and blurs it, and an unchanged blur/Enter fires no redundant save.
 */
describe('ProfileInfo text field blur/Enter save, Esc revert (OpenProject #3321)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not save merely from typing -- no debounce for text fields', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    await wrapper.find('input[aria-label="First Name"]').setValue('Janet')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()

    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('saves on blur once the value has changed', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    const input = wrapper.find('input[aria-label="First Name"]')
    await input.setValue('Janet')
    await input.trigger('blur')
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      firstName: 'Janet'
    })
  })

  it('fires no redundant save on blur when the value is unchanged', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    const input = wrapper.find('input[aria-label="First Name"]')
    await input.trigger('focus')
    await input.trigger('blur')
    await flushPromises()

    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('saves on Enter as a discrete commit', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    const input = wrapper.find('input[aria-label="First Name"]')
    await input.setValue('Janet')
    await input.trigger('keyup.enter')
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      firstName: 'Janet'
    })
  })

  it('fires no redundant save on Enter when the value is unchanged', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    await wrapper.find('input[aria-label="First Name"]').trigger('keyup.enter')
    await flushPromises()

    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('reverts to the last-saved value and blurs the field on Escape, firing no save', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    const input = wrapper.find('input[aria-label="First Name"]')
    input.element.focus()
    await input.setValue('Janet')
    expect(input.element.value).toBe('Janet')

    input.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(input.element.value).toBe('Jane')
    expect(document.activeElement).not.toBe(input.element)
    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('reverts to the newest saved value, not the originally-loaded one, once a save has landed', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    // -> Realistic response, echoing the saved profile back -- see "re-reads the server's derived
    //    display name out of the save response" above: this is what re-baselines `lastSaved` for
    //    Esc, via `applyProfile()`.
    globalThis.API_CLIENT.put.mockReturnValue({
      json: () =>
        Promise.resolve({
          ok: true,
          profile: { ...FULL_PROFILE, firstName: 'Janet', name: 'Janet Doe' }
        })
    })

    const input = wrapper.find('input[aria-label="First Name"]')
    await input.setValue('Janet')
    await input.trigger('blur')
    await flushPromises()
    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)

    input.element.focus()
    await input.setValue('Janice')
    input.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(input.element.value).toBe('Janet')
    // -> Still just the one save from the blur above -- the revert-then-blur fired no second request.
    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
  })

  it('applies the same blur-save behaviour to a field with no validation rules', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    const input = wrapper.find('input[aria-label="profile.location"]')
    await input.setValue('Berlin')
    await input.trigger('blur')
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      location: 'Berlin'
    })
  })
})

/*
  OpenProject #3315 (Feature #3314): the timezone inline-error tests (`userProfileInvalidTimezone`
  pinned to the timezone control) and the entire "theme toggles have no pre-fetch flash" describe
  (OpenProject #3281) both exercised controls that moved to `ProfilePreferences.vue` -- this page
  renders neither the timezone field nor any theme toggle any more. Both moved there verbatim
  (component swapped).
*/

/**
 * OpenProject #3315: `ProfileInfo.vue` no longer renders a control for the theme/time/accessibility
 * fields, but its `save()` still PUTs the whole profile object -- so it must carry whatever it
 * fetched for those fields through UNCHANGED, or it would clobber whatever `ProfilePreferences.vue`
 * last saved. It also must not patch any of them onto `userStore` any more (that page's job now).
 */
describe('ProfileInfo carries theme/time/accessibility fields through unmodified (OpenProject #3315)', () => {
  const NON_IDENTITY_PROFILE = {
    ...FULL_PROFILE,
    aesthetic: 'cobalt',
    appearance: 'dark',
    contentWidth: 'full',
    cvd: 'protanopia',
    timezone: 'Europe/Paris',
    dateFormat: 'YYYY-MM-DD',
    timeFormat: '24h'
  }

  it('renders no control at all for any of them', async () => {
    const wrapper = mountProfile(NON_IDENTITY_PROFILE)
    await flushPromises()

    for (const label of [
      'profile.aesthetic',
      'profile.appearance',
      'profile.contentWidth',
      'profile.cvd'
    ]) {
      expect(wrapper.find(`[aria-label="${label}"]`).exists()).toBe(false)
    }
    expect(wrapper.find('[aria-label="admin.general.defaultTimezone"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="admin.general.defaultDateFormat"]').exists()).toBe(false)
  })

  it('sends the fetched values back unchanged on save', async () => {
    const wrapper = mountProfile(NON_IDENTITY_PROFILE)
    await flushPromises()

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.find('input[aria-label="First Name"]').setValue('Janet')
    await wrapper.vm.save()
    await flushPromises()

    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      aesthetic: 'cobalt',
      appearance: 'dark',
      contentWidth: 'full',
      cvd: 'protanopia',
      timezone: 'Europe/Paris',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: '24h'
    })
  })

  it('patches only name onto userStore, leaving whatever ProfilePreferences.vue last set alone', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve(NON_IDENTITY_PROFILE) })
    const { wrapper, userStore } = mountWithApp(ProfileInfo, {
      messages: { common: { actions: { saveChanges: 'Save Changes' } } },
      stores: {
        site: (store) => {
          store.features.profile = true
        },
        user: (store) => {
          store.aesthetic = 'ledger'
          store.contentWidth = 'measured'
        }
      }
    })
    await flushPromises()

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(userStore.name).toBe(NON_IDENTITY_PROFILE.name)
    expect(userStore.aesthetic).toBe('ledger')
    expect(userStore.contentWidth).toBe('measured')
  })
})
