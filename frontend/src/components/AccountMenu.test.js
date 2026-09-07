import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * OpenProject #2787: Profile and Logout should each fill exactly half of the actions row -- flush to
 * the outer edges and to a shared middle divider -- instead of sitting centered with a gap the way
 * `WCardActions`' shared default lays out every OTHER caller's confirm/cancel pair, and Logout should
 * render in Cardinal's branded `negative` token rather than a plain Quasar `red`.
 *
 * The color swap is asserted against the real DOM, since `WBtn` writes it as a concrete inline
 * style. The fill layout is asserted against the component's own declared CSS rather than a rendered
 * box: happy-dom runs no layout engine and does not resolve percentage-based flex sizing (see
 * `BlueprintIcon.test.js`'s plate-size suite and `NavSidebar.test.js`'s flex/border checks for the
 * established precedent of a static source check for exactly this kind of assertion).
 */
describe('AccountMenu actions row (OpenProject #2787)', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'AccountMenu.vue'),
    'utf-8'
  )
  const styleBlock = source.slice(source.indexOf('<style'), source.lastIndexOf('</style>'))

  function mountMenu() {
    return mountWithApp(AccountMenu, {
      messages: {
        common: { header: { profile: 'Profile', logout: 'Log Out', account: 'Account' } }
      },
      stores: {
        user: (store) =>
          store.$patch({ authenticated: true, name: 'Reader', email: 'r@example.com' })
      }
    }).wrapper
  }

  it('renders Logout in the branded negative color, not the old plain red', async () => {
    const wrapper = mountMenu()
    await wrapper.find('.account-avbtn').trigger('click')

    const logoutBtn = wrapper.findAll('button').find((b) => b.text() === 'Log Out')

    expect(logoutBtn.attributes('style')).toContain('--color-negative')
    expect(logoutBtn.attributes('style')).not.toContain('--color-red')
  })

  it("keeps Profile on Cardinal's primary color", async () => {
    const wrapper = mountMenu()
    await wrapper.find('.account-avbtn').trigger('click')

    const profileBtn = wrapper.findAll('button').find((b) => b.text() === 'Profile')

    expect(profileBtn.attributes('style')).toContain('--color-primary')
  })

  it('zeroes out the inherited WCardActions padding/gap so the pair fills the row edge-to-edge', () => {
    const containerRule = styleBlock.match(/\.account-actions\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    expect(containerRule).toMatch(/padding:\s*0/)
    expect(containerRule).toMatch(/gap:\s*0/)
  })

  it('gives each action button exactly half the row', () => {
    const btnRule =
      styleBlock.match(/\.account-actions\s+\.account-actions-btn\s*\{([\s\S]*?)\}/)?.[1] ?? ''
    expect(btnRule).toMatch(/flex:\s*1\s+1\s+50%/)
    expect(btnRule).toMatch(/width:\s*50%/)
  })

  it('draws the shared middle divider on the Logout button', () => {
    expect(source).toMatch(/account-actions-btn border-l border-hairline dark:border-hairline-dark/)
  })

  it('does not reintroduce WCardActions.vue changes for this fix', () => {
    const wCardActionsSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'shared', 'WCardActions.vue'),
      'utf-8'
    )
    expect(wCardActionsSource).toMatch(/justify-center/)
    expect(wCardActionsSource).not.toMatch(/account-actions/)
  })
})
