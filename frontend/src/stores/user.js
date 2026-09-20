import { defineStore } from 'pinia'

import { getAccessibleColor } from '@/helpers/accessibility'
import { log } from '@/helpers/log'
import { GUESTS_GROUP_ID } from '@/helpers/systemIds'

import { useSiteStore } from './site'

const pad = (value) => String(value).padStart(2, '0')

// -> Built once rather than per `formatDatePart()` call. `Intl.DateTimeFormat.format()` won't take a
//    `Temporal.ZonedDateTime` directly (its own zone would conflict with a formatter that has none),
//    so callers pass `.toPlainDateTime()` -- dropping the zone is fine, `toUserZone()` applied it.
const localeDateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric'
})

/** An empty `dateFormat` means "whatever this locale does" — the only case left to a formatter. */
function formatDatePart(zoned, dateFormat) {
  switch (dateFormat) {
    case 'DD/MM/YYYY':
      return `${pad(zoned.day)}/${pad(zoned.month)}/${zoned.year}`
    case 'DD.MM.YYYY':
      return `${pad(zoned.day)}.${pad(zoned.month)}.${zoned.year}`
    case 'MM/DD/YYYY':
      return `${pad(zoned.month)}/${pad(zoned.day)}/${zoned.year}`
    case 'YYYY-MM-DD':
      return `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}`
    case 'YYYY/MM/DD':
      return `${zoned.year}/${pad(zoned.month)}/${pad(zoned.day)}`
    default:
      // -> Numeric parts rather than `dateStyle: 'short'`, which abbreviates the year to two digits
      return localeDateFormat.format(zoned.toPlainDateTime())
  }
}

/** @param date A `Temporal.Instant`, a `Date`, or a string one can be parsed from. */
function toUserZone(date, timezone) {
  let instant = date
  if (typeof date === 'string') {
    instant = Temporal.Instant.from(date)
  } else if (date instanceof Date) {
    instant = date.toTemporalInstant()
  }
  // -> A preference set before the zone list changed, or none at all, falls back to this browser's
  //    zone rather than throwing in the middle of a table
  try {
    return instant.toZonedDateTimeISO(timezone || Temporal.Now.timeZoneId())
  } catch {
    return instant.toZonedDateTimeISO(Temporal.Now.timeZoneId())
  }
}

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

/*
  Four variants built once, keyed by `timeFormat` and whether seconds are shown, rather than one per
  `formatTimePart()` call. `hourCycle` rather than `hour12: false`, which some locales render as
  24:00 where they mean 00:00.
*/
const timeFormats = {
  '12h': new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }),
  '24h': new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }),
  '12h-seconds': new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }),
  '24h-seconds': new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })
}

/**
 * See `localeDateFormat` above for why `.toPlainDateTime()`.
 *
 * @param timeZoneName Appending the zone's short label (`GMT+9`, `JST`, ...) bypasses the pre-built
 *   `timeFormats` formatters -- they format a zone-less `PlainDateTime` and so have no zone to name
 *   -- and formats `zoned` directly instead.
 */
function formatTimePart(zoned, timeFormat, { seconds = false, timeZoneName } = {}) {
  if (timeZoneName) {
    return zoned.toLocaleString(undefined, {
      ...(timeFormat === '24h'
        ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
        : { hour: 'numeric', minute: '2-digit', hour12: true }),
      ...(seconds ? { second: '2-digit' } : {}),
      timeZoneName
    })
  }
  const key = `${timeFormat === '24h' ? '24h' : '12h'}${seconds ? '-seconds' : ''}`
  return timeFormats[key].format(zoned.toPlainDateTime())
}

export const useUserStore = defineStore('user', {
  state: () => ({
    id: GUESTS_GROUP_ID,
    email: '',
    name: '',
    hasAvatar: false,
    /**
     * The provider-reported avatar URL cached at login, or `null` when none has been synced. Only a
     * fallback: `hasAvatar` wins wherever both are set, matching the backend's own
     * `syncAvatarFromProvider()` precedence.
     */
    avatarProviderUrl: null,
    location: '',
    jobTitle: '',
    pronouns: '',
    timezone: '',
    dateFormat: 'YYYY-MM-DD',
    timeFormat: '12h',
    appearance: 'site',
    /**
     * `'site'` follows the site administrator's choice; otherwise a per-user override of
     * `'ledger'`/`'cobalt'` -- the same three-value shape `appearance` uses for dark mode.
     */
    aesthetic: 'site',
    /**
     * `'site'` inherits the site's own `contentWidth` admin setting; otherwise a per-user override
     * of `'measured'`/`'full'`, resolved the same way `aesthetic` is.
     */
    contentWidth: 'site',
    cvd: 'none',
    permissions: [],
    pagePermissions: [],
    /**
     * The `site:*` permissions (see `backend/helpers/siteRules.ts`) the caller holds on
     * `sitePermissionsSiteId`, and only on that site: a component asking about a DIFFERENT site must
     * not read this as an answer for that site. See `canOnSite`.
     */
    sitePermissions: [],
    sitePermissionsSiteId: null,
    authenticated: false,
    profileLoaded: false
  }),
  actions: {
    /**
     * `bootstrap` hands the session over with the site and the flags, which is how an app load asks
     * who is logged in without a request of its own. A login re-answers it the same way:
     * `AuthLoginPanel.vue` does a full `window.location.replace()` on success, so `bootstrap` calls
     * this again on the fresh page load.
     */
    applyProfile(resp) {
      if (!resp?.authenticated) {
        this.setToGuest()
        return
      }
      this.$patch({
        /*
          Kept, rather than left at the guest id this store starts with: a live editing session
          identifies its participants by it, and every one of them claiming the guest id makes a
          roomful of people look like one person wearing the same colour.
        */
        id: resp.id,
        name: resp.name || 'Unknown User',
        email: resp.email,
        hasAvatar: resp.hasAvatar ?? false,
        avatarProviderUrl: resp.avatarProviderUrl ?? null,
        location: resp.location || '',
        jobTitle: resp.jobTitle || '',
        pronouns: resp.pronouns || '',
        timezone: resp.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        dateFormat: resp.dateFormat || '',
        timeFormat: resp.timeFormat || '12h',
        appearance: resp.appearance || 'site',
        aesthetic: resp.aesthetic || 'site',
        contentWidth: resp.contentWidth || 'site',
        cvd: resp.cvd || 'none',
        permissions: resp.permissions || [],
        authenticated: true,
        profileLoaded: true
      })
    },
    async logout() {
      const siteStore = useSiteStore()
      let redirect = '/'
      try {
        const resp = await API_CLIENT.post(`sites/${siteStore.id}/auth/logout`).json()
        redirect = resp?.redirect || '/'
      } catch (err) {
        // -> Clear the client either way: someone who clicked Logout must not be left looking at a
        //    page that still says they are signed in.
        log.warn('auth', 'could not sign out on the server', err)
      }
      this.setToGuest()
      /*
        NavSidebar.vue's watcher only re-fetches the sidebar menu when the page it lands on carries a
        DIFFERENT navigationId, and a logout redirect commonly lands under the same one -- leaving
        the menu on screen built against the session that just ended, restricted items included.
        Forced here instead, past `fetchNavigation()`'s own "already showing this menu" check, so the
        sidebar reflects the guest this reader now is wherever the redirect lands them.
      */
      if (siteStore.nav.currentId) {
        await siteStore.fetchNavigation(siteStore.nav.currentId, true)
      }
      EVENT_BUS.emit('logout', { redirect })
    },
    setToGuest() {
      this.$patch({
        id: GUESTS_GROUP_ID,
        email: '',
        name: '',
        hasAvatar: false,
        avatarProviderUrl: null,
        location: '',
        jobTitle: '',
        pronouns: '',
        timezone: '',
        dateFormat: 'YYYY-MM-DD',
        timeFormat: '12h',
        appearance: 'site',
        aesthetic: 'site',
        contentWidth: 'site',
        cvd: 'none',
        permissions: [],
        // -> Page permissions arrive with the page, so leaving them would keep edit buttons on screen
        //    for a user who is no longer logged in until they navigate
        pagePermissions: [],
        sitePermissions: [],
        sitePermissionsSiteId: null,
        authenticated: false,
        /*
          Loaded, not unknown: being a guest IS an answer. Left false, every navigation would ask the
          server who this is all over again, and every reader of a public wiki is a guest.
        */
        profileLoaded: true
      })
    },
    getAccessibleColor(base, hexBase) {
      return getAccessibleColor(base, hexBase, this.cvd)
    },
    can(permission) {
      if (
        this.permissions.includes('manage:system') ||
        this.permissions.includes(permission) ||
        this.pagePermissions.includes(permission)
      ) {
        return true
      }
      return false
    },
    /**
     * Clears first, synchronously, rather than only on success: while a fetch for a NEW path is in
     * flight, `pagePermissions` reads as denied in the meantime — the safe direction for a
     * permission check to be wrong in, unlike serving the PREVIOUS path's answer would be.
     */
    async fetchPagePermissions(path, locale) {
      this.pagePermissions = []
      if (path.startsWith('/_')) {
        return
      }
      const siteStore = useSiteStore()
      try {
        const permissions = await API_CLIENT.post(`sites/${siteStore.id}/pages/userPermissions`, {
          json: {
            path,
            ...(locale ? { locale } : {})
          }
        }).json()
        this.pagePermissions = Array.isArray(permissions) ? permissions : []
      } catch (err) {
        log.warn('auth', `could not read this session's permissions on ${path}`, err)
      }
    },
    /**
     * Clears first, synchronously, rather than only on success: while a fetch for a NEW site is in
     * flight, `sitePermissionsSiteId` matches no site, so `canOnSite` reads as denied in the
     * meantime — the safe direction for a permission check to be wrong in.
     */
    async fetchSitePermissions(siteId) {
      this.sitePermissions = []
      this.sitePermissionsSiteId = null
      if (!siteId) {
        return
      }
      try {
        const permissions = await API_CLIENT.get(`sites/${siteId}/userPermissions`).json()
        this.sitePermissions = Array.isArray(permissions) ? permissions : []
        this.sitePermissionsSiteId = siteId
      } catch (err) {
        log.warn('auth', `could not read this session's permissions on site ${siteId}`, err)
      }
    },
    /**
     * Takes `siteId` explicitly, unlike `can()`'s implicit "current path": `sitePermissions` is only
     * ever valid for one site at a time, and a caller asking about a site it was not fetched for
     * must be refused rather than answered with a stale or unrelated site's grant.
     */
    canOnSite(permission, siteId) {
      if (this.permissions.includes('manage:system')) {
        return true
      }
      if (!siteId || this.sitePermissionsSiteId !== siteId) {
        return false
      }
      return this.sitePermissions.includes(permission)
    },
    /**
     * Word order comes from the locale, which is why `t` is passed in.
     *
     * @param date A `Temporal.Instant`, a `Date`, or a string one can be parsed from. Nullable
     *             columns like `lastLoginAt` are common, so nothing at all formats as an empty
     *             string rather than blowing up mid-render.
     * @param zone Append the zone's short label (`GMT+9`, `JST`, ...), for a timestamp whose reader
     *             needs to know which zone they are looking at, not just what it reads.
     */
    formatDateTime(t, date, { seconds = false, zone = false } = {}) {
      if (!date) {
        return ''
      }
      const zoned = toUserZone(date, this.timezone)
      return t('common.datetime', {
        date: formatDatePart(zoned, this.dateFormat),
        time: formatTimePart(zoned, this.timeFormat, {
          seconds,
          timeZoneName: zone ? 'short' : undefined
        })
      })
    },
    /**
     * A weekday and a time ("Tue 4:12 PM") inside the last week, the full date-and-time beyond it.
     * What a reader wants from "last modified" is how fresh a page is, which a weekday answers at a
     * glance where `2026-09-05 at 11:17 AM` has to be decoded against today's date first. Past a
     * week "Tue" could be any Tuesday, so it falls back rather than grow a second relative
     * vocabulary. The weekday comes from `Intl`, so it follows the interface locale.
     */
    formatRecent(t, date) {
      if (!date) {
        return ''
      }
      const zoned = toUserZone(date, this.timezone)
      const days = Temporal.Now.zonedDateTimeISO(zoned.timeZoneId)
        .startOfDay()
        .since(zoned.startOfDay(), { largestUnit: 'day' }).days
      if (days < 0 || days > 6) {
        return this.formatDateTime(t, date)
      }
      return `${weekdayFormat.format(zoned.toPlainDateTime())} ${formatTimePart(zoned, this.timeFormat)}`
    },
    /** No `t`: with only one part there is no word order for a locale to have an opinion about. */
    formatDate(date) {
      if (!date) {
        return ''
      }
      return formatDatePart(toUserZone(date, this.timezone), this.dateFormat)
    }
  }
})
