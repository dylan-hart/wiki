import { describe, expect, it } from 'vitest'

import HeaderActionsMenu from './HeaderActionsMenu.vue'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2532: the Profile row opens `MainOverlayDialog`'s `Profile` entry (closing this menu
 * first, same as the New Page/File Manager rows) rather than navigating to the now-deleted
 * `/_profile` route.
 */
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

    // -> WMenu's real trigger click listener is attached to the enclosing button natively, so a
    //    plain DOM click on it opens the (teleported-but-inline-stubbed) menu content -- see
    //    `composables/anchoredFloat.js`/`WMenu.vue`.
    await wrapper.find('[aria-label="More actions"]').trigger('click')

    const profileRow = wrapper
      .findAll('.w-item')
      .find((item) => item.text().includes('Profile') && !item.text().includes('Log Out'))
    await profileRow.trigger('click')

    expect(siteStore.overlay).toBe('Profile')
  })
})

/**
 * Task #3264: a manually-uploaded avatar (`hasAvatar`) always wins; the provider-synced picture
 * (`avatarProviderUrl`) is only a fallback rendered in its place, and the generic glyph is the last
 * resort.
 */
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
