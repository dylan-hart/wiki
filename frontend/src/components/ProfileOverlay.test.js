import { beforeEach, describe, expect, it, vi } from 'vitest'

import ProfileOverlay from './ProfileOverlay.vue'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2532: Profile becomes a true `MainOverlayDialog` entry -- local `ref`/`reactive`
 * section state instead of `/_profile/:section` child routes, following the same
 * `defineAsyncComponent` pattern `FileManager.vue`/`NavEditOverlay.vue` use for the initial state
 * `overlayOpts` prop `MainOverlayDialog.vue` forwards (OpenProject #2530).
 *
 * `window.matchMedia` is stubbed matching wide throughout (same idiom as `HeaderNav.test.js`) so the
 * section rail renders as a column rather than the below-900px disclosure -- that responsive toggle
 * is unchanged carry-over behavior from the old `ProfileLayout.vue`, not something this WP touches,
 * and `useMinWidth`'s shared per-breakpoint `matchMedia` cache (`composables/screen.js`) makes
 * exercising both states reliably within one file more trouble than it is worth here (see
 * `components/shared/WDrawer.test.js`'s own note on the same cache).
 */
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
})

const MESSAGES = {
  common: {
    actions: { close: 'Close' },
    header: { logout: 'Log Out' }
  },
  profile: {
    title: 'Profile',
    identity: 'About Me',
    avatar: 'Avatar',
    auth: 'Login & Security',
    groups: 'Groups',
    api: { title: 'API Keys' },
    notifications: 'Notifications',
    activity: 'Activity',
    viewPublicProfile: 'View public profile'
  }
}

function mountOverlay(overlayOpts, { experimental = false } = {}) {
  return mountWithApp(ProfileOverlay, {
    props: overlayOpts ? { overlayOpts } : {},
    messages: MESSAGES,
    stores: {
      user: (store) => store.$patch({ id: 'user-1', authenticated: true }),
      flags: (store) => {
        store.experimental = experimental
      }
    }
  })
}

describe('ProfileOverlay initial section (OpenProject #2530/#2532)', () => {
  it('defaults to the info section when no overlayOpts is given', () => {
    const { wrapper } = mountOverlay()

    expect(wrapper.vm.state.section).toBe('info')
  })

  it("reads overlayOpts.section for a specific opener (e.g. AdminApi's personal-token note)", () => {
    const { wrapper } = mountOverlay({ section: 'api' })

    expect(wrapper.vm.state.section).toBe('api')
  })

  it('falls back to info for an unknown or unsupported section key', () => {
    const { wrapper } = mountOverlay({ section: 'bogus' })

    expect(wrapper.vm.state.section).toBe('info')
  })
})

describe('ProfileOverlay section rail', () => {
  it('switches state.section, and closes the disclosure, when a rail item is clicked', async () => {
    const { wrapper } = mountOverlay()

    const avatarItem = wrapper
      .findAll('.layout-profile-sd .w-item')
      .find((item) => item.text().includes('Avatar'))
    await avatarItem.trigger('click')

    expect(wrapper.vm.state.section).toBe('avatar')
    expect(wrapper.vm.state.navOpen).toBe(false)
  })

  it('marks the current section active in the rail', async () => {
    const { wrapper } = mountOverlay({ section: 'groups' })

    const groupsItem = wrapper
      .findAll('.layout-profile-sd .w-item')
      .find((item) => item.text().includes('Groups'))

    expect(groupsItem.classes()).toContain('is-active')
  })

  /**
   * OpenProject #2721: "Identity" becomes "About Me" with `tabler:id`, Avatar draws `tabler:photo`,
   * API Access draws `tabler:api` -- pinning the rail's label/icon pairs so a future icon swap has
   * to touch this test deliberately, not drift silently. `data-icon` is `WIcon.vue`'s own hook for
   * exactly this (see its template comment): the rendered `<svg>`/`<iconify-icon>` is otherwise
   * anonymous DOM with no `icon` attribute to read.
   */
  it('pins the rail label/icon pairs, including the info/avatar/api trio from OpenProject #2721', () => {
    const { wrapper } = mountOverlay()

    const iconFor = (label) =>
      wrapper
        .findAll('.layout-profile-sd .w-item')
        .find((item) => item.text().includes(label))
        .find('[data-icon]')
        .attributes('data-icon')

    expect(iconFor('About Me')).toBe('tabler:id')
    expect(iconFor('Avatar')).toBe('tabler:photo')
    expect(iconFor('Login & Security')).toBe('tabler:key')
    expect(iconFor('Groups')).toBe('tabler:users')
    expect(iconFor('API Keys')).toBe('tabler:api')
    expect(iconFor('Notifications')).toBe('tabler:bell')
  })

  it('renders the Activity row disabled, and hides it unless flagsStore.experimental', () => {
    const hidden = mountOverlay(undefined, { experimental: false })
    expect(hidden.wrapper.text()).not.toContain('Activity')

    const shown = mountOverlay(undefined, { experimental: true })
    const activityItem = shown.wrapper
      .findAll('.layout-profile-sd .w-item')
      .find((item) => item.text().includes('Activity'))
    expect(activityItem.exists()).toBe(true)
    expect(activityItem.attributes('aria-disabled')).toBe('true')
  })

  it('hides "view public profile" unless flagsStore.experimental, closing the overlay when clicked', async () => {
    const hidden = mountOverlay(undefined, { experimental: false })
    expect(hidden.wrapper.text()).not.toContain('View public profile')

    const { wrapper, siteStore } = mountOverlay(undefined, { experimental: true })
    siteStore.overlay = 'Profile'
    const viewProfileItem = wrapper
      .findAll('.layout-profile-sd .w-item')
      .find((item) => item.text().includes('View public profile'))
    await viewProfileItem.trigger('click')

    expect(siteStore.overlay).toBe('')
  })
})

describe('ProfileOverlay close / logout', () => {
  it('clears siteStore.overlay when the header Close button is clicked', async () => {
    const { wrapper, siteStore } = mountOverlay()
    siteStore.overlay = 'Profile'

    await wrapper.find('.layout-profile-hdr [aria-label="Close"]').trigger('click')

    expect(siteStore.overlay).toBe('')
  })

  it('closes the overlay and logs out when the Logout row is clicked', async () => {
    const { wrapper, siteStore, userStore } = mountOverlay()
    siteStore.overlay = 'Profile'
    const logoutSpy = vi.spyOn(userStore, 'logout')

    const logoutItem = wrapper
      .findAll('.layout-profile-sd .w-item')
      .find((item) => item.text().includes('Log Out'))
    await logoutItem.trigger('click')

    expect(siteStore.overlay).toBe('')
    expect(logoutSpy).toHaveBeenCalled()
  })

  it('clears siteStore.overlayOpts on unmount, same as NavEditOverlay/TableEditorOverlay', () => {
    const { wrapper, siteStore } = mountOverlay({ section: 'api' })
    siteStore.overlayOpts = { section: 'api' }

    wrapper.unmount()

    expect(siteStore.overlayOpts).toEqual({})
  })
})

/**
 * OpenProject #2543 follow-up: `.layout-profile-card` (which declares `height: 100%` to fill
 * whatever `MainOverlayDialog`'s `<w-dialog>` panel gives it -- see its own comment) used to sit one
 * level *inside* a second, entirely unstyled `<div class="layout-profile">` wrapper. That wrapper was
 * the component's real template root and therefore the actual direct flex child of the dialog panel;
 * with no height or flex properties of its own, it sized to its own content instead of the panel,
 * which broke `.layout-profile-card`'s `height: 100%` (a percentage against a parent whose own height
 * is not definite resolves to `auto`) and, with it, the fixed header / independently-scrollable-panes
 * layout entirely -- confirmed against a real headless Chromium render, since jsdom does not run a
 * layout engine and would report a plausible-looking but meaningless height for either div.
 *
 * `wrapper.element` -- the component's own single DOM root, not a container `mount()` invented -- is
 * `.layout-profile-card` directly, which is what proves the dead wrapper is gone rather than just
 * moved.
 */
it('has no dead outer wrapper -- .layout-profile-card is the component root', () => {
  const { wrapper } = mountOverlay()

  expect(wrapper.element.className).toContain('layout-profile-card')
  expect(wrapper.find('.layout-profile').exists()).toBe(false)
})
