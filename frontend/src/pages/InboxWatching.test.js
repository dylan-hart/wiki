import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import InboxWatching from './InboxWatching.vue'
import { useSiteStore } from '@/stores/site'
import { queue as notifyQueue } from '@/composables/notify'

/**
 * Task 535: the notifications section this page gained above the pre-existing watched-pages list.
 * `GET .../notifications` is asserted directly rather than through the (untouched, already-covered)
 * watching list beneath it.
 */

const NOTIFICATION = {
  id: 'notif-1',
  pageId: 'page-1',
  pageTitle: 'Some Page',
  pagePath: 'some/page',
  action: 'updated',
  changedFields: ['title'],
  actorId: 'user-1',
  actorName: 'Jane Actor',
  createdAt: '2026-08-17T12:00:00.000Z'
}

const messages = {
  en: {
    inbox: {
      notificationsTitle: 'Notifications',
      notificationsInfo: 'Changes to pages you watch, unread first.',
      notificationsNone: 'You have no unread notifications.',
      notificationsMarkRead: 'Mark as read',
      notificationsMarkReadFailed: 'Could not mark this notification as read.',
      notificationsLoadFailed: 'Failed to load your notifications.',
      notificationActionUpdated: '{actor} edited {title}',
      notificationActionMoved: '{actor} moved {title}',
      notificationActionDeleted: '{actor} deleted {title}',
      watching: 'Watching',
      watchingInfo: 'Pages you asked to be told about, most recently added first.',
      watchingNone: 'You are not watching any page yet.',
      watchingHint: 'Open a page and press the bell in its header to start watching it.',
      watchingLoadFailed: 'Failed to load your watched pages.'
    }
  }
}

async function mountInboxWatching() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.$patch({ id: 'site-1' })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/:path(.*)', component: { template: '<div />' } }
    ]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages })

  const wrapper = mount(InboxWatching, {
    global: { plugins: [router, i18n] }
  })
  await flushLoads()
  notifyQueue.splice(0, notifyQueue.length)
  return { wrapper, router }
}

async function flushLoads() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
})

describe('InboxWatching notifications', () => {
  it('lists unread notifications from GET .../notifications', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites/site-1/notifications') {
        return { json: () => Promise.resolve([NOTIFICATION]) }
      }
      return { json: () => Promise.resolve([]) }
    })

    const { wrapper } = await mountInboxWatching()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/notifications')
    expect(wrapper.text()).toContain('Jane Actor edited Some Page')
  })

  it('shows the empty state when there are no unread notifications', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))

    const { wrapper } = await mountInboxWatching()

    expect(wrapper.text()).toContain('You have no unread notifications.')
  })

  it('marking a notification read removes it from the list and notifies the header badge', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites/site-1/notifications') {
        return { json: () => Promise.resolve([NOTIFICATION]) }
      }
      return { json: () => Promise.resolve([]) }
    })
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    const { wrapper } = await mountInboxWatching()
    const changedHandler = vi.fn()
    EVENT_BUS.on('notificationsChanged', changedHandler)

    expect(wrapper.text()).toContain('Jane Actor edited Some Page')

    const markReadButton = wrapper
      .findAll('button')
      .find((btn) => btn.attributes('aria-label') === 'Mark as read')
    await markReadButton.trigger('click')
    await flushLoads()

    expect(API_CLIENT.patch).toHaveBeenCalledWith('sites/site-1/notifications/notif-1/read')
    expect(wrapper.text()).not.toContain('Jane Actor edited Some Page')
    expect(changedHandler).toHaveBeenCalledTimes(1)
  })

  it('shows a toast and keeps the row when marking read fails', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites/site-1/notifications') {
        return { json: () => Promise.resolve([NOTIFICATION]) }
      }
      return { json: () => Promise.resolve([]) }
    })
    API_CLIENT.patch.mockImplementationOnce(() => {
      throw new Error('network')
    })

    const { wrapper } = await mountInboxWatching()
    const markReadButton = wrapper
      .findAll('button')
      .find((btn) => btn.attributes('aria-label') === 'Mark as read')
    await markReadButton.trigger('click')
    await flushLoads()

    expect(wrapper.text()).toContain('Jane Actor edited Some Page')
    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)
  })
})
