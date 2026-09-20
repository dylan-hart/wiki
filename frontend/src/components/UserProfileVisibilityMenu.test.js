import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import UserProfileVisibilityMenu from './UserProfileVisibilityMenu.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { mountWithApp } from '../../test/mount.js'

const MENU_STUB = { template: '<div class="menu-stub"><slot /></div>', methods: { hide() {} } }

const MESSAGES = {
  'admin.users.profileVisibilitySaveSuccess': 'Saved.',
  'admin.users.profileVisibilitySaveFailed': 'Failed to save.',
  'admin.users.profileVisibilityLoadFailed': 'Failed to load.'
}

function httpError(message) {
  return Object.assign(new Error('Request failed with status code 400: PUT'), {
    name: 'HTTPError',
    data: { message }
  })
}

function mountMenu() {
  const { wrapper } = mountWithApp(UserProfileVisibilityMenu, {
    messages: MESSAGES,
    stubs: { teleport: true, WMenu: MENU_STUB }
  })
  return wrapper
}

async function mountLoaded(loaded = { forcedPublicFields: ['location'], guestsMayView: false }) {
  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(loaded) })
  const wrapper = mountMenu()
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
})

describe('UserProfileVisibilityMenu', () => {
  it('loads the current settings from users/profile-visibility', async () => {
    const wrapper = await mountLoaded({ forcedPublicFields: ['jobTitle'], guestsMayView: true })

    expect(API_CLIENT.get).toHaveBeenCalledWith('users/profile-visibility')
    expect(wrapper.vm.state.forcedPublicFields).toEqual(['jobTitle'])
    expect(wrapper.vm.state.guestsMayView).toBe(true)
  })

  it('offers only the About Me fields, never email', async () => {
    const wrapper = await mountLoaded()

    expect(wrapper.vm.fieldOptions.map((o) => o.value)).toEqual([
      'location',
      'jobTitle',
      'pronouns'
    ])
  })

  it('saves both settings in one PUT and confirms', async () => {
    const wrapper = await mountLoaded()
    API_CLIENT.put.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    wrapper.vm.state.forcedPublicFields = ['location', 'pronouns']
    wrapper.vm.state.guestsMayView = true
    await wrapper.vm.save()

    expect(API_CLIENT.put).toHaveBeenCalledWith('users/profile-visibility', {
      json: { forcedPublicFields: ['location', 'pronouns'], guestsMayView: true }
    })
    expect(notifyQueue.at(-1)?.type).toBe('positive')
  })

  it("surfaces the server's reason when the save is rejected", async () => {
    const wrapper = await mountLoaded()
    API_CLIENT.put.mockImplementationOnce(() => {
      throw httpError('Email cannot be made public.')
    })

    await wrapper.vm.save()

    expect(notifyQueue.at(-1)?.type).toBe('negative')
    expect(notifyQueue.at(-1)?.caption).toBe('Email cannot be made public.')
  })

  it('refuses to save when the settings never loaded, so defaults are not written over real values', async () => {
    API_CLIENT.get.mockImplementationOnce(() => {
      throw httpError('nope')
    })
    const wrapper = mountMenu()
    await flushPromises()

    await wrapper.vm.save()

    expect(API_CLIENT.put).not.toHaveBeenCalled()
    expect(notifyQueue.some((n) => n.message === 'Failed to load.')).toBe(true)
  })

  it('states the guest lookup risk and that forced fields are not required', async () => {
    const wrapper = await mountLoaded()
    const html = wrapper.html()

    expect(html).toContain('admin.users.profileVisibilityForcedHint')
    expect(html).toContain('admin.users.profileVisibilityGuestsHint')
  })
})
