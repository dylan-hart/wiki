import { describe, expect, it, vi } from 'vitest'

import ProfileLayout from './ProfileLayout.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2510: Profile gets the same FileManager-dialog treatment #2502 gave Inbox -- a real
 * modal dialog (blurred backdrop) with a Close action, instead of the plain scrolling page this used
 * to be with no Close or Back affordance of any kind.
 */

const messages = {
  common: {
    actions: {
      close: 'Close'
    },
    header: {
      logout: 'Log Out'
    }
  },
  profile: {
    title: 'Profile',
    avatar: 'Avatar',
    auth: 'Login & Security',
    groups: 'Groups',
    api: {
      title: 'API Keys'
    },
    notifications: 'Notifications',
    activity: 'Activity'
  }
}

async function mountProfileLayout() {
  const router = await createTestRouter(
    [
      '/login',
      { path: '/_profile/:path(.*)', component: { template: '<router-view />' } }, // -> Stand-in for whatever the reader was previously viewing (a wiki page, admin, home) so a
      //    captured "Close" push resolves to a real route instead of warning on no match.
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
    ],
    '/_profile/info'
  )

  return mountWithApp(ProfileLayout, {
    messages,
    router,
    stores: {
      user: (store) => {
        store.$patch({ authenticated: true })
      }
    },
    stubs: {
      HeaderNav: true,
      MainOverlayDialog: true,
      // -> `mountWithApp`'s own `{ teleport: true }` default only applies when NO `stubs` object is
      //    passed at all -- supplying one for HeaderNav/MainOverlayDialog above silently drops it, so
      //    it has to be repeated here or `w-dialog`'s real `<teleport>` portals to `document.body`
      //    instead of rendering inline where `wrapper.find()` can see it (same footgun #2502 hit).
      teleport: true
    }
  }).wrapper
}

describe('ProfileLayout dialog chrome', () => {
  it('renders the dialog open, with the blurred backdrop', async () => {
    const wrapper = await mountProfileLayout()

    expect(wrapper.find('.layout-profile.w-dialog-root--open').exists()).toBe(true)
    // -> Descendant selector, not a child combinator: `wrapWithTransition`'s stub interposes an
    //    extra `<transition-stub>` node here under test, same as InboxLayout's own tests (the real
    //    `<transition>` is transparent in production, which is why the stylesheet itself keeps `>`).
    expect(wrapper.find('.layout-profile .w-dialog-backdrop').exists()).toBe(true)
  })

  it('renders a Close button in the header, not the rail', async () => {
    const wrapper = await mountProfileLayout()

    const railLabels = wrapper.findAll('.layout-profile-sd .w-item-label').map((el) => el.text())
    const headerButton = wrapper.find('.layout-profile-hdr [aria-label="Close"]')

    expect(railLabels).not.toContain('Close')
    expect(headerButton.exists()).toBe(true)
  })

  it('captures the route the reader arrived from and returns to it on Close', async () => {
    window.history.pushState({ back: '/some/wiki/page' }, '', '/_profile/info')

    const wrapper = await mountProfileLayout()
    const router = wrapper.vm.$router
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('.layout-profile-hdr [aria-label="Close"]').trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/some/wiki/page')
  })

  it('does not overwrite the captured return path when switching sections internally', async () => {
    window.history.pushState({ back: '/some/wiki/page' }, '', '/_profile/info')

    const wrapper = await mountProfileLayout()
    const router = wrapper.vm.$router

    await router.push('/_profile/avatar')

    const pushSpy = vi.spyOn(router, 'push')
    await wrapper.find('.layout-profile-hdr [aria-label="Close"]').trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/some/wiki/page')
  })

  it('falls back to home when there is no captured browser history (e.g. a bookmarked/emailed link)', async () => {
    window.history.pushState(null, '', '/_profile/info')

    const wrapper = await mountProfileLayout()
    const router = wrapper.vm.$router
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('.layout-profile-hdr [aria-label="Close"]').trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/')
  })

  it('closes to the captured return path on a non-persistent dismissal (backdrop click), same as Close', async () => {
    window.history.pushState({ back: '/some/wiki/page' }, '', '/_profile/info')

    const wrapper = await mountProfileLayout()
    const router = wrapper.vm.$router
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('.layout-profile .w-dialog-backdrop').trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/some/wiki/page')
  })
})

describe('ProfileLayout sidenav', () => {
  it('still renders the section rail inside the dialog', async () => {
    const wrapper = await mountProfileLayout()

    expect(wrapper.vm.sidenav.length).toBeGreaterThan(0)
    expect(wrapper.find('.layout-profile-sd').exists()).toBe(true)
  })
})
