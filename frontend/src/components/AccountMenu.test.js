import { describe, expect, it } from 'vitest'

import AccountMenu from './AccountMenu.vue'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2532: the Profile button opens `MainOverlayDialog`'s `Profile` entry rather than
 * navigating to the now-deleted `/_profile` route.
 */
describe('AccountMenu profile button', () => {
  it("opens the Profile overlay instead of navigating to '/_profile'", async () => {
    const { wrapper, siteStore } = mountWithApp(AccountMenu, {
      messages: {
        common: { header: { profile: 'Profile', logout: 'Log Out', account: 'Account' } }
      },
      stores: {
        user: (store) =>
          store.$patch({ authenticated: true, name: 'Reader', email: 'r@example.com' })
      }
    })

    // -> WMenu's real trigger click listener is attached to the enclosing button natively, so a
    //    plain DOM click on it opens the (teleported-but-inline-stubbed) menu content -- see
    //    `composables/anchoredFloat.js`/`WMenu.vue`.
    await wrapper.find('.account-avbtn').trigger('click')

    const profileBtn = wrapper.findAll('button').find((b) => b.text() === 'Profile')
    await profileBtn.trigger('click')

    expect(siteStore.overlay).toBe('Profile')
  })
})

/**
 * OpenProject #2609: the rule itself is `helpers/initials.js`'s and is unit-tested there; this is the
 * wiring — that the plate a signed-in reader sees is drawn from the shared derivation and not from a
 * fourth private copy of it.
 */
describe('AccountMenu initials plate', () => {
  function mountFor(name) {
    const { wrapper } = mountWithApp(AccountMenu, {
      messages: {
        common: { header: { profile: 'Profile', logout: 'Log Out', account: 'Account' } }
      },
      stores: {
        user: (store) => store.$patch({ authenticated: true, name, email: 'r@example.com' })
      }
    })
    return wrapper.find('.account-initials')
  }

  it('draws the first and last initial of a multi-part name', () => {
    expect(mountFor('Dylan James Hart').text()).toBe('DH')
    expect(mountFor('Ada Lovelace').text()).toBe('AL')
  })

  it('draws a single letter for a mononym', () => {
    expect(mountFor('Prince').text()).toBe('P')
  })

  it('falls back to a neutral glyph for an account with no name on it', () => {
    expect(mountFor('').text()).toBe('?')
  })
})
