import { defineStore } from 'pinia'

import { getAccessibleColor } from '@/helpers/accessibility'
import { GUESTS_GROUP_ID } from '@/helpers/systemIds'

import { useSiteStore } from './site'

const pad = (value) => String(value).padStart(2, '0')

// -> Built once rather than once per `formatDatePart()` call landing on the locale-default branch.
//    `Intl.DateTimeFormat.format()` won't take a `Temporal.ZonedDateTime` directly (its own zone
//    would conflict with a formatter that has none configured), so callers pass `.toPlainDateTime()`
//    -- dropping the zone is fine here since it was already applied by `toUserZone()`.
const localeDateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric'
})

/**
 * Render the date part of a moment the way the user asked for it.
 *
 * The stored preference is one of a handful of explicit patterns, or an empty string meaning "whatever
 * this locale does" — which is the only case a formatter can be left to decide on its own.
 */
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

/**
 * The moment as this user's clock shows it, whatever form the API sent it in.
 *
 * @param date A `Temporal.Instant`, a `Date`, or a string one can be parsed from.
 * @param timezone This user's stored zone, which may be empty or no longer exist.
 */
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
 * Render the time part -- see `localeDateFormat` above for why `.toPlainDateTime()`.
 *
 * @param seconds Append `:ss` — for a screen where sub-minute precision is the point (a webhook
 *   delivery log, a scan report, a scheduler run), not the default for a reader's everyday timestamp.
 * @param timeZoneName Append the zone's short label (`GMT+9`, `JST`, ...) -- for a screen where the
 *   reader needs to know which zone they're looking at, not just what it reads. Bypasses the
 *   pre-built `timeFormats` formatters (which format a zone-less `PlainDateTime` and so have no zone
 *   to name) and formats `zoned` directly instead, since the zone name is derived from its identity.
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
    location: '',
    jobTitle: '',
    pronouns: '',
    timezone: '',
    dateFormat: 'YYYY-MM-DD',
    timeFormat: '12h',
    appearance: 'site',
    cvd: 'none',
    permissions: [],
    pagePermissions: [],
    /**
     * The `site:*` permissions (see `backend/helpers/siteRules.ts`) the caller holds on
     * `sitePermissionsSiteId` — the site-scoped counterpart to `pagePermissions`. Only ever valid for
     * the one site it was last fetched for, which is exactly what `sitePermissionsSiteId` records: a
     * component asking about a DIFFERENT site must not read this as an answer for that site. See
     * `canOnSite`.
     */
    sitePermissions: [],
    /** Which site `sitePermissions` was fetched for, or null before the first fetch. */
    sitePermissionsSiteId: null,
    authenticated: false,
    profileLoaded: false
  }),
  actions: {
    /**
     * Take in a session that arrived with something else — `bootstrap` hands it over with the site and
     * the flags, which is how an app load asks who is logged in without a request of its own. A login
     * instead re-answers this by reloading the app entirely: `AuthLoginPanel.vue` does a full
     * `window.location.replace()` on success, so the next answer arrives the same way, through
     * `bootstrap` calling this again on the fresh page load.
     */
    applyProfile(resp) {
      if (!resp?.authenticated) {
        this.setToGuest()
        return
      }
      this.$patch({
        /*
          Kept, rather than left at the guest id this store starts with. Nothing used to read it
          while logged in, so nothing noticed -- but a live editing session identifies its
          participants by it, and every one of them claiming the guest id makes a roomful of
          people look like one person wearing the same colour.
        */
        id: resp.id,
        name: resp.name || 'Unknown User',
        email: resp.email,
        hasAvatar: resp.hasAvatar ?? false,
        location: resp.location || '',
        jobTitle: resp.jobTitle || '',
        pronouns: resp.pronouns || '',
        timezone: resp.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        dateFormat: resp.dateFormat || '',
        timeFormat: resp.timeFormat || '12h',
        appearance: resp.appearance || 'site',
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
        // -> Clear the client either way. Whatever went wrong, someone who clicked Logout must not be
        //    left looking at a page that still says they are signed in.
        console.warn(err)
      }
      this.setToGuest()
      /*
        NavSidebar.vue's watcher only re-fetches the sidebar menu when the page it lands on carries a
        DIFFERENT navigationId than the one it just left. A logout redirect target commonly shares the
        same navigationId as the page just left (the site's default menu, say), so that watcher never
        fires -- and the menu stays on screen built against the session that just ended, restricted
        items included. Forced here instead, unconditionally (`forceRefresh: true`, OpenProject #1012
        -- `fetchNavigation()`'s own "already showing this menu" cache check would otherwise skip a
        refetch under the SAME id this passes), so the sidebar reflects the guest this reader now is
        regardless of where the redirect lands them. Nothing to refresh if no sidebar menu was ever
        loaded in the first place.
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
        location: '',
        jobTitle: '',
        pronouns: '',
        timezone: '',
        dateFormat: 'YYYY-MM-DD',
        timeFormat: '12h',
        appearance: 'site',
        cvd: 'none',
        permissions: [],
        // -> Page permissions arrive with the page, so leaving them would keep edit buttons on screen
        //    for a user who is no longer logged in until they navigate
        pagePermissions: [],
        sitePermissions: [],
        sitePermissionsSiteId: null,
        authenticated: false,
        /*
          Loaded, not unknown: being a guest IS an answer, and this is where it is recorded — whether
          it came back from `bootstrap` or from logging out. Left false, every navigation would ask
          the server who this is all over again, and every reader of a public wiki is a guest.
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
     * Which page-scoped permissions the caller holds AT `path` — what gates edit/create/etc.
     * controls for the currently-viewed page. See `userStore.pagePermissions` usage in `App.vue`
     * (refreshed per route) and `Index.vue`'s `canCreatePage`.
     *
     * Clears first, synchronously, rather than only on success: while a fetch for a NEW path is in
     * flight, `pagePermissions` reads as denied in the meantime — the safe direction for a
     * permission check to be wrong in, unlike serving the PREVIOUS path's answer while this one is
     * still loading would be. Mirrors the hardened `fetchSitePermissions` above.
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
        // -> Guards `.includes()` against a malformed/empty response the same way an absent one is
        //    already guarded against above.
        this.pagePermissions = Array.isArray(permissions) ? permissions : []
      } catch (err) {
        console.warn(`Failed to fetch page permissions at path ${path}!`)
      }
    },
    /**
     * Which `site:*` permissions the caller holds on `siteId` — what the admin area's nine
     * site-scoped pages hide their sidebar links and content behind. See
     * `frontend/src/composables/siteAdminAccess.js`, the actual caller.
     *
     * Clears first, synchronously, rather than only on success: while a fetch for a NEW site is in
     * flight, `sitePermissionsSiteId` no longer matches that (or any) site, so `canOnSite` reads as
     * denied for it in the meantime — the safe direction for a permission check to be wrong in,
     * unlike serving the PREVIOUS site's answer while this one is still loading would be.
     */
    async fetchSitePermissions(siteId) {
      this.sitePermissions = []
      this.sitePermissionsSiteId = null
      if (!siteId) {
        return
      }
      try {
        const permissions = await API_CLIENT.get(`sites/${siteId}/userPermissions`).json()
        // -> Guards `canOnSite`'s `.includes()` against a malformed/empty response the same way an
        //    absent one is already guarded against above.
        this.sitePermissions = Array.isArray(permissions) ? permissions : []
        this.sitePermissionsSiteId = siteId
      } catch (err) {
        console.warn(`Failed to fetch site permissions for site ${siteId}!`)
      }
    },
    /**
     * Whether the caller holds a `site:*` permission on a specific site — the site-scoped counterpart
     * to `can()`. Takes `siteId` explicitly, unlike `can()`'s implicit "current path": `sitePermissions`
     * is only ever valid for one site at a time, and a caller asking about a site it was not fetched
     * for must be refused rather than answered with a stale or unrelated site's grant.
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
     * Format a moment as this user asked to see it: their date pattern, their 12h/24h choice, and their
     * time zone. Word order comes from the locale, which is why `t` is passed in.
     *
     * @param date A `Temporal.Instant`, a `Date`, or a string one can be parsed from — what the API
     *             returns. Nullable columns like `lastLoginAt` are common, so nothing at all formats as
     *             an empty string rather than blowing up mid-render.
     * @param seconds Include seconds in the time part — for a log-style timestamp (a job's timing, a
     *             webhook delivery attempt, a security scan) where sub-minute precision is the point,
     *             rather than an everyday "last modified" line.
     * @param zone Append the zone's short label (`GMT+9`, `JST`, ...) — for an account-scoped
     *             timestamp (a session, an API key, an audit entry) where the reader needs to know
     *             which zone they are looking at, not just what it reads.
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
     * Format the DATE alone, in this user's pattern and zone. For a line with no room for a time, or
     * where the time says nothing worth reading -- the day an update was released, say.
     *
     * No `t`: with only one part there is no word order for a locale to have an opinion about.
     */
    formatDate(date) {
      if (!date) {
        return ''
      }
      return formatDatePart(toUserZone(date, this.timezone), this.dateFormat)
    }
  }
})
