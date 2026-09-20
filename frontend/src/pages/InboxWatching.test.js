import { beforeEach, describe, expect, it, vi } from 'vitest'

import InboxWatching from './InboxWatching.vue'
import { queue as notifyQueue } from '@/composables/notify'
import { useDark } from '@/composables/dark'

import { buildTestRouter, createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

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
  common: {
    actions: {
      cancel: 'Cancel',
      save: 'Save'
    }
  },
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
    watchingUpdated: 'Last updated {date}',
    watchingUnwatch: 'Stop watching',
    watchingUnwatched: '{title} is no longer watched.',
    watchingUnwatchFailed: 'Could not stop watching this page.',
    watchingPreferences: 'Notification preferences',
    watchingPreferencesMode: 'Delivery',
    watchingPreferencesModeDigest: 'Digest',
    watchingPreferencesModeImmediate: 'Immediate',
    watchingPreferencesEdited: 'Notify when edited',
    watchingPreferencesMoved: 'Notify when moved',
    watchingPreferencesDeleted: 'Notify when deleted',
    watchingPreferencesSaveFailed: 'Could not save your notification preferences.'
  }
}

const WATCHED_PAGE_WITH_PREFERENCE = {
  pageId: 'watched-page-1',
  path: 'some/watched-page',
  locale: 'en',
  title: 'Watched Page',
  description: null,
  icon: null,
  updatedAt: '2026-08-17T12:00:00.000Z',
  watchedAt: '2026-08-16T12:00:00.000Z',
  preference: {
    notifyMode: 'digest',
    notifyOnEdited: true,
    notifyOnMoved: true,
    notifyOnDeleted: true
  }
}

function findByRoleAndText(role, text) {
  return [...document.querySelectorAll(`[role="${role}"]`)].find((el) =>
    el.textContent.includes(text)
  )
}

function findButtonByText(text) {
  return [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === text)
}

async function mountInboxWatching(sitePatch = {}) {
  const { wrapper, router, siteStore, userStore, i18n } = mountInboxWatchingUnsettled(sitePatch)
  await flushLoads()
  notifyQueue.splice(0, notifyQueue.length)
  return { wrapper, router, siteStore, userStore, i18n }
}

/**
 * Same mount without the trailing `flushLoads()`, for asserting what the page shows on its first
 * paint, before either fetch has resolved.
 */
function mountInboxWatchingUnsettled(sitePatch = {}) {
  const router = buildTestRouter(['/', '/:path(.*)'])

  const { wrapper, siteStore, userStore, i18n } = mountWithApp(InboxWatching, {
    messages,
    router,
    stores: {
      site: (store) => {
        store.$patch({ id: 'site-1', ...sitePatch })
      }
    },
    // -> Opts out of `mountWithApp`'s default `teleport: true` stub: the preferences dialog really
    //    teleports its body to `document.body`, which is where `findButtonByText` looks.
    stubs: {}
  })

  return { wrapper, router, siteStore, userStore, i18n }
}

async function flushLoads() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** A promise plus its own `resolve`, for holding a fetch open across assertions. */
function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  notifyQueue.splice(0, notifyQueue.length)
})

describe('InboxWatching notifications', () => {
  it('lists unread notifications from GET .../notifications', async () => {
    stubApi({ 'sites/site-1/notifications': [NOTIFICATION] }, { fallback: [] })

    const { wrapper } = await mountInboxWatching()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/notifications')
    expect(wrapper.text()).toContain('Jane Actor edited Some Page')
  })

  it('shows the empty state when there are no unread notifications', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))

    const { wrapper } = await mountInboxWatching()

    expect(wrapper.text()).toContain('You have no unread notifications.')
  })

  it('keeps the empty-state banner showing throughout the fetch, with no flicker to a list and back (task 2503)', async () => {
    const notificationsFetch = deferred()
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites/site-1/notifications') {
        return { json: () => notificationsFetch.promise }
      }
      return { json: () => Promise.resolve([]) }
    })

    const { wrapper } = mountInboxWatchingUnsettled()
    await flushLoads()

    expect(wrapper.text()).toContain('You have no unread notifications.')

    notificationsFetch.resolve([])
    await flushLoads()

    expect(wrapper.text()).toContain('You have no unread notifications.')
  })

  it('marking a notification read removes it from the list and notifies the header badge', async () => {
    stubApi({ 'sites/site-1/notifications': [NOTIFICATION] }, { fallback: [] })
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
    stubApi(
      { 'sites/site-1/notifications': [{ ...NOTIFICATION, pageLocale: 'fr' }] },
      { fallback: [] }
    )
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

  /**
   * As `InboxOverlay` content this screen has no route of its own, so navigating away closes
   * nothing: without the explicit close the overlay sits on top of the page just navigated to.
   */
  it('closes the Inbox overlay before following a notification to its page', async () => {
    stubApi({ 'sites/site-1/notifications': [NOTIFICATION] }, { fallback: [] })
    API_CLIENT.patch.mockReturnValueOnce({ json: () => Promise.resolve({ ok: true }) })

    const { wrapper, siteStore } = await mountInboxWatching()
    siteStore.overlay = 'Inbox'

    await wrapper.find('[role="button"]').trigger('click')
    await flushLoads()

    expect(siteStore.overlay).toBe('')
  })

  it('shows a toast and keeps the row when marking read fails', async () => {
    stubApi({ 'sites/site-1/notifications': [NOTIFICATION] }, { fallback: [] })
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
    stubApi({ 'sites/site-1/watching': [WATCHED_PAGE] }, { fallback: [] })
  }

  it('keeps the empty-state banner showing throughout the fetch, with no flicker to a list and back (task 2503)', async () => {
    const watchingFetch = deferred()
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites/site-1/watching') {
        return { json: () => watchingFetch.promise }
      }
      return { json: () => Promise.resolve([]) }
    })

    const { wrapper } = mountInboxWatchingUnsettled()
    await flushLoads()

    expect(wrapper.text()).toContain('You are not watching any page yet.')

    watchingFetch.resolve([])
    await flushLoads()

    expect(wrapper.text()).toContain('You are not watching any page yet.')
  })

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

  it('closes the Inbox overlay before following a watched page', async () => {
    mockWatchedPages()

    const { wrapper, router, siteStore } = await mountInboxWatching()
    siteStore.overlay = 'Inbox'
    const pushSpy = vi.spyOn(router, 'push')

    await wrapper.find('[role="button"]').trigger('click')
    await flushLoads()

    expect(pushSpy).toHaveBeenCalledWith('/watched/page')
    expect(siteStore.overlay).toBe('')
  })

  /**
   * `updatedAt` is computed relative to "now" rather than a fixed calendar string: `formatRecent`'s
   * abbreviated form only applies within the last 7 days.
   */
  it('shows "last updated" in the recent form, not the legacy absolute one', async () => {
    const recentUpdatedAt = Temporal.Now.instant().subtract({ hours: 26 }).toString()
    stubApi(
      { 'sites/site-1/watching': [{ ...WATCHED_PAGE, updatedAt: recentUpdatedAt }] },
      { fallback: [] }
    )

    const { wrapper, userStore, i18n } = await mountInboxWatching()

    expect(wrapper.text()).toContain(userStore.formatRecent(i18n.global.t, recentUpdatedAt))
  })

  it('renders the placeholder, not an empty date, when a watched page has no updatedAt', async () => {
    stubApi({ 'sites/site-1/watching': [{ ...WATCHED_PAGE, updatedAt: null }] }, { fallback: [] })

    const { wrapper } = await mountInboxWatching()

    expect(wrapper.text()).toContain('Last updated ---')
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

/**
 * Kept to the checkboxes rather than also driving WSelect's listbox open-and-pick sequence: that
 * mechanic has its own suite, and re-exercising it here would test WSelect, not this page.
 */
describe('InboxWatching notification preferences', () => {
  function mockWatchedPage(extraGetHandler) {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites/site-1/watching') {
        // -> A fresh deep copy per call, not the shared const: `savePreference()` writes through
        //    Vue's reactive proxy into the underlying object, so reusing the const would let one
        //    test's successful save leak into every test after it
        return {
          json: () =>
            Promise.resolve([
              {
                ...WATCHED_PAGE_WITH_PREFERENCE,
                preference: { ...WATCHED_PAGE_WITH_PREFERENCE.preference }
              }
            ])
        }
      }
      if (extraGetHandler) {
        const handled = extraGetHandler(url)
        if (handled) {
          return handled
        }
      }
      return { json: () => Promise.resolve([]) }
    })
  }

  it('opens seeded from the page’s current preference, and saving PATCHes only that watch', async () => {
    mockWatchedPage()
    API_CLIENT.patch.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          ok: true,
          preference: { ...WATCHED_PAGE_WITH_PREFERENCE.preference, notifyOnMoved: false }
        })
    })

    const { wrapper } = await mountInboxWatching()

    const trigger = wrapper.find('[aria-label="Notification preferences"]')
    expect(trigger.exists()).toBe(true)
    await trigger.trigger('click')
    await flushLoads()

    const movedCheckbox = findByRoleAndText('checkbox', 'Notify when moved')
    expect(movedCheckbox).toBeTruthy()
    movedCheckbox.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushLoads()

    findButtonByText('Save').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushLoads()

    expect(API_CLIENT.patch).toHaveBeenCalledWith('sites/site-1/pages/watched-page-1/watch', {
      json: {
        notifyMode: 'digest',
        notifyOnEdited: true,
        notifyOnMoved: false,
        notifyOnDeleted: true
      }
    })
  })

  it('shows a toast and leaves the stored preference untouched when saving fails', async () => {
    mockWatchedPage()
    API_CLIENT.patch.mockImplementationOnce(() => {
      throw new Error('network')
    })

    const { wrapper } = await mountInboxWatching()
    const trigger = wrapper.find('[aria-label="Notification preferences"]')

    await trigger.trigger('click')
    await flushLoads()
    findByRoleAndText('checkbox', 'Notify when moved').dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    )
    await flushLoads()
    findButtonByText('Save').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushLoads()

    expect(notifyQueue.some((n) => n.type === 'negative')).toBe(true)

    // -> A failed save leaves the menu open with the edited copy still showing, so Cancel and
    //    reopen: the menu re-seeds from `page.preference`, which the failed PATCH never touched
    findButtonByText('Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushLoads()
    await trigger.trigger('click')
    await flushLoads()

    expect(findByRoleAndText('checkbox', 'Notify when moved').getAttribute('aria-checked')).toBe(
      'true'
    )
  })

  it('cancelling does not send a request', async () => {
    mockWatchedPage()

    const { wrapper } = await mountInboxWatching()

    await wrapper.find('[aria-label="Notification preferences"]').trigger('click')
    await flushLoads()
    findButtonByText('Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushLoads()

    expect(API_CLIENT.patch).not.toHaveBeenCalled()
  })
})

/*
  Emitted sizes and classes only, never computed geometry: jsdom runs no layout engine, so a
  rendered-height claim here would be fiction.
*/
describe('InboxWatching against its design file (#2621)', () => {
  /*
    `WAvatar` renders its `size` as an inline style, which is what beats the shared 40px
    flanking-avatar rule -- so the inline style IS the assertion.
  */
  function plates(wrapper) {
    return wrapper.findAll('.w-avatar')
  }

  it("draws a notification's plate as a 36px accent square, not a 40px primary one", async () => {
    stubApi({ 'sites/site-1/notifications': [NOTIFICATION] }, { fallback: [] })

    const { wrapper } = await mountInboxWatching()

    const plate = plates(wrapper)[0]
    expect(plate.attributes('style')).toContain('width: 36px')
    expect(plate.attributes('style')).toContain('height: 36px')
    expect(plate.attributes('style')).toContain('font-size: 18px')
    expect(plate.attributes('style')).toContain('var(--color-accent-fill)')
    expect(plate.classes()).toContain('rounded-none')
  })

  /**
   * `--color-accent-fill` has no dark-mode override in `tailwind.css`, so the plate has to resolve
   * its colour through `dark.isActive` rather than pass the static prop.
   */
  it('swaps the plate to accent-dark under dark mode (OpenProject #2807)', async () => {
    useDark().set(true)
    try {
      stubApi({ 'sites/site-1/notifications': [NOTIFICATION] }, { fallback: [] })

      const { wrapper } = await mountInboxWatching()

      const plate = plates(wrapper)[0]
      expect(plate.attributes('style')).toContain('var(--color-accent-dark)')
      expect(plate.attributes('style')).not.toContain('var(--color-accent-fill)')
    } finally {
      useDark().set(false)
      document.body.classList.remove('body--dark', 'body--light')
    }
  })

  it("draws a watched page's plate as a 36px slate square", async () => {
    stubApi({ 'sites/site-1/watching': [WATCHED_PAGE] }, { fallback: [] })

    const { wrapper } = await mountInboxWatching()

    const plate = plates(wrapper)[0]
    expect(plate.attributes('style')).toContain('width: 36px')
    expect(plate.attributes('style')).toContain('var(--color-slate)')
    expect(plate.classes()).toContain('rounded-none')
  })

  it('draws every row action as a hairline square rather than a round tinted button', async () => {
    stubApi(
      {
        'sites/site-1/notifications': [NOTIFICATION],
        'sites/site-1/watching': [WATCHED_PAGE]
      },
      { fallback: [] }
    )

    const { wrapper } = await mountInboxWatching()

    const actions = [
      wrapper.find('[aria-label="Mark as read"]'),
      wrapper.find('[aria-label="Notification preferences"]'),
      wrapper.find('[aria-label="Stop watching"]')
    ]
    for (const action of actions) {
      expect(action.exists()).toBe(true)
      expect(action.classes()).toContain('inbox-square-btn')
      expect(action.classes()).toContain('border-hairline')
      expect(action.classes()).not.toContain('rounded-full')
      expect(action.classes()).not.toContain('acrylic-btn')
      // -> `padding="none"` is the only thing that can zero WBtn's own inline padding
      expect(action.attributes('style')).toContain('padding: 0px')
    }
  })
})
