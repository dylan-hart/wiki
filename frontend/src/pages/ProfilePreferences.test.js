import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

import ProfilePreferences from './ProfilePreferences.vue'
import ProfileOverlay from '@/components/ProfileOverlay.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { pendingProfileSaves } from '@/composables/profileSaving'
import { mountWithApp } from '../../test/mount.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

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
 * Every field on this page is a toggle or a select, so `setValue()` drives none of them -- a
 * `WSelect` opens a menu rather than accepting typed input. Clicking a `w-btn-toggle` segment is
 * the smallest real edit available.
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
        `--color-segment-selected`, never `--color-accent` directly: the two aesthetics fill a
        selected segment differently -- Ledger from the site's primary, Cobalt from the accent -- so
        the token carries both and no caller names a tone.
      */
      expect(selected.attributes('style')).toContain(
        'background-color: var(--color-segment-selected)'
      )
    }
  })
})

/**
 * `WItemSection.vue`'s responsive stacking collapses only two ADJACENT MAIN sections
 * (`.w-item-section--main + .w-item-section--main`), never a flanking `side` one, so a toggle row
 * that wants to stack must put its value in a MAIN section. The container-query mechanism itself is
 * `WItem.responsiveStacking.test.js`'s to prove in a real browser; this is the DOM shape it needs.
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

      // -> The container query keys off the label's MAIN section immediately preceding it.
      const labelSection = valueSection.previousElementSibling
      expect(labelSection.classList.contains('w-item-section--main')).toBe(true)
    }
  })
})

/**
 * The claims above that are MEASUREMENTS rather than class names, checked where a measurement can
 * actually be taken: jsdom runs no layout engine, so `min-h-[34px]` on an element proves the class
 * is there, not that a 34px field renders, and a padding declared in `ProfileOverlay.vue`'s
 * stylesheet is not visible from the markup at all. The overlay is mounted alongside for its
 * stylesheet alone. Skipped without Chromium: `npm ci` installs the Playwright library, not the
 * browser binary.
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
 * The auto-save draws no loading indicator of its own, so the shared `pendingProfileSaves` counter
 * is the only signal the Profile dialog's close button and dismiss guard have that one is in
 * flight. Both profile pages write to the same singleton.
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
 * `onFieldChange()` calls `save()` on every field change with no debounce and nothing sequencing
 * overlapping requests, so two PUTs fired in quick succession can have their responses land out of
 * order. `save()`'s `saveGeneration` guard drops a superseded response on both branches.
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

    // The newer call's response lands first.
    resolveSecond({ profile: { ...FULL_PROFILE, timezone: 'America/New_York' } })
    await secondSave
    await flushPromises()
    expect(userStore.timezone).toBe('America/New_York')

    // The older call's response lands after it, and must be dropped rather than overwrite it.
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
 * This page renders no control for the identity fields but PUTs the whole profile object, so its
 * auto-save must carry them through unchanged or it clobbers what `ProfileInfo.vue` last saved.
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
 * Every field here is a toggle or a select, with no intermediate "typing" state to debounce, so
 * each saves the moment its own change event fires. Saving is ambient -- no Save button, no success
 * toast -- but a failure still raises one, plus inline error state where it can be pinned.
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

    // -> The two `w-select`-backed fields are driven by the event a real pick emits; driving the
    //    dropdown itself is `WSelect.test.js`'s job.
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
 * `state.config` starts these four at `null`, and `WBtnToggle`'s selection check
 * (`opt.value === modelValue`) is false for every segment then -- which is what keeps a hardcoded
 * default from rendering selected and flashing across once `users/profile` resolves.
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

/**
 * The same `saveGeneration` guard from the reader's side: an older save's response applied through
 * `applyProfile()` would silently revert a field the reader has already moved past.
 */
describe('ProfilePreferences guards against stale, out-of-order save() responses (OpenProject #3325)', () => {
  it("keeps the later edit's value when the earlier save's response resolves after the later one", async () => {
    globalThis.API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ ...FULL_PROFILE, aesthetic: 'site' })
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

    const aestheticToggle = wrapper.find('[role="radiogroup"][aria-label="profile.aesthetic"]')
    const ledgerOption = aestheticToggle
      .findAll('button')
      .find((btn) => btn.text().includes('profile.aestheticLedger'))
    const cobaltOption = aestheticToggle
      .findAll('button')
      .find((btn) => btn.text().includes('profile.aestheticCobalt'))

    // -> Save #1, left deliberately unresolved, then save #2 started over the top of it.
    await ledgerOption.trigger('click')
    await cobaltOption.trigger('click')

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(2)

    // -> Out of order: the newer save's response lands first...
    resolveSecond({ profile: { ...FULL_PROFILE, aesthetic: 'cobalt' } })
    await flushPromises()
    expect(userStore.aesthetic).toBe('cobalt')

    // -> ...then the stale one, which applied unconditionally would revert `aesthetic` to 'ledger'.
    resolveFirst({ profile: { ...FULL_PROFILE, aesthetic: 'ledger' } })
    await flushPromises()

    expect(userStore.aesthetic).toBe('cobalt')
    const cobaltSegment = aestheticToggle
      .findAll('button')
      .find((btn) => btn.text().includes('profile.aestheticCobalt'))
    expect(cobaltSegment.attributes('aria-checked')).toBe('true')
  })

  it('still applies the response when saves settle in the order they were sent', async () => {
    globalThis.API_CLIENT.get.mockReturnValue({
      json: () => Promise.resolve({ ...FULL_PROFILE, aesthetic: 'site' })
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

    globalThis.API_CLIENT.put.mockReturnValueOnce({
      json: () => Promise.resolve({ profile: { ...FULL_PROFILE, aesthetic: 'ledger' } })
    })
    await wrapper.vm.save()
    await flushPromises()

    expect(userStore.aesthetic).toBe('ledger')
  })
})

describe('ProfilePreferences on a site with profile editing locked', () => {
  function mountLocked(profile) {
    globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve(profile) })
    return mountWithApp(ProfilePreferences, {
      messages: { common: { actions: { saveChanges: 'Save Changes' } } },
      stores: {
        site: (store) => {
          store.features.profile = false
        }
      }
    }).wrapper
  }

  it('renders every preference control enabled and no locked notice', async () => {
    const wrapper = mountLocked(FULL_PROFILE)
    await flushPromises()

    for (const label of [
      'profile.appearance',
      'profile.aesthetic',
      'profile.contentWidth',
      'profile.timeFormat',
      'profile.cvd'
    ]) {
      const toggle = wrapper.find(`[role="radiogroup"][aria-label="${label}"]`)
      expect(toggle.exists()).toBe(true)
      expect(toggle.findAll('button').every((btn) => !btn.attributes('disabled'))).toBe(true)
    }
    expect(wrapper.text()).not.toContain('profile.editDisabledTitle')
  })

  it('saves a preference change without sending any identity field', async () => {
    const wrapper = mountLocked({ ...FULL_PROFILE, name: 'Jane Doe', location: 'Paris' })
    await flushPromises()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })

    const cvd = wrapper.find('[role="radiogroup"][aria-label="profile.cvd"]')
    await cvd
      .findAll('button')
      .find((btn) => btn.text().includes('profile.cvdDeuteranopia'))
      .trigger('click')
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    const body = globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json
    expect(body).toMatchObject({ cvd: 'deuteranopia' })
    for (const key of ['name', 'firstName', 'lastName', 'location', 'jobTitle', 'pronouns']) {
      expect(body).not.toHaveProperty(key)
    }
  })
})
