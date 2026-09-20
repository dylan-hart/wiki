import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileInfo from './ProfileInfo.vue'
import ProfileOverlay from '@/components/ProfileOverlay.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { pendingProfileSaves } from '@/composables/profileSaving'
import { mountWithApp } from '../../test/mount.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

function mountPage() {
  // -> Every field is readonly until `canEdit` -- gated on this feature flag -- is true.
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

describe('ProfileInfo against Cardinal Wiki - Profile 3x.dc.html (OpenProject #2623)', () => {
  // -> The theme/time/accessibility rows -- and the sun/eye glyphs with them -- belong to
  //    `ProfilePreferences.vue`; only the ID card glyph is this page's own.
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

    // -> The test i18n resolves a missing key to the key itself, hence the raw `profile.email`.
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
      The page itself (titled "About Me" in the sidenav) is the only section the identity fields
      need, so it draws no band at all. Where one is drawn, the strip IS the seam between two row
      groups -- a `mt-*` utility on it opens a hole the design does not have.
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

    // -> `ProfileOverlay.vue`'s stylesheet is the single owner of the content column's padding, so
    //    every section agrees rather than each restating it.
    expect(wrapper.classes()).toContain('w-page')
    expect(wrapper.classes().some((cls) => cls.startsWith('py-') || cls.startsWith('pt-'))).toBe(
      false
    )

    // -> `WSeparator`'s `spaced` prop emits an inline `margin-block`; here the 14px of row padding
    //    on each side is the gap, so no separator may carry space of its own.
    const separators = wrapper.findAll('.w-separator')
    expect(separators.length).toBeGreaterThan(0)
    for (const separator of separators) {
      expect(separator.attributes('style') ?? '').not.toContain('margin-block')
    }
  })
})

/**
 * The claims above that are MEASUREMENTS rather than class names, checked where a measurement can
 * actually be taken: jsdom runs no layout engine, so `min-h-[34px]` on an element proves the class
 * is there, not that a 34px field renders, and a padding declared in `ProfileOverlay.vue`'s
 * stylesheet is not visible from the markup at all. The container carries `.layout-profile-body`
 * because that is what the rhythm rules are scoped to. Skipped without Chromium: `npm ci` installs
 * the Playwright library, not the browser binary.
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

      // -> Mounted for its stylesheet, not its markup: Vitest's `css: true` injects an SFC's
      //    `<style>` block into this document, putting `.layout-profile-body`'s rules in reach.
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
 * All three name fields are sent on every save: `models/users.ts#updateUser` is the one place that
 * decides whether a submitted `name` counts as authoring it, so nothing here tracks whether the
 * display name was typed into.
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
 * The auto-save draws no loading indicator of its own, so the shared `pendingProfileSaves` counter
 * is the only signal the Profile dialog's close button and dismiss guard have that one is in flight.
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
    The reason `composables/displayName.js` exists: the server reads a submitted `name` differing
    from what the halves derive to as a deliberate override and marks the account authored for
    good, so leaving a stale display name in the payload would permanently freeze it.
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
    // -> A submitted name equal to the derived one is the server's own "put this back on
    //    derivation" write, so the form follows that rule rather than inventing a second one.
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
 * A field change auto-applies with no Save button and no success toast -- saving is meant to be
 * ambient -- but a failure must still surface, or an edit is silently lost.
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
    Only the toggle/select fields go through the debounced watch -- the text fields commit on
    blur/Enter (the describe below) -- so `aesthetic` is what demonstrates it. `wrapper.vm.state` is
    the escape hatch for a `<script setup>` reactive with no template control worth driving by hand.
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

  it('stops the Escape keydown from bubbling to document, so it does not also close the dialog (OpenProject #3351)', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    const documentKeydown = vi.fn()
    document.addEventListener('keydown', documentKeydown)
    try {
      const input = wrapper.find('input[aria-label="First Name"]')
      input.element.focus()
      await input.setValue('Janet')

      input.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushPromises()

      expect(input.element.value).toBe('Jane')
      expect(documentKeydown).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', documentKeydown)
    }
  })

  it('reverts to the newest saved value, not the originally-loaded one, once a save has landed', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    // -> The echoed profile is what re-baselines `lastSaved` through `applyProfile()`, which is
    //    what Esc then reverts to.
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
    // -> Still just the blur's save: the revert-then-blur fires no second request.
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

/**
 * This page renders no control for the theme/time/accessibility fields, but its `save()` PUTs the
 * whole profile object, so it must carry them through unchanged -- and patch none of them onto
 * `userStore` -- or it clobbers whatever `ProfilePreferences.vue` last saved.
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
