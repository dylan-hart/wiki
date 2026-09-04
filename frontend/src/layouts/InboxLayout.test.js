import { describe, expect, it, vi } from 'vitest'

import InboxLayout from './InboxLayout.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Regression coverage for OpenProject #2000: the rail used to have a first "Inbox" entry pointing at
 * `/_inbox/messages` (an entirely static stub, deleted alongside this) and a separate "Watching" entry
 * pointing at `/_inbox/watching` (the actual notification list). With `messages` gone, the first entry
 * is repointed at `watching` instead of being left dangling -- which also means the old, now-redundant
 * second entry for the same page is gone, not duplicated alongside it.
 */

const messages = {
  common: {
    actions: {
      close: 'Close'
    }
  },
  inbox: {
    title: 'Inbox',
    inbox: 'Inbox',
    pendingReview: 'Pending Review'
  }
}

async function mountInboxLayout() {
  const router = await createTestRouter(
    [
      '/login',
      { path: '/_inbox/:path(.*)', component: { template: '<router-view />' } }, // -> Stand-in for whatever the reader was previously viewing (an admin page, a wiki page, home)
      //    so a captured "Go Back" push resolves to a real route instead of warning on no match.
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
    ],
    '/_inbox/watching'
  )

  return mountWithApp(InboxLayout, {
    messages,
    router,
    stores: {
      user: (store) => {
        store.$patch({ authenticated: true })
      }
    },
    stubs: {
      // -> `w-dialog` teleports its panel to `document.body`; explicit here since supplying any
      //    `stubs` to `mountWithApp` replaces its own `{ teleport: true }` default rather than
      //    merging with it -- this keeps the dialog's markup inline and findable off `wrapper`.
      teleport: true,
      HeaderNav: true,
      MainOverlayDialog: true
    }
  }).wrapper
}

describe('InboxLayout sidenav', () => {
  it('renders exactly two rail entries, not three', async () => {
    const wrapper = await mountInboxLayout()

    expect(wrapper.vm.sidenav).toHaveLength(2)
  })

  it('repoints the first entry at /_inbox/watching instead of the deleted /_inbox/messages', async () => {
    const wrapper = await mountInboxLayout()

    const firstItem = wrapper.vm.sidenav[0]
    expect(firstItem.key).toBe('watching')
    expect(firstItem.label).toBe('Inbox')
  })

  it('does not duplicate a second entry for the watching page', async () => {
    const wrapper = await mountInboxLayout()

    const watchingEntries = wrapper.vm.sidenav.filter((item) => item.key === 'watching')
    expect(watchingEntries).toHaveLength(1)
  })

  it('keeps the pending-review entry as the second item', async () => {
    const wrapper = await mountInboxLayout()

    expect(wrapper.vm.sidenav[1].key).toBe('review')
  })
})

/**
 * OpenProject #2334: clicking the bell in HeaderNav drops a reader into the Inbox with no way back to
 * whatever page or admin area they were previously viewing. `InboxLayout` now captures the route the
 * reader arrived from, once, on mount -- and offers it back as a Close action.
 *
 * OpenProject #2415 moved that button out of the rail and into a FileManager-style header band (the
 * same `.card-header` + white/grey-7 push-button idiom FileManager uses for its own Close button), so
 * the rail now holds only the two section entries and these assertions target the header instead.
 *
 * OpenProject #2502: the button itself now reads "Close" (`common.actions.close`), not "Go Back" --
 * this is a real `WDialog`, not a hand-rolled page standing in for one -- but the destination it closes
 * TO is unchanged: the route captured on entry, exactly as "Go Back" used to return to.
 */
describe('InboxLayout close affordance', () => {
  it('renders a "Close" button in the header, not the rail', async () => {
    window.history.pushState({ back: '/admin/dashboard' }, '', '/_inbox/watching')

    const wrapper = await mountInboxLayout()
    const railLabels = wrapper.findAll('.layout-inbox-sd .w-item-label').map((el) => el.text())
    const headerButton = wrapper.find('.layout-inbox-hdr [aria-label="Close"]')

    expect(railLabels).not.toContain('Close')
    expect(headerButton.exists()).toBe(true)
  })

  it('returns to the route captured on entry, not wherever the reader is inside the inbox', async () => {
    window.history.pushState({ back: '/admin/dashboard' }, '', '/_inbox/watching')

    const wrapper = await mountInboxLayout()
    const router = wrapper.vm.$router

    // Simulate switching inbox tabs internally -- this must not overwrite the captured return path.
    await router.push('/_inbox/review')

    const pushSpy = vi.spyOn(router, 'push')
    await wrapper.vm.close()

    expect(pushSpy).toHaveBeenCalledWith('/admin/dashboard')
  })

  it('falls back to home when there is no captured browser history (e.g. a bookmarked/emailed link)', async () => {
    window.history.pushState(null, '', '/_inbox/watching')

    const wrapper = await mountInboxLayout()
    const router = wrapper.vm.$router
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.vm.close()

    expect(pushSpy).toHaveBeenCalledWith('/')
  })
})

/**
 * OpenProject #2502: the inbox is now a real `WDialog` (blurred backdrop, comfortably smaller than
 * `MainOverlayDialog`'s full-width/full-height FileManager-style overlays), not a plain routed page --
 * assert the dialog markup that makes it one is actually there.
 */
describe('InboxLayout modal dialog chrome', () => {
  it('renders its content through a WDialog panel, with a blurred backdrop', async () => {
    const wrapper = await mountInboxLayout()

    expect(wrapper.find('.layout-inbox.w-dialog-root--open').exists()).toBe(true)
    expect(wrapper.find('.w-dialog-backdrop').exists()).toBe(true)
    expect(wrapper.find('.w-dialog-panel .layout-inbox-card').exists()).toBe(true)
  })

  it('is not persistent, so dismissing the dialog (Escape/backdrop click) closes it the same way as the Close button', async () => {
    window.history.pushState({ back: '/admin/dashboard' }, '', '/_inbox/watching')

    const wrapper = await mountInboxLayout()
    const router = wrapper.vm.$router
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('.w-dialog-backdrop').trigger('click')

    expect(pushSpy).toHaveBeenCalledWith('/admin/dashboard')
  })
})
