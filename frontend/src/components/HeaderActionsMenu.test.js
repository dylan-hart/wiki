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
