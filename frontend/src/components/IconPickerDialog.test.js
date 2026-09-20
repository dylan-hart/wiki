import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { queue as notifyQueue } from '@/composables/notify'
import { mountWithApp } from '../../test/mount.js'
import IconPickerDialog from './IconPickerDialog.vue'

const TABLER_SET = { prefix: 'tabler', name: 'Tabler', isEnabled: true }
const MDI_SET = { prefix: 'mdi', name: 'Material Design Icons', isEnabled: true }

async function mountPicker({ authenticated = false, iconPickerPref = null, sets } = {}) {
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'icons/sets') {
      return { json: () => Promise.resolve(sets ?? [TABLER_SET, MDI_SET]) }
    }
    if (url === 'users/profile') {
      return { json: () => Promise.resolve({ iconPicker: iconPickerPref ?? undefined }) }
    }
    return { json: () => Promise.resolve({}) }
  })
  API_CLIENT.put.mockReturnValue({ json: () => Promise.resolve({}) })

  const { wrapper } = mountWithApp(IconPickerDialog, {
    props: { modelValue: '' },
    stores: { user: { authenticated } }
  })
  await flushPromises()
  return wrapper
}

describe('IconPickerDialog: default set filter', () => {
  it('defaults to tabler for a guest reader, and never touches the profile', async () => {
    const wrapper = await mountPicker({ authenticated: false })

    expect(wrapper.vm.state.setFilter).toBe('tabler')
    expect(API_CLIENT.get).not.toHaveBeenCalledWith('users/profile')
  })

  it('defaults to tabler for a signed in reader who has never saved a preference', async () => {
    const wrapper = await mountPicker({ authenticated: true, iconPickerPref: null })

    expect(wrapper.vm.state.setFilter).toBe('tabler')
  })

  it('falls back to every set when tabler is not among the enabled sets', async () => {
    const wrapper = await mountPicker({ authenticated: false, sets: [MDI_SET] })

    expect(wrapper.vm.state.setFilter).toBe('')
  })
})

describe('IconPickerDialog: persisted set filter', () => {
  it('loads a signed in reader’s previously saved set filter, overriding the tabler default', async () => {
    const wrapper = await mountPicker({ authenticated: true, iconPickerPref: { set: 'mdi' } })

    expect(wrapper.vm.state.setFilter).toBe('mdi')
  })

  it('falls back to every set when the persisted set has since been disabled', async () => {
    const wrapper = await mountPicker({
      authenticated: true,
      iconPickerPref: { set: 'mdi' },
      sets: [TABLER_SET]
    })

    expect(wrapper.vm.state.setFilter).toBe('')
  })

  it('saves the chosen set filter back onto the profile when it changes', async () => {
    const wrapper = await mountPicker({ authenticated: true })

    wrapper.vm.state.setFilter = 'mdi'
    wrapper.vm.onSetFilterChange()
    await flushPromises()

    expect(API_CLIENT.put).toHaveBeenCalledWith('users/profile', {
      json: { iconPicker: { set: 'mdi' } }
    })
  })

  it('never saves a set filter change for a guest reader', async () => {
    const wrapper = await mountPicker({ authenticated: false })

    wrapper.vm.state.setFilter = 'mdi'
    wrapper.vm.onSetFilterChange()
    await flushPromises()

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })
})

/**
 * The backend degrades a failed search to its own local fallback rather than rejecting, so a
 * rejection reaching the frontend is the rare, genuinely-unexpected case -- and still not a
 * user-facing failure, so it draws the same empty-results state as a search that matched nothing.
 */
describe('IconPickerDialog: search failure', () => {
  it('degrades silently on a search failure -- empty results, no error toast', async () => {
    const wrapper = await mountPicker({ authenticated: false })
    notifyQueue.splice(0, notifyQueue.length)
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'icons/sets') {
        return { json: () => Promise.resolve([TABLER_SET, MDI_SET]) }
      }
      if (typeof url === 'string' && url.startsWith('icons/search')) {
        return { json: () => Promise.reject(new Error('network failed')) }
      }
      return { json: () => Promise.resolve({}) }
    })

    wrapper.vm.state.query = 'home'
    await wrapper.vm.search()

    expect(wrapper.vm.state.results).toEqual([])
    expect(wrapper.vm.state.loading).toBe(false)
    expect(notifyQueue).toHaveLength(0)
  })

  it('shows the real results once a later search succeeds again', async () => {
    const wrapper = await mountPicker({ authenticated: false })
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'icons/sets') {
        return { json: () => Promise.resolve([TABLER_SET, MDI_SET]) }
      }
      if (typeof url === 'string' && url.startsWith('icons/search')) {
        return { json: () => Promise.resolve({ icons: ['tabler:home'] }) }
      }
      return { json: () => Promise.resolve({}) }
    })

    wrapper.vm.state.query = 'home'
    await wrapper.vm.search()

    expect(wrapper.vm.state.results).toEqual(['tabler:home'])
  })
})
