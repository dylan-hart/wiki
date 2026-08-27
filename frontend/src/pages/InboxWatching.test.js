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

const WATCHED_PAGE = {
  pageId: 'page-9',
  title: 'Watched Page',
  path: 'watched/page',
  locale: 'en',
  icon: '',
  updatedAt: '2026-08-17T12:00:00.000Z',
  watchedAt: '2026-08-01T12:00:00.000Z'
}

const NOTIFICATION = {
  id: 'notif-1',
  pageId: 'page-1',
  pageTitle: 'Some Page',
  pagePath: 'some/page',
  pageLocale: 'en',
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
      watchingLoadFailed: 'Failed to load your watched pages.',
      watchingUnwatch: 'Stop watching',
      watchingUnwatched: '{title} is no longer watched.',
      watchingUnwatchFailed: 'Could not stop watching this page.'
    }
  }
}

async function mountInboxWatching(sitePatch = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.$patch({ id: 'site-1', ...sitePatch })

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

  it('a non-primary-locale notification shows and links to a locale-prefixed path', async () => {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites/site-1/notifications') {
        return { json: () => Promise.resolve([{ ...NOTIFICATION, pageLocale: 'fr' }]) }
      }
      return { json: () => Promise.resolve([]) }
    })
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    const { wrapper, router } = await mountInboxWatching({
      locales: {
        primary: 'en',
        active: [
          { code: 'en', language: 'en', name: 'English', nativeName: 'English', isRTL: false },
          { code: 'fr', language: 'fr', name: 'French', nativeName: 'Français', isRTL: false }
        ]
      }
    })

    expect(wrapper.text()).toContain('/fr/some/page')

    const pushSpy = vi.spyOn(router, 'push')
    await wrapper.find('[role="button"]').trigger('click')
    await flushLoads()

    expect(pushSpy).toHaveBeenCalledWith('/fr/some/page')
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

describe('InboxWatching watching', () => {
  function mockWatchedPages() {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites/site-1/watching') {
        return { json: () => Promise.resolve([WATCHED_PAGE]) }
      }
      return { json: () => Promise.resolve([]) }
    })
  }

  it('unwatching a page via DELETE removes it from the list and toasts a positive notification', async () => {
    mockWatchedPages()
    API_CLIENT.delete.mockReturnValueOnce(Promise.resolve({ ok: true }))

    const { wrapper } = await mountInboxWatching()
    expect(wrapper.text()).toContain('Watched Page')

    const unwatchButton = wrapper
      .findAll('button')
      .find((btn) => btn.attributes('aria-label') === 'Stop watching')
    await unwatchButton.trigger('click')
    await flushLoads()

    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/pages/page-9/watch')
    expect(wrapper.text()).not.toContain('Watched Page')
    expect(notifyQueue[notifyQueue.length - 1].type).toBe('positive')
  })

  it('shows the server message and keeps the row when unwatching is refused', async () => {
    mockWatchedPages()
    API_CLIENT.delete.mockReturnValueOnce(
      Promise.reject({ data: { message: 'You are not watching this page.' } })
    )

    const { wrapper } = await mountInboxWatching()
    const unwatchButton = wrapper
      .findAll('button')
      .find((btn) => btn.attributes('aria-label') === 'Stop watching')
    await unwatchButton.trigger('click')
    await flushLoads()

    expect(wrapper.text()).toContain('Watched Page')
    const lastNotification = notifyQueue[notifyQueue.length - 1]
    expect(lastNotification.type).toBe('negative')
    expect(lastNotification.caption).toBe('You are not watching this page.')
  })
})
