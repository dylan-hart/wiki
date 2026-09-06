import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileInfo from './ProfileInfo.vue'
import { mountWithApp } from '../../test/mount.js'

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
