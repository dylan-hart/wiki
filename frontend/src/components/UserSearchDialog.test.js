import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import UserSearchDialog from './UserSearchDialog.vue'

import { createTestI18n } from '../../test/i18n.js'

let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

function mountDialog(props = {}) {
  setActivePinia(createPinia())
  const i18n = createTestI18n()

  currentWrapper = mount(UserSearchDialog, {
    props,
    global: { plugins: [i18n] }
  })
  return currentWrapper
}

function userRows() {
  return document.body.querySelectorAll('.user-search-dialog-list .w-item--clickable')
}

describe('UserSearchDialog singleSelect', () => {
  it('picking a second user replaces the first rather than adding to the selection', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          users: [
            { id: 'user-1', name: 'User One', email: 'one@example.com' },
            { id: 'user-2', name: 'User Two', email: 'two@example.com' }
          ],
          total: 2
        })
    })

    const wrapper = mountDialog({ singleSelect: true })
    await flushPromises()

    const rows = userRows()
    rows[0].click()
    await flushPromises()
    rows[1].click()
    await flushPromises()

    expect(wrapper.vm.state.selected).toEqual([
      { id: 'user-2', name: 'User Two', email: 'two@example.com' }
    ])
  })

  it('picking the same user again deselects it', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          users: [{ id: 'user-1', name: 'User One', email: 'one@example.com' }],
          total: 1
        })
    })

    const wrapper = mountDialog({ singleSelect: true })
    await flushPromises()

    const rows = userRows()
    rows[0].click()
    await flushPromises()
    rows[0].click()
    await flushPromises()

    expect(wrapper.vm.state.selected).toEqual([])
  })

  it('confirm() still hands the selection back as an array', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          users: [{ id: 'user-1', name: 'User One', email: 'one@example.com' }],
          total: 1
        })
    })

    const wrapper = mountDialog({ singleSelect: true })
    await flushPromises()
    userRows()[0].click()
    await flushPromises()

    wrapper.vm.confirm()

    expect(wrapper.emitted('ok')[0]).toEqual([
      [{ id: 'user-1', name: 'User One', email: 'one@example.com' }]
    ])
  })

  it('multi-select (the default) still accumulates a selection across clicks', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          users: [
            { id: 'user-1', name: 'User One', email: 'one@example.com' },
            { id: 'user-2', name: 'User Two', email: 'two@example.com' }
          ],
          total: 2
        })
    })

    const wrapper = mountDialog()
    await flushPromises()

    const rows = userRows()
    rows[0].click()
    await flushPromises()
    rows[1].click()
    await flushPromises()

    expect(wrapper.vm.state.selected).toHaveLength(2)
  })
})

describe('UserSearchDialog avatar images', () => {
  it('renders a row avatar lazily with explicit dimensions', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          users: [{ id: 'user-1', name: 'User One', email: 'one@example.com', hasAvatar: true }],
          total: 1
        })
    })

    mountDialog()
    await flushPromises()

    const img = document.body.querySelector('.user-search-dialog-list img')
    expect(img).not.toBeNull()
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('width')).toBe('32')
    expect(img.getAttribute('height')).toBe('32')
  })
})

describe('UserSearchDialog avatar fallback', () => {
  it('renders the uploaded avatar when hasAvatar is set, ignoring avatarProviderUrl', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          users: [
            {
              id: 'user-1',
              name: 'User One',
              email: 'one@example.com',
              hasAvatar: true,
              avatarProviderUrl: 'https://provider.example/photo.jpg'
            }
          ],
          total: 1
        })
    })

    mountDialog()
    await flushPromises()

    const img = document.body.querySelector('.user-search-dialog-list img')
    expect(img.getAttribute('src')).toBe('/_user/user-1/avatar')
  })

  it('falls back to the provider avatar when there is no manual upload', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          users: [
            {
              id: 'user-1',
              name: 'User One',
              email: 'one@example.com',
              hasAvatar: false,
              avatarProviderUrl: 'https://provider.example/photo.jpg'
            }
          ],
          total: 1
        })
    })

    mountDialog()
    await flushPromises()

    const img = document.body.querySelector('.user-search-dialog-list img')
    expect(img.getAttribute('src')).toBe('https://provider.example/photo.jpg')
  })

  it('falls back to the generic plate when neither avatar exists', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          users: [{ id: 'user-1', name: 'User One', email: 'one@example.com' }],
          total: 1
        })
    })

    mountDialog()
    await flushPromises()

    expect(document.body.querySelector('.user-search-dialog-list img')).toBeNull()
  })
})

describe('UserSearchDialog excludeUserIds', () => {
  it('hides the excluded user from the results', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          users: [
            { id: 'user-1', name: 'User One', email: 'one@example.com' },
            { id: 'user-2', name: 'User Two', email: 'two@example.com' }
          ],
          total: 2
        })
    })

    const wrapper = mountDialog({ excludeUserIds: ['user-1'] })
    await flushPromises()

    expect(wrapper.vm.state.users.map((usr) => usr.id)).toEqual(['user-2'])
  })
})
