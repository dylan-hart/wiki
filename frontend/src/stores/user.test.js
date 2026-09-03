import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useUserStore } from './user.js'
import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('user store: can()', () => {
  it('grants a permission held globally, or granted for the current page', () => {
    const store = useUserStore()
    store.permissions = ['manage:users']
    store.pagePermissions = ['write:pages']

    expect(store.can('manage:users')).toBe(true)
    expect(store.can('write:pages')).toBe(true)
    expect(store.can('delete:pages')).toBe(false)
  })

  it('treats manage:system as a wildcard over everything', () => {
    const store = useUserStore()
    store.permissions = ['manage:system']

    expect(store.can('anything:at-all')).toBe(true)
  })
})

describe('user store: canOnSite() / fetchSitePermissions()', () => {
  it('denies a site: permission before it has ever been fetched', () => {
    const store = useUserStore()

    expect(store.canOnSite('site:theme', 'site-a')).toBe(false)
  })

  it('grants a site: permission held for the site it was fetched for', async () => {
    const store = useUserStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(['site:theme']) })

    await store.fetchSitePermissions('site-a')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-a/userPermissions')
    expect(store.canOnSite('site:theme', 'site-a')).toBe(true)
    expect(store.canOnSite('site:general', 'site-a')).toBe(false)
  })

  it('refuses a site: permission asked about for a DIFFERENT site than it was fetched for', async () => {
    const store = useUserStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(['site:theme']) })

    await store.fetchSitePermissions('site-a')

    // -> The whole point: holding `site:theme` on site A must never read as holding it on site B
    expect(store.canOnSite('site:theme', 'site-b')).toBe(false)
  })

  it('treats manage:system as a wildcard, same as can()', () => {
    const store = useUserStore()
    store.permissions = ['manage:system']

    expect(store.canOnSite('site:theme', 'any-site')).toBe(true)
  })

  it('fails closed while a fetch for a new site is still in flight', async () => {
    const store = useUserStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(['site:theme']) })
    await store.fetchSitePermissions('site-a')
    expect(store.canOnSite('site:theme', 'site-a')).toBe(true)

    // -> A fetch for a different site starts, and has not resolved yet
    let resolveFetch
    API_CLIENT.get.mockReturnValueOnce({
      json: () => new Promise((resolve) => (resolveFetch = resolve))
    })
    const pending = store.fetchSitePermissions('site-b')

    // -> Neither site reads as granted mid-flight: not the stale site-a answer, and not site-b
    //    before it has actually arrived
    expect(store.canOnSite('site:theme', 'site-a')).toBe(false)
    expect(store.canOnSite('site:theme', 'site-b')).toBe(false)

    resolveFetch(['site:theme'])
    await pending
    expect(store.canOnSite('site:theme', 'site-b')).toBe(true)
  })

  it('clears to an empty grant when asked for a falsy site id', async () => {
    const store = useUserStore()
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(['site:theme']) })
    await store.fetchSitePermissions('site-a')

    await store.fetchSitePermissions(null)

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    expect(store.canOnSite('site:theme', 'site-a')).toBe(false)
  })

  it('clears rather than throws when the request fails', async () => {
    const store = useUserStore()
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network down')
    })

    await store.fetchSitePermissions('site-a')

    expect(store.sitePermissions).toEqual([])
    expect(store.canOnSite('site:theme', 'site-a')).toBe(false)
  })
})

describe('user store: fetchPagePermissions() (bug #949, task 995)', () => {
  it('posts the locale alongside the path when one is given', async () => {
    const store = useUserStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve(['write:pages']) })

    await store.fetchPagePermissions('some/page', 'fr')

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/pages/userPermissions', {
      json: { path: 'some/page', locale: 'fr' }
    })
    expect(store.pagePermissions).toEqual(['write:pages'])
  })

  it('omits locale from the body when none is given', async () => {
    const store = useUserStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve([]) })

    await store.fetchPagePermissions('some/page')

    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/pages/userPermissions', {
      json: { path: 'some/page' }
    })
  })

  it('clears to an empty grant for an app (/_) route without ever calling the API', async () => {
    const store = useUserStore()

    await store.fetchPagePermissions('/_create/markdown', 'en')

    expect(API_CLIENT.post).not.toHaveBeenCalled()
    expect(store.pagePermissions).toEqual([])
  })

  it('clears rather than throws when the request fails', async () => {
    const store = useUserStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    store.pagePermissions = ['write:pages']
    API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('network down')
    })

    await store.fetchPagePermissions('some/page')

    expect(store.pagePermissions).toEqual([])
  })

  it('fails closed while a fetch for a new path is still in flight', async () => {
    const store = useUserStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    API_CLIENT.post.mockReturnValueOnce({ json: () => Promise.resolve(['write:pages']) })
    await store.fetchPagePermissions('some/page')
    expect(store.pagePermissions).toEqual(['write:pages'])

    // -> A fetch for a different path starts, and has not resolved yet
    let resolveFetch
    API_CLIENT.post.mockReturnValueOnce({
      json: () => new Promise((resolve) => (resolveFetch = resolve))
    })
    const pending = store.fetchPagePermissions('other/page')

    // -> Already cleared synchronously, before the response has arrived
    expect(store.pagePermissions).toEqual([])

    resolveFetch(['read:pages'])
    await pending
    expect(store.pagePermissions).toEqual(['read:pages'])
  })
})

describe('user store: applyProfile() / setToGuest()', () => {
  it('falls back to the guest identity when the session response is unauthenticated', () => {
    const store = useUserStore()
    store.applyProfile({ authenticated: false })

    expect(store.authenticated).toBe(false)
    expect(store.id).toBe('10000000-0000-4000-8000-000000000001')
    expect(store.profileLoaded).toBe(true)
  })

  it('adopts the responding user’s id and permissions when authenticated', () => {
    const store = useUserStore()
    store.applyProfile({
      authenticated: true,
      id: 'abc-123',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      permissions: ['write:pages']
    })

    expect(store.authenticated).toBe(true)
    expect(store.id).toBe('abc-123')
    expect(store.name).toBe('Ada Lovelace')
    expect(store.permissions).toEqual(['write:pages'])
  })

  it('clears page and site permissions on setToGuest, so a stale edit button cannot survive a logout', () => {
    const store = useUserStore()
    store.applyProfile({ authenticated: true, id: 'abc-123', permissions: ['write:pages'] })
    store.pagePermissions = ['write:pages']
    store.sitePermissions = ['site:theme']
    store.sitePermissionsSiteId = 'site-a'

    store.setToGuest()

    expect(store.authenticated).toBe(false)
    expect(store.pagePermissions).toEqual([])
    expect(store.sitePermissions).toEqual([])
    expect(store.sitePermissionsSiteId).toBe(null)
    expect(store.permissions).toEqual([])
  })

  it('resets location, jobTitle and pronouns on setToGuest, so a new session cannot inherit the previous user’s profile fields', () => {
    const store = useUserStore()
    store.applyProfile({
      authenticated: true,
      id: 'abc-123',
      location: 'London',
      jobTitle: 'Engineer',
      pronouns: 'she/her'
    })
    expect(store.location).toBe('London')
    expect(store.jobTitle).toBe('Engineer')
    expect(store.pronouns).toBe('she/her')

    store.setToGuest()

    expect(store.location).toBe('')
    expect(store.jobTitle).toBe('')
    expect(store.pronouns).toBe('')
  })
})

describe('user store: logout()', () => {
  it('posts to the site logout endpoint, resets to guest, and emits logout on EVENT_BUS', async () => {
    const store = useUserStore()
    store.applyProfile({ authenticated: true, id: 'abc-123', permissions: ['manage:users'] })

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ redirect: '/goodbye' })
    })
    const received = []
    EVENT_BUS.on('logout', (payload) => received.push(payload))

    await store.logout()

    expect(API_CLIENT.post).toHaveBeenCalledWith(expect.stringContaining('/auth/logout'))
    expect(store.authenticated).toBe(false)
    expect(received).toEqual([{ redirect: '/goodbye' }])
  })

  it('still resets to guest and emits logout when the request itself fails', async () => {
    const store = useUserStore()
    store.applyProfile({ authenticated: true, id: 'abc-123', permissions: [] })

    API_CLIENT.post.mockImplementationOnce(() => {
      throw new Error('network down')
    })
    const received = []
    EVENT_BUS.on('logout', (payload) => received.push(payload))

    await store.logout()

    expect(store.authenticated).toBe(false)
    // -> No response to read a redirect from: falls back to the app root rather than throwing
    expect(received).toEqual([{ redirect: '/' }])
  })

  /*
    Task 468 (feature 362): `NavSidebar.vue`'s watcher only refetches the sidebar menu when the page
    it lands on carries a DIFFERENT `navigationId` than the one it just left -- true most of the time,
    but not when App.vue's `logout` handler routes the reader to a redirect target that happens to
    share the same `navigationId` as the page they were just reading (the site's default menu is the
    common case). The watcher then never fires, and the sidebar built while authenticated -- including
    any `visibilityGroups`-restricted item this reader could see a moment ago -- stays on screen after
    the session has ended. `logout()` forces the refetch itself, unconditionally, rather than relying
    on the watcher's own diffing.
  */
  it('forces a navigation refetch against the now-anonymous session, regardless of whether the destination shares the same navigationId', async () => {
    const store = useUserStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    // -> The sidebar the reader was looking at when they logged out
    siteStore.nav.currentId = 'nav-1'
    siteStore.nav.items = [
      { id: 'restricted', type: 'link', label: 'Restricted', target: '/secret' }
    ]
    store.applyProfile({ authenticated: true, id: 'abc-123', permissions: [] })

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ redirect: '/some-page' })
    })
    // -> The re-fetched menu, now built against the guest session: the restricted item is gone
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          mode: 'static',
          items: [{ id: 'public', type: 'link', label: 'Public', target: '/' }]
        })
    })

    await store.logout()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(siteStore.nav.items).toEqual([
      { id: 'public', type: 'link', label: 'Public', target: '/' }
    ])
  })

  it('does not attempt a navigation refetch when no sidebar menu was ever loaded', async () => {
    const store = useUserStore()
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    siteStore.nav.currentId = null
    store.applyProfile({ authenticated: true, id: 'abc-123', permissions: [] })

    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ redirect: '/' })
    })

    await store.logout()

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })
})

describe('user store: formatDate()', () => {
  it('renders an ISO instant string in the stored dateFormat and timezone', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timezone = 'UTC'

    expect(store.formatDate('2026-03-04T12:00:00Z')).toBe('2026-03-04')
  })

  it('returns an empty string for a nullish date rather than throwing', () => {
    const store = useUserStore()

    expect(store.formatDate(null)).toBe('')
  })

  // -> No stored pattern falls back to the locale-default branch, which OpenProject #1881 hoisted its
  //    `Intl.DateTimeFormat` out of the per-call path -- this is the branch that formatter backs.
  it('falls back to the locale-default numeric pattern when no dateFormat is stored', () => {
    const store = useUserStore()
    store.dateFormat = ''
    store.timezone = 'UTC'

    expect(store.formatDate('2026-03-04T12:00:00Z')).toBe('3/4/2026')
  })
})

// -> OpenProject #1881: formatTimePart's two `Intl.DateTimeFormat` instances were hoisted to module
//    scope, keyed by timeFormat -- exercised here through formatDateTime() (formatTimePart itself
//    isn't exported) so both the 12h and 24h branches keep rendering identical output.
describe('user store: formatDateTime() time-of-day branches', () => {
  const t = (key, params) => `${params.date} at ${params.time}`

  it('renders the time in 12h format', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '12h'
    store.timezone = 'UTC'

    expect(store.formatDateTime(t, '2026-03-04T15:30:00Z')).toBe('2026-03-04 at 3:30 PM')
  })

  it('renders the time in 24h format', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '24h'
    store.timezone = 'UTC'

    expect(store.formatDateTime(t, '2026-03-04T15:30:00Z')).toBe('2026-03-04 at 15:30')
  })

  // -> Guards the hoist itself: the shared formatter instances must not carry state between calls.
  it('produces identical output across repeated calls against the shared formatters', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '12h'
    store.timezone = 'UTC'

    const first = store.formatDateTime(t, '2026-03-04T15:30:00Z')
    const second = store.formatDateTime(t, '2026-03-04T15:30:00Z')
    expect(second).toBe(first)
  })
})

/*
  OpenProject #1595: 16 admin/inbox/profile screens hand-rolled their own `toLocaleString()`
  timestamp formatter (called with an explicit `undefined` locale), which ignored both the stored
  timezone (the OS zone won instead) and locale (the browser's won instead). All of them are now a
  drop-in call to formatDateTime() -- three of them (a webhook delivery log, a scheduler run, a
  security scan report) additionally need seconds, since there the timing itself is the thing being
  read.
*/
describe('user store: formatDateTime()', () => {
  const t = (key, params) => `${params.date} at ${params.time}`

  it('honours the stored timezone rather than the OS zone', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '24h'
    store.timezone = 'Pacific/Auckland' // -> UTC+13 in March, nowhere near the test runner's own zone

    expect(store.formatDateTime(t, '2026-03-04T12:00:00Z')).toBe('2026-03-05 at 01:00')
  })

  it('omits seconds by default', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '24h'
    store.timezone = 'UTC'

    expect(store.formatDateTime(t, '2026-03-04T12:00:30Z')).toBe('2026-03-04 at 12:00')
  })

  it('includes seconds when asked, in both the 24h and 12h time formats', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timezone = 'UTC'

    store.timeFormat = '24h'
    expect(store.formatDateTime(t, '2026-03-04T12:00:30Z', { seconds: true })).toBe(
      '2026-03-04 at 12:00:30'
    )

    store.timeFormat = '12h'
    expect(store.formatDateTime(t, '2026-03-04T12:00:30Z', { seconds: true })).toBe(
      '2026-03-04 at 12:00:30 PM'
    )
  })

  it('returns an empty string for a nullish date rather than throwing', () => {
    const store = useUserStore()

    expect(store.formatDateTime(t, null)).toBe('')
  })
})

describe('user store: formatDateTime({ seconds })', () => {
  const fakeT = (key, params) => `${params.date} at ${params.time}`

  it('renders the same moment as the default, with a seconds field added', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '24h'
    store.timezone = 'UTC'

    expect(store.formatDateTime(fakeT, '2026-03-04T12:34:56Z')).toBe('2026-03-04 at 12:34')
    expect(store.formatDateTime(fakeT, '2026-03-04T12:34:56Z', { seconds: true })).toBe(
      '2026-03-04 at 12:34:56'
    )
  })

  it('returns an empty string for a nullish date rather than throwing', () => {
    const store = useUserStore()

    expect(store.formatDateTime(fakeT, null, { seconds: true })).toBe('')
  })
})

describe('user store: formatDateTime({ zone }) / formatDateTime({ seconds, zone })', () => {
  // -> Kiritimati (UTC+14) so the assertion holds regardless of the test runner's own zone: no real
  //    CI/dev machine is configured to it, so "the stored zone" and "the browser default" can never
  //    coincidentally match here the way e.g. UTC sometimes does.
  const STORED_ZONE = 'Pacific/Kiritimati'
  const INSTANT = '2026-03-04T12:00:00Z'
  const t = (key, params) => `${params.date} at ${params.time}`

  it('{ zone } renders the stored 24h wall-clock time and appends the zone label', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '24h'
    store.timezone = STORED_ZONE

    const result = store.formatDateTime(t, INSTANT, { zone: true })
    const browserDefault = Temporal.Instant.from(INSTANT)
      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
      .toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

    // -> 12:00 UTC is 02:00 the next day in Kiritimati (UTC+14)
    expect(result).toBe('2026-03-05 at 02:00 GMT+14')
    expect(result).not.toContain(browserDefault)
  })

  it('{ seconds, zone } renders it at seconds precision with the zone label', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '24h'
    store.timezone = STORED_ZONE

    const result = store.formatDateTime(t, '2026-03-04T12:00:30Z', { seconds: true, zone: true })
    const browserDefault = Temporal.Instant.from('2026-03-04T12:00:30Z')
      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
      .toLocaleString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      })

    expect(result).toBe('2026-03-05 at 02:00:30 GMT+14')
    expect(result).not.toContain(browserDefault)
  })

  it('both return an empty string for a nullish date rather than throwing', () => {
    const store = useUserStore()

    expect(store.formatDateTime(t, null, { zone: true })).toBe('')
    expect(store.formatDateTime(t, null, { seconds: true, zone: true })).toBe('')
  })
})
