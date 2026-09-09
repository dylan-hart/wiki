import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { mountWithApp } from '../../test/mount.js'
import IconPickerDialog from './IconPickerDialog.vue'

/**
 * The icon set filter's default (Tabler, this app's own icon set) and its persistence onto the
 * signed-in reader's profile -- the same `GET`/`PUT profile` contract the knowledge graph's own view
 * controls use (`Graph.persistence.test.js`, `backend/api/users/profile.iconPicker.test.ts`,
 * `backend/models/users.profile.test.ts`).
 */

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
