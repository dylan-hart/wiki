import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import HeaderActionsMenu from './HeaderActionsMenu.vue'
import { mountWithApp } from '../../test/mount.js'

describe('HeaderActionsMenu profile row', () => {
  it("opens the Profile overlay instead of navigating to '/_profile'", async () => {
    const { wrapper, siteStore } = mountWithApp(HeaderActionsMenu, {
      messages: {
        common: {
          header: { profile: 'Profile', logout: 'Log Out', moreActions: 'More actions' }
        }
      },
      stores: {
        user: (store) => store.$patch({ authenticated: true })
      }
    })

    // -> `WMenu` attaches its trigger listener to the enclosing button natively, so a plain DOM
    //    click opens the (teleported-but-inline-stubbed) menu content.
    await wrapper.find('[aria-label="More actions"]').trigger('click')

    const profileRow = wrapper
      .findAll('.w-item')
      .find((item) => item.text().includes('Profile') && !item.text().includes('Log Out'))
    await profileRow.trigger('click')

    expect(siteStore.overlay).toBe('Profile')
  })
})

describe('HeaderActionsMenu avatar fallback', () => {
  async function openMenu({ hasAvatar = false, avatarProviderUrl = null } = {}) {
    const { wrapper } = mountWithApp(HeaderActionsMenu, {
      messages: {
        common: { header: { moreActions: 'More actions' } }
      },
      stores: {
        user: (store) => store.$patch({ authenticated: true, hasAvatar, avatarProviderUrl })
      }
    })
    await wrapper.find('[aria-label="More actions"]').trigger('click')
    return wrapper
  }

  it('renders the uploaded avatar when hasAvatar is set, ignoring avatarProviderUrl', async () => {
    const wrapper = await openMenu({
      hasAvatar: true,
      avatarProviderUrl: 'https://provider.example/photo.jpg'
    })

    expect(wrapper.find('.w-item img').attributes('src')).toBe('/_user/current/avatar')
  })

  it('falls back to the provider avatar when there is no manual upload', async () => {
    const wrapper = await openMenu({
      hasAvatar: false,
      avatarProviderUrl: 'https://provider.example/photo.jpg'
    })

    expect(wrapper.find('.w-item img').attributes('src')).toBe('https://provider.example/photo.jpg')
  })

  it('falls back to the generic glyph when neither avatar exists', async () => {
    const wrapper = await openMenu()

    expect(wrapper.find('.w-item img').exists()).toBe(false)
  })
})

describe('HeaderActionsMenu quick note row', () => {
  async function openMenu({ authenticated = true, notes } = {}) {
    const { wrapper, router } = mountWithApp(HeaderActionsMenu, {
      routes: ['/', '/_notes'],
      messages: {
        common: { header: { moreActions: 'More actions', quickNote: 'Quick Note' } }
      },
      stores: {
        user: (store) => store.$patch({ authenticated }),
        site: (store) => {
          if (notes !== undefined) {
            store.features.notes = notes
          }
        }
      }
    })
    await router.isReady()
    await wrapper.find('[aria-label="More actions"]').trigger('click')
    return { wrapper, router }
  }

  function quickNoteRow(wrapper) {
    return wrapper.findAll('.w-item').find((item) => item.text().includes('Quick Note'))
  }

  it('opens /_notes with a new note', async () => {
    const { wrapper, router } = await openMenu()

    const row = quickNoteRow(wrapper)
    expect(row.find('[data-icon="tabler:note"]').exists()).toBe(true)
    await row.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/_notes?new=1')
  })

  it('is absent for a guest', async () => {
    const { wrapper } = await openMenu({ authenticated: false })

    expect(quickNoteRow(wrapper)).toBeUndefined()
  })

  it('is absent when the site turns notes off', async () => {
    const { wrapper } = await openMenu({ notes: false })

    expect(quickNoteRow(wrapper)).toBeUndefined()
  })
})
