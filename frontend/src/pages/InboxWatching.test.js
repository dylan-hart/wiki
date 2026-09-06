import { beforeEach, describe, expect, it, vi } from 'vitest'

import InboxWatching from './InboxWatching.vue'
import { queue as notifyQueue } from '@/composables/notify'

import { buildTestRouter, createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

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
    watchingUpdated: 'Updated {date}',
    watchingSince: 'Watching since {date}',
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

// -> `preference` is present here too (not just on `WATCHED_PAGE_WITH_PREFERENCE` below): every
//    watched page carries one from the API, this fixture just isn't the one the preference-menu
//    tests assert against.
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
  const { wrapper, router, siteStore } = mountInboxWatchingUnsettled(sitePatch)
  await flushLoads()
  notifyQueue.splice(0, notifyQueue.length)
  return { wrapper, router, siteStore }
}

/**
 * Same mount, without the trailing `flushLoads()` — for asserting what the page shows on its very
 * first paint, before either `load()`/`loadNotifications()` fetch has resolved (task 2503: both
 * empty-state banners must already be showing at this point, not still flip in after the fetch
 * settles).
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

/** A promise plus its own `resolve`, for holding a fetch open across assertions (task 2503). */
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

    // Still in flight: the banner must already be showing, not hidden behind a zero-item list
    // while `state.notifications` is still empty and the fetch hasn't resolved yet.
    expect(wrapper.text()).toContain('You have no unread notifications.')

    notificationsFetch.resolve([])
    await flushLoads()

    // Resolved, genuinely empty: still the banner, with no intervening flip to a list.
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
   * OpenProject #2531: following a notification to its page used to leave `/_inbox/*` as a route,
   * which closed the old bespoke dialog as a side effect of navigating away from it. Now that this is
   * `InboxOverlay` content, closing the overlay has to happen explicitly, or the dialog would be left
   * open on top of the page just navigated to.
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

    // Still in flight: the banner must already be showing, not hidden behind a zero-item list
    // while `state.pages` is still empty and the fetch hasn't resolved yet.
    expect(wrapper.text()).toContain('You are not watching any page yet.')

    watchingFetch.resolve([])
    await flushLoads()

    // Resolved, genuinely empty: still the banner, with no intervening flip to a list.
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

  /**
   * OpenProject #2531: same reasoning as the notifications section's own version of this test --
   * following a watched page used to leave the `/_inbox/*` route, closing the old dialog as a side
   * effect; `InboxOverlay` content has to close the overlay explicitly instead.
   */
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
 * OpenProject #2716: `inbox.watchingUpdated`'s `{date}` used to go through `humanizeDate` (the
 * legacy absolute `2026-08-25 at 14:32` form) no matter how recent the page's own update was -- the
 * same defect the page view's own "Last modified" line already avoided by going through
 * `formatRecent`. `watchingSince` (the page's `watchedAt`) deliberately stays out of scope and keeps
 * `humanizeDate`.
 */
describe('InboxWatching watching -- last-updated line (OpenProject #2716)', () => {
  it('formats the watched-page update time through `userStore.formatRecent`, not the legacy absolute form', async () => {
    // -> Inside the last week, which is the branch `formatRecent` exists for: a weekday and a time
    //    rather than the full date `humanizeDate`/`formatDateTime` would give.
    const recentUpdatedAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()
    stubApi(
      { 'sites/site-1/watching': [{ ...WATCHED_PAGE, updatedAt: recentUpdatedAt }] },
      { fallback: [] }
    )

    const { wrapper, userStore, i18n } = mountInboxWatchingUnsettled()
    await flushLoads()

    const expected = userStore.formatRecent(i18n.global.t, recentUpdatedAt)
    expect(expected).not.toBe('')
    expect(wrapper.text()).toContain(`Updated ${expected}`)
    // -> And not the raw stored value, which is what interpolating `updatedAt` directly (or the
    //    legacy `humanizeDate` absolute form) would show.
    expect(wrapper.text()).not.toContain(recentUpdatedAt)
  })

  it('renders the placeholder, not an empty date, when a watched page has no updatedAt', async () => {
    stubApi({ 'sites/site-1/watching': [{ ...WATCHED_PAGE, updatedAt: null }] }, { fallback: [] })

    const { wrapper } = mountInboxWatchingUnsettled()
    await flushLoads()

    expect(wrapper.text()).toContain('Updated ---')
  })
})

/**
 * Task 1895 (WP 1895, Epic 1867): `PATCH .../watch` was caller-less -- the model layer
 * (`resolvePreference`/`setPreference` in `models/pageWatching.ts`) already existed, this page
 * already received `preference` on every watched page, and nothing in the UI ever sent the PATCH.
 * These cover the menu this task added, kept to the checkboxes rather than also driving WSelect's own
 * listbox open-and-pick sequence -- that mechanic already has its own dedicated suite
 * (`WSelect.test.js`) and re-exercising it here would only be testing WSelect again, not this page.
 */
describe('InboxWatching notification preferences', () => {
  function mockWatchedPage(extraGetHandler) {
    API_CLIENT.get.mockImplementation((url) => {
      if (url === 'sites/site-1/watching') {
        // -> A fresh deep copy per call, not the shared const: `page.preference = ...` in
        //    `savePreference()` mutates through Vue's reactive proxy straight into the underlying
        //    object, and `state.pages` is built directly from what this resolves -- reusing
        //    `WATCHED_PAGE_WITH_PREFERENCE` itself here would let one test's successful save leak
        //    into every test that runs after it in the same file.
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

    // -> The failed PATCH never touched `page.preference`, so closing (Cancel, since a failed save
    //    leaves the menu open with the edited copy still showing) and reopening re-seeds the menu
    //    from the untouched original -- proving the failure did not leak the discarded edit into it.
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
  OpenProject #2621 -- `Cardinal Wiki - Inbox 3x.dc.html`. The design draws both framed lists' leading
  plate at 36x36 with an 18px glyph, and every row action as a hairline 32px square rather than the
  flat round tinted button they all used to be. These assert the emitted sizes and classes, not
  computed geometry: jsdom runs no layout engine, so a rendered-height claim here would be fiction.
*/
describe('InboxWatching against its design file (#2621)', () => {
  /*
    A `WAvatar` renders `.w-avatar` with its `size` as an inline style, which is what beats the
    shared 40px flanking-avatar rule -- so the inline style IS the assertion.
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
    // -> Square, per the design; `rounded` would be a corner treatment the language never draws
    expect(plate.classes()).toContain('rounded-none')
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
      // -> `outline` is what draws the hairline; `rounded-full` is what `round` used to draw
      expect(action.classes()).toContain('border-hairline')
      expect(action.classes()).not.toContain('rounded-full')
      expect(action.classes()).not.toContain('acrylic-btn')
      // -> `padding="none"` is the only thing that can zero WBtn's own inline padding
      expect(action.attributes('style')).toContain('padding: 0px')
    }
  })
})
