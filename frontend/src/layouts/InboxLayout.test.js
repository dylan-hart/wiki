import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import InboxLayout from './InboxLayout.vue'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

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
      goback: 'Go Back'
    }
  },
  inbox: {
    title: 'Inbox',
    inbox: 'Inbox',
    pendingReview: 'Pending Review'
  }
}

async function mountInboxLayout() {
  setActivePinia(createPinia())
  const userStore = useUserStore()
  userStore.$patch({ authenticated: true })

  const router = await createTestRouter(
    [
      '/login',
      { path: '/_inbox/:path(.*)', component: { template: '<router-view />' } }, // -> Stand-in for whatever the reader was previously viewing (an admin page, a wiki page, home)
      //    so a captured "Go Back" push resolves to a real route instead of warning on no match.
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } }
    ],
    '/_inbox/watching'
  )

  const i18n = createTestI18n(messages)

  return mount(InboxLayout, {
    global: {
      plugins: [router, i18n],
      stubs: {
        HeaderNav: true,
        MainOverlayDialog: true
      }
    }
  })
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
 * reader arrived from, once, on mount -- and offers it back as a "Go Back" rail entry.
 */
describe('InboxLayout go-back affordance', () => {
  it('renders a "Go Back" entry ahead of the existing rail items', async () => {
    window.history.pushState({ back: '/admin/dashboard' }, '', '/_inbox/watching')

    const wrapper = await mountInboxLayout()
    const labels = wrapper.findAll('.layout-inbox-sd .w-item-label').map((el) => el.text())

    expect(labels[0]).toBe('Go Back')
  })

  it('returns to the route captured on entry, not wherever the reader is inside the inbox', async () => {
    window.history.pushState({ back: '/admin/dashboard' }, '', '/_inbox/watching')

    const wrapper = await mountInboxLayout()
    const router = wrapper.vm.$router

    // Simulate switching inbox tabs internally -- this must not overwrite the captured return path.
    await router.push('/_inbox/review')

    const pushSpy = vi.spyOn(router, 'push')
    await wrapper.vm.goBack()

    expect(pushSpy).toHaveBeenCalledWith('/admin/dashboard')
  })

  it('falls back to home when there is no captured browser history (e.g. a bookmarked/emailed link)', async () => {
    window.history.pushState(null, '', '/_inbox/watching')

    const wrapper = await mountInboxLayout()
    const router = wrapper.vm.$router
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.vm.goBack()

    expect(pushSpy).toHaveBeenCalledWith('/')
  })
})
