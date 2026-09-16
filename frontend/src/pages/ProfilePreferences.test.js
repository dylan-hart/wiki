import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

import ProfilePreferences from './ProfilePreferences.vue'
import ProfileOverlay from '@/components/ProfileOverlay.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { pendingProfileSaves } from '@/composables/profileSaving'
import { mountWithApp } from '../../test/mount.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #3315 (Feature #3314): `ProfilePreferences.vue` is the THEME/TIME/ACCESSIBILITY half
 * of what used to be `ProfileInfo.vue`'s single PREFERENCES/ACCESSIBILITY section, split into its
 * own page. Where a moved suite's own reasoning still applies verbatim, the doc comment is kept and
 * only the WP marker is added; where the coordination note calls out this page's own new
 * responsibility (carrying the identity fields through, patching only its own fields onto
 * userStore), that gets a dedicated describe instead.
 */
function mountPage() {
  return mountWithApp(ProfilePreferences, {
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
 * `WSelect`'s interactive element is a `<button>` (it opens a menu rather than accepting typed
 * input), so `setValue()` cannot drive it the way `ProfileInfo.test.js` drives its plain `w-input`
 * fields. `w-btn-toggle` is a plain `<button>` too, but a `click` on one of its own segments -- the
 * timeFormat row's "24h" segment here -- is a real, minimal edit that exercises the same
 * `state.config` watcher every other field change does.
 */
async function toggleTimeFormatTo24h(wrapper) {
  const toggle = wrapper.find('[role="radiogroup"][aria-label="profile.timeFormat"]')
  const option = toggle
    .findAll('button')
    .find((btn) => btn.text().includes('admin.general.defaultTimeFormat24h'))
  await option.trigger('click')
}

function mountProfile(profile) {
  globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve(profile) })
  return mountWithApp(ProfilePreferences, {
    messages: {
      common: { actions: { saveChanges: 'Save Changes' } }
    },
    stores: {
      site: (store) => {
        store.features.profile = true
      }
    }
  }).wrapper
}

/**
 * OpenProject #2810: row 10 (Profile) of `docs/cobalt-mockup-diff-signoff.md` was never diffed
 * against `ui-redesign-cobalt/Cardinal Wiki - Profile 3x - Cobalt.dc.html`. That diff found the
 * Preferences card's four `w-btn-toggle`s (Time format, Aesthetic, Appearance, Colour vision) all
 * filling their selected segment from `--color-primary` where the mockup's selected-segment fill is
 * the ACCENT role (`ui-redesign-cobalt/HANDOFF.md`'s chrome table, "Accent fill carrying WHITE text
 * ... selected segment", `#c8303c`/5.3:1) -- invisible under Ledger only because its `colorPrimary`
 * and `colorAccent` defaults are identical (`#c14a52`).
 */
describe('ProfilePreferences against Cardinal Wiki - Profile 3x - Cobalt.dc.html (OpenProject #2810)', () => {
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
describe('ProfilePreferences toggle-style fields collapse to field-over-value (OpenProject #3060)', () => {
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
 * `{ skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT }` for the same reason the two API-key dialog suites take it: `npm ci`
 * installs the Playwright library, not the browser binary.
 */
describe(
  'ProfilePreferences settings-row rhythm, real layout (OpenProject #2623)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let metrics

    beforeAll(async () => {
      browser = await chromium.launch()

      globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

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
 * OpenProject #3315: three section bands now -- THEME, TIME, ACCESSIBILITY -- where the old
 * combined page drew PREFERENCES + ACCESSIBILITY (2). Each still runs flush against the row before
 * it, no `mt-*` gap (Task #3220 removed the save bar these used to sit above).
 */
describe('ProfilePreferences section bands (OpenProject #3315)', () => {
  it('draws THEME, TIME and ACCESSIBILITY, each flush against the row before it', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve({}) })

    const wrapper = mountPage()
    await flushPromises()

    const bands = wrapper.findAll('.w-section-header')
    expect(bands.length).toBe(3)
    expect(bands.map((band) => band.text())).toEqual([
      'profile.theme',
      'profile.time',
      'profile.accessibility'
    ])
    for (const band of bands) {
      expect(band.classes().some((cls) => cls.startsWith('mt-'))).toBe(false)
    }
  })
})

/**
 * OpenProject #3282: save() counts itself on the shared `pendingProfileSaves` module singleton --
 * the auto-save is otherwise silent (Task #3220, no local loading indicator of its own), so this is
 * the only signal the Profile dialog's close button/dismiss guard have that a save is in flight.
 * Mirrors `ProfileInfo.test.js`'s own suite of the same name -- both pages share the singleton.
 */
describe('ProfilePreferences pendingProfileSaves (OpenProject #3282)', () => {
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

/**
 * OpenProject #3344: `onFieldChange()` calls `save()` directly on every field change with no
 * debounce and nothing sequencing overlapping requests, so two saves fired in quick succession can
 * have their PUT responses land out of order. `save()`'s `saveGeneration` guard drops a response
 * whose call has since been superseded by a newer one, on both the success and the failure branch.
 */
describe('ProfilePreferences save() drops stale responses across overlapping saves (OpenProject #3344)', () => {
  it('drops a stale SUCCESS response that lands after a newer save already applied its own outcome', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ ...FULL_PROFILE, timezone: 'UTC' })
    })
    const { wrapper, userStore } = mountWithApp(ProfilePreferences, {
      messages: { common: { actions: { saveChanges: 'Save Changes' } } },
      stores: {
        site: (store) => {
          store.features.profile = true
        }
      }
    })
    await flushPromises()

    let resolveFirst
    let resolveSecond
    globalThis.API_CLIENT.put
      .mockReturnValueOnce({
        json: () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      })
      .mockReturnValueOnce({
        json: () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      })

    const firstSave = wrapper.vm.save()
    await flushPromises()
    const secondSave = wrapper.vm.save()
    await flushPromises()

    // The second (newer) call's response lands first and applies its own timezone.
    resolveSecond({ profile: { ...FULL_PROFILE, timezone: 'America/New_York' } })
    await secondSave
    await flushPromises()
    expect(userStore.timezone).toBe('America/New_York')

    // The first (now stale) call's response lands after -- must be dropped, not overwrite the
    // newer state.
    resolveFirst({ profile: { ...FULL_PROFILE, timezone: 'Europe/London' } })
    await firstSave
    await flushPromises()

    expect(userStore.timezone).toBe('America/New_York')
  })

  it('drops a stale FAILURE response (no toast, no field-error pin) that lands after a newer save already succeeded', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    let rejectFirst
    let resolveSecond
    globalThis.API_CLIENT.put
      .mockReturnValueOnce({
        json: () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          })
      })
      .mockReturnValueOnce({
        json: () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      })

    const firstSave = wrapper.vm.save()
    await flushPromises()
    const secondSave = wrapper.vm.save()
    await flushPromises()

    resolveSecond({ ok: true })
    await secondSave
    await flushPromises()

    notifyQueue.splice(0, notifyQueue.length)

    const err = new Error('Bad Request')
    err.data = {
      ok: false,
      error: 'userProfileInvalidTimezone',
      statusCode: 400,
      message: 'Not a recognized IANA time zone.'
    }
    rejectFirst(err)
    await firstSave
    await flushPromises()

    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(false)
    expect(wrapper.text()).not.toContain('Not a recognized IANA time zone.')
  })

  it('still applies a FAILURE response when it is the latest call, even after an earlier call resolved first', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    let resolveFirst
    let rejectSecond
    globalThis.API_CLIENT.put
      .mockReturnValueOnce({
        json: () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      })
      .mockReturnValueOnce({
        json: () =>
          new Promise((_resolve, reject) => {
            rejectSecond = reject
          })
      })

    const firstSave = wrapper.vm.save()
    await flushPromises()
    const secondSave = wrapper.vm.save()
    await flushPromises()

    resolveFirst({ ok: true })
    await firstSave
    await flushPromises()

    notifyQueue.splice(0, notifyQueue.length)

    const err = new Error('Bad Request')
    err.data = {
      ok: false,
      error: 'userProfileInvalidTimezone',
      statusCode: 400,
      message: 'Not a recognized IANA time zone.'
    }
    rejectSecond(err)
    await secondSave
    await flushPromises()

    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
    expect(wrapper.text()).toContain('Not a recognized IANA time zone.')
  })
})

/**
 * OpenProject #3315: this page owns editing the theme/time/accessibility fields now -- the
 * load/send/patch/default shape each one exercises is unchanged from `ProfileInfo.vue`'s own
 * pre-split tests, just mounted on the new page and with the identity fields (name/email/...)
 * carried through unmodified instead of edited.
 */
describe('ProfilePreferences theme/time fields (moved from ProfileInfo, OpenProject #3315)', () => {
  it('loads and sends the aesthetic choice the same way appearance already works', async () => {
    const wrapper = mountProfile({ ...FULL_PROFILE, aesthetic: 'cobalt' })
    await flushPromises()

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

    expect(aestheticRow.textContent).toContain('profile.aesthetic')
    expect(aestheticRow.textContent).toContain('profile.aestheticHint')
    expect(appearanceRow.textContent).toContain('profile.appearance')
    expect(appearanceRow.textContent).toContain('profile.appearanceHint')
  })

  it('patches userStore.aesthetic on save, the same way appearance already does', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ ...FULL_PROFILE, aesthetic: 'ledger' })
    })
    const { wrapper, userStore } = mountWithApp(ProfilePreferences, {
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

  it('loads and sends the contentWidth choice the same way aesthetic already works', async () => {
    const wrapper = mountProfile({ ...FULL_PROFILE, contentWidth: 'full' })
    await flushPromises()

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
    const { wrapper, userStore } = mountWithApp(ProfilePreferences, {
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
})

/**
 * OpenProject #3315: carries the identity fields (name/firstName/lastName/location/jobTitle/
 * pronouns) through unmodified -- this page renders no control for them, so its own auto-save must
 * not clobber whatever `ProfileInfo.vue` last saved. Mirrors that page's own reciprocal suite.
 */
describe('ProfilePreferences carries identity fields through unmodified (OpenProject #3315)', () => {
  const IDENTITY_PROFILE = {
    ...FULL_PROFILE,
    name: 'Countess Lovelace',
    firstName: 'Ada',
    lastName: 'Lovelace',
    location: 'London',
    jobTitle: 'Mathematician',
    pronouns: 'she/her'
  }

  it('renders no control at all for any identity field', async () => {
    const wrapper = mountProfile(IDENTITY_PROFILE)
    await flushPromises()

    for (const label of [
      'profile.displayName',
      'profile.firstName',
      'profile.lastName',
      'profile.email',
      'profile.location',
      'profile.jobTitle',
      'profile.pronouns'
    ]) {
      expect(wrapper.find(`[aria-label="${label}"]`).exists()).toBe(false)
    }
  })

  it('sends the fetched identity fields back unchanged on save', async () => {
    const wrapper = mountProfile(IDENTITY_PROFILE)
    await flushPromises()

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      name: 'Countess Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      location: 'London',
      jobTitle: 'Mathematician',
      pronouns: 'she/her'
    })
  })

  it('does not patch name onto userStore -- that is ProfileInfo.vue’s job', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve(IDENTITY_PROFILE) })
    const { wrapper, userStore } = mountWithApp(ProfilePreferences, {
      messages: { common: { actions: { saveChanges: 'Save Changes' } } },
      stores: {
        site: (store) => {
          store.features.profile = true
        },
        user: (store) => {
          store.name = 'Whoever Was There Before'
        }
      }
    })
    await flushPromises()

    globalThis.API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })
    await wrapper.vm.save()
    await flushPromises()

    expect(userStore.name).toBe('Whoever Was There Before')
  })
})

/**
 * Task #3220 (Epic #3219) established the shape: the explicit Save button is gone -- a field change
 * auto-applies, with no toast on success (ambient, the point is removing the need to think about
 * saving at all) but a toast, plus inline error state where it can be pinned to a field, on failure.
 * Task #3320 (Feature #3319) then dropped the debounce entirely for this page: every field here is a
 * toggle or a select, and there is no intermediate "typing" state for either the way there is for a
 * text field, so each one saves as soon as its own change event fires. `ProfileInfo.vue` keeps its
 * own debounce for the text fields it still owns (`ProfileInfo.test.js` covers that one); this page
 * carries no debounce at all any more, which is what the tests below pin.
 */
describe('ProfilePreferences fields save immediately, no debounce (Task #3220/#3320)', () => {
  function findToggle(wrapper, label) {
    return wrapper.find(`[role="radiogroup"][aria-label="${label}"]`)
  }

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
    await flushPromises()

    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('saves as soon as a btn-toggle segment is clicked, with no debounce wait', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    // -> No timer advance at all: this must already have gone out.
    await toggleTimeFormatTo24h(wrapper)
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      timeFormat: '24h'
    })
  })

  it('saves each of the seven toggle/select fields immediately on its own change', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    const cases = [
      {
        label: 'profile.aesthetic',
        text: 'profile.aestheticLedger',
        field: 'aesthetic',
        value: 'ledger'
      },
      {
        label: 'profile.appearance',
        text: 'profile.appearanceLight',
        field: 'appearance',
        value: 'light'
      },
      {
        label: 'profile.contentWidth',
        text: 'profile.contentWidthFull',
        field: 'contentWidth',
        value: 'full'
      },
      {
        label: 'profile.timeFormat',
        text: 'admin.general.defaultTimeFormat24h',
        field: 'timeFormat',
        value: '24h'
      },
      { label: 'profile.cvd', text: 'profile.cvdProtanopia', field: 'cvd', value: 'protanopia' }
    ]

    for (const { label, text, field, value } of cases) {
      globalThis.API_CLIENT.put.mockClear()
      const toggle = findToggle(wrapper, label)
      const segment = toggle.findAll('button').find((btn) => btn.text() === text)
      await segment.trigger('click')
      await flushPromises()

      expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
      expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({ [field]: value })
    }

    // -> The two `w-select`-backed fields (timezone, dateFormat) emit the same `update:model-value`
    //    event a real pick would; driving them through the DOM's own dropdown is `WSelect.test.js`'s
    //    job, not this suite's.
    globalThis.API_CLIENT.put.mockClear()
    const dateFormatSelect = wrapper
      .findAllComponents({ name: 'WSelect' })
      .find((c) => c.props('ariaLabel') === 'admin.general.defaultDateFormat')
    await dateFormatSelect.vm.$emit('update:modelValue', 'YYYY-MM-DD')
    await flushPromises()
    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      dateFormat: 'YYYY-MM-DD'
    })

    globalThis.API_CLIENT.put.mockClear()
    const timezoneSelect = wrapper
      .findAllComponents({ name: 'WSelect' })
      .find((c) => c.props('ariaLabel') === 'admin.general.defaultTimezone')
    await timezoneSelect.vm.$emit('update:modelValue', 'America/New_York')
    await flushPromises()
    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json).toMatchObject({
      timezone: 'America/New_York'
    })
  })

  it('raises no success toast once an auto-save completes', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })
    notifyQueue.splice(0, notifyQueue.length)

    await toggleTimeFormatTo24h(wrapper)
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

    await toggleTimeFormatTo24h(wrapper)
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
describe('ProfilePreferences theme toggles have no pre-fetch flash (OpenProject #3281)', () => {
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
