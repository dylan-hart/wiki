import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ProfileOverlay from './ProfileOverlay.vue'
import { mountWithApp } from '../../test/mount.js'
import { openProfilePopover } from '@/composables/profilePopover'
import { isSavingVisible, pendingProfileSaves } from '@/composables/profileSaving'

vi.mock('@/composables/profilePopover', () => ({
  openProfilePopover: vi.fn(),
  closeProfilePopover: vi.fn()
}))

/**
 * `window.matchMedia` is stubbed matching wide throughout, so the section rail renders as a column
 * rather than the narrow-viewport disclosure: `useMinWidth`'s shared per-breakpoint `matchMedia`
 * cache (`composables/screen.js`) makes exercising both states reliably within one file more
 * trouble than it is worth.
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
    preferences: 'Preferences',
    avatar: 'Avatar',
    auth: 'Login & Security',
    groups: 'Groups',
    api: { title: 'API Keys' },
    notifications: 'Notifications',
    activity: 'Activity',
    previewPublicProfile: 'Preview public profile',
    closeDisabledLabel: 'Saving...'
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
  it('defaults to the preferences section when no overlayOpts is given', () => {
    const { wrapper } = mountOverlay()

    expect(wrapper.vm.state.section).toBe('preferences')
  })

  it("reads overlayOpts.section for a specific opener (e.g. AdminApi's personal-token note)", () => {
    const { wrapper } = mountOverlay({ section: 'api' })

    expect(wrapper.vm.state.section).toBe('api')
  })

  it('falls back to preferences for an unknown or unsupported section key', () => {
    const { wrapper } = mountOverlay({ section: 'bogus' })

    expect(wrapper.vm.state.section).toBe('preferences')
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
   * `data-icon` is `WIcon.vue`'s own hook for this: the rendered `<svg>`/`<iconify-icon>` is
   * otherwise anonymous DOM with no `icon` attribute to read.
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
    expect(iconFor('Preferences')).toBe('tabler:adjustments')
    expect(iconFor('Avatar')).toBe('tabler:photo')
    expect(iconFor('Login & Security')).toBe('tabler:key')
    expect(iconFor('Groups')).toBe('tabler:users')
    expect(iconFor('API Keys')).toBe('tabler:api')
    expect(iconFor('Notifications')).toBe('tabler:bell')
  })

  it('places the Preferences entry right after About Me, before Avatar', () => {
    const { wrapper } = mountOverlay()

    const labels = wrapper
      .findAll('.layout-profile-sd .w-item')
      .map((item) => item.find('.w-item-label').text())

    const aboutMeIndex = labels.indexOf('About Me')
    const preferencesIndex = labels.indexOf('Preferences')
    const avatarIndex = labels.indexOf('Avatar')
    expect(preferencesIndex).toBe(aboutMeIndex + 1)
    expect(avatarIndex).toBe(preferencesIndex + 1)
  })

  it('switches to the preferences section when its rail item is clicked', async () => {
    const { wrapper } = mountOverlay()

    const preferencesItem = wrapper
      .findAll('.layout-profile-sd .w-item')
      .find((item) => item.text().includes('Preferences'))
    await preferencesItem.trigger('click')

    expect(wrapper.vm.state.section).toBe('preferences')
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

  describe('preview public profile', () => {
    const findItem = (wrapper) =>
      wrapper
        .findAll('.layout-profile-sd .w-item')
        .find((item) => item.text().includes('Preview public profile'))

    beforeEach(() => {
      vi.mocked(openProfilePopover).mockClear()
      pendingProfileSaves.value = 0
    })

    afterEach(() => {
      document.body.innerHTML = ''
    })

    it('is hidden unless flagsStore.experimental', () => {
      const { wrapper } = mountOverlay(undefined, { experimental: false })

      expect(wrapper.text()).not.toContain('Preview public profile')
    })

    it('is a button rather than a link to a /_user/ route', () => {
      const { wrapper } = mountOverlay(undefined, { experimental: true })

      const item = findItem(wrapper)
      expect(item.exists()).toBe(true)
      expect(item.attributes('href')).toBeUndefined()
      expect(wrapper.html()).not.toContain('/_user/user-1')
    })

    it('closes the overlay, then opens the popover for the current user at the header account button', async () => {
      const accountButton = document.createElement('button')
      accountButton.className = 'account-avbtn'
      document.body.append(accountButton)
      const { wrapper, siteStore } = mountOverlay(undefined, { experimental: true })
      siteStore.overlay = 'Profile'

      await findItem(wrapper).trigger('click')
      await flushPromises()

      expect(siteStore.overlay).toBe('')
      expect(openProfilePopover).toHaveBeenCalledTimes(1)
      expect(openProfilePopover).toHaveBeenCalledWith({ userId: 'user-1', anchor: accountButton })
    })

    it('falls back to document.body when there is no header account button', async () => {
      const { wrapper } = mountOverlay(undefined, { experimental: true })

      await findItem(wrapper).trigger('click')
      await flushPromises()

      expect(openProfilePopover).toHaveBeenCalledWith({ userId: 'user-1', anchor: document.body })
    })

    it('is disabled while a profile save is pending, so the preview cannot show stale visibility', async () => {
      const { wrapper, siteStore } = mountOverlay(undefined, { experimental: true })
      siteStore.overlay = 'Profile'
      pendingProfileSaves.value = 1
      await wrapper.vm.$nextTick()

      const item = findItem(wrapper)
      expect(item.attributes('aria-disabled')).toBe('true')
      await item.trigger('click')
      await flushPromises()

      expect(siteStore.overlay).toBe('Profile')
      expect(openProfilePopover).not.toHaveBeenCalled()
    })
  })
})

describe('ProfileOverlay close / logout', () => {
  beforeEach(() => {
    pendingProfileSaves.value = 0
    isSavingVisible.value = false
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears siteStore.overlay when the header Close button is clicked', async () => {
    const { wrapper, siteStore } = mountOverlay()
    siteStore.overlay = 'Profile'

    await wrapper.find('.layout-profile-hdr [aria-label="Close"]').trigger('click')

    expect(siteStore.overlay).toBe('')
  })

  it('disables the Close button and swaps its label once a save has been pending for 500ms', async () => {
    const { wrapper, siteStore } = mountOverlay()
    siteStore.overlay = 'Profile'
    pendingProfileSaves.value = 1
    await vi.advanceTimersByTimeAsync(500)
    await wrapper.vm.$nextTick()

    const closeButton = wrapper.find('.layout-profile-hdr [aria-label="Saving..."]')
    expect(closeButton.exists()).toBe(true)
    expect(closeButton.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.layout-profile-hdr [aria-label="Close"]').exists()).toBe(false)

    await closeButton.trigger('click')
    expect(siteStore.overlay).toBe('Profile')
  })

  it('never shows the Saving indicator for a save that settles within 500ms', async () => {
    const { wrapper, siteStore } = mountOverlay()
    siteStore.overlay = 'Profile'
    pendingProfileSaves.value = 1
    await vi.advanceTimersByTimeAsync(300)
    pendingProfileSaves.value = 0
    await vi.advanceTimersByTimeAsync(300)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.layout-profile-hdr [aria-label="Close"]').exists()).toBe(true)
    expect(wrapper.find('.layout-profile-hdr [aria-label="Saving..."]').exists()).toBe(false)
  })

  it('re-enables the Close button and restores its label the instant the pending count drops to zero', async () => {
    const { wrapper, siteStore } = mountOverlay()
    siteStore.overlay = 'Profile'
    pendingProfileSaves.value = 1
    await vi.advanceTimersByTimeAsync(500)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.layout-profile-hdr [aria-label="Saving..."]').exists()).toBe(true)

    pendingProfileSaves.value = 0
    await wrapper.vm.$nextTick()

    const closeButton = wrapper.find('.layout-profile-hdr [aria-label="Close"]')
    expect(closeButton.exists()).toBe(true)
    expect(closeButton.attributes('disabled')).toBeUndefined()

    await closeButton.trigger('click')
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
 * `.layout-profile-card` declares `height: 100%` against whatever `MainOverlayDialog`'s dialog panel
 * gives it, so an unstyled wrapper div between the two resolves that to `auto` and collapses the
 * fixed-header / scrollable-panes layout. `wrapper.element` is the component's own single DOM root,
 * which is what proves no such wrapper is there.
 */
it('has no dead outer wrapper -- .layout-profile-card is the component root', () => {
  const { wrapper } = mountOverlay()

  expect(wrapper.element.className).toContain('layout-profile-card')
  expect(wrapper.find('.layout-profile').exists()).toBe(false)
})

/**
 * The card is the dialog panel's direct child (proved above), so it inherits the panel's radius and
 * rounds the same curve twice under Cobalt -- its own clip behind the header's rounded fill -- which
 * leaves a fringe. A source-text scan, matching `SideDialog.test.js`'s convention for this class of
 * Cobalt-only fix: nothing here renders real Chromium layout, and neither DOM stand-in would show it.
 */
describe('ProfileOverlay Cobalt card fringe (OpenProject #2895)', () => {
  const source = readFileSync(join(import.meta.dirname, 'ProfileOverlay.vue'), 'utf-8')
  const styleBlock = source.slice(source.indexOf('<style'), source.indexOf('</style>'))
  const cardBlock = styleBlock.slice(
    styleBlock.indexOf('.layout-profile-card {'),
    styleBlock.indexOf('.layout-profile-hdr {')
  )

  it('stops the card clipping or filling itself under Cobalt', () => {
    expect(cardBlock).toMatch(
      /\.body--cobalt & {[^}]*overflow: visible;[^}]*background: transparent;/s
    )
  })

  it('places the Cobalt override after the light/dark fills, so it wins the specificity tie', () => {
    const cobaltIndex = cardBlock.indexOf('.body--cobalt &')
    const lightIndex = cardBlock.indexOf('.body--light &')
    const darkIndex = cardBlock.indexOf('.body--dark &')
    expect(cobaltIndex).toBeGreaterThan(lightIndex)
    expect(cobaltIndex).toBeGreaterThan(darkIndex)
  })

  it('leaves the unconditional overflow: hidden in place -- Ledger still needs the clip', () => {
    const beforeCobalt = cardBlock.slice(0, cardBlock.indexOf('.body--cobalt &'))
    expect(beforeCobalt).toMatch(/overflow: hidden;/)
  })
})
