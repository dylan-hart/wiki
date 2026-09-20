import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import ProfileInfo from './ProfileInfo.vue'
import { mountWithApp } from '../../test/mount.js'

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

function mountProfile(profile, { canEdit = true } = {}) {
  globalThis.API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve(profile) })
  return mountWithApp(ProfileInfo, {
    stores: {
      site: (store) => {
        store.features.profile = canEdit
      }
    }
  }).wrapper
}

const toggle = (wrapper, field) => wrapper.find(`[data-testid="profile-public-toggle-${field}"]`)

const putPayload = () => globalThis.API_CLIENT.put.mock.calls.at(-1)[1].json

describe('ProfileInfo public-field visibility toggles', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({ ok: true }) })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers a toggle for each About Me field and none for email', async () => {
    const wrapper = mountProfile({ ...FULL_PROFILE, publicFields: ['jobTitle'] })
    await flushPromises()

    expect(toggle(wrapper, 'location').attributes('aria-checked')).toBe('false')
    expect(toggle(wrapper, 'jobTitle').attributes('aria-checked')).toBe('true')
    expect(toggle(wrapper, 'pronouns').attributes('aria-checked')).toBe('false')
    expect(wrapper.findAll('[data-testid^="profile-public-toggle-"]')).toHaveLength(3)
    expect(toggle(wrapper, 'email').exists()).toBe(false)
  })

  it('saves the changed publicFields list, debounced, through the shared auto-save', async () => {
    const wrapper = mountProfile(FULL_PROFILE)
    await flushPromises()

    await toggle(wrapper, 'pronouns').trigger('click')
    await toggle(wrapper, 'location').trigger('click')
    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(globalThis.API_CLIENT.put).toHaveBeenCalledTimes(1)
    expect(putPayload().publicFields).toEqual(['location', 'pronouns'])
  })

  it('removes a field from publicFields when its toggle is switched off', async () => {
    const wrapper = mountProfile({ ...FULL_PROFILE, publicFields: ['location', 'jobTitle'] })
    await flushPromises()

    await toggle(wrapper, 'location').trigger('click')
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(putPayload().publicFields).toEqual(['jobTitle'])
  })

  it('does not save merely from loading a profile that already has publicFields', async () => {
    mountProfile({ ...FULL_PROFILE, publicFields: ['location'] })
    await flushPromises()

    await vi.advanceTimersByTimeAsync(2000)

    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('draws a forced field on and locked with the explanation, and ignores a click on it', async () => {
    const wrapper = mountProfile({ ...FULL_PROFILE, forcedPublicFields: ['location'] })
    await flushPromises()

    const forced = toggle(wrapper, 'location')
    expect(forced.attributes('aria-checked')).toBe('true')
    expect(forced.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="profile-public-forced-location"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="profile-public-forced-jobTitle"]').exists()).toBe(false)
    expect(toggle(wrapper, 'jobTitle').attributes('disabled')).toBeUndefined()

    await forced.trigger('click')
    await vi.advanceTimersByTimeAsync(2000)

    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()
  })

  it("sends only the reader's own list, never the forced one merged in", async () => {
    const wrapper = mountProfile({
      ...FULL_PROFILE,
      publicFields: ['pronouns'],
      forcedPublicFields: ['location']
    })
    await flushPromises()

    await toggle(wrapper, 'jobTitle').trigger('click')
    await vi.advanceTimersByTimeAsync(800)
    await flushPromises()

    expect(putPayload().publicFields).toEqual(['jobTitle', 'pronouns'])
    expect(putPayload()).not.toHaveProperty('forcedPublicFields')
  })

  it('does not make a forced field mandatory', async () => {
    const wrapper = mountProfile({
      ...FULL_PROFILE,
      location: '',
      forcedPublicFields: ['location']
    })
    await flushPromises()

    const input = wrapper.find('input[aria-label="profile.location"]')
    expect(input.attributes('readonly')).toBeUndefined()
    expect(input.attributes('required')).toBeUndefined()
    expect(input.attributes('aria-required')).toBeUndefined()

    await input.trigger('blur')
    await vi.advanceTimersByTimeAsync(2000)

    expect(globalThis.API_CLIENT.put).not.toHaveBeenCalled()
    expect(wrapper.find('.w-input-control--error').exists()).toBe(false)
  })

  it('drops keys outside the About Me set from what it reads and sends', async () => {
    const wrapper = mountProfile({
      ...FULL_PROFILE,
      publicFields: ['email', 'location', 'bogus'],
      forcedPublicFields: ['email']
    })
    await flushPromises()

    expect(wrapper.vm.state.config.publicFields).toEqual(['location'])
    expect(wrapper.vm.state.config.forcedPublicFields).toEqual([])
    expect(wrapper.find('[data-testid^="profile-public-forced-"]').exists()).toBe(false)
  })

  it('leaves the toggles inert while profile editing is switched off', async () => {
    const wrapper = mountProfile(FULL_PROFILE, { canEdit: false })
    await flushPromises()

    expect(toggle(wrapper, 'location').attributes('disabled')).toBeDefined()
  })
})
