import { defineStore } from 'pinia'

import { sortBy } from 'es-toolkit/array'
import { cloneDeep } from 'es-toolkit/object'
import semverGte from 'semver/functions/gte'

import { notify } from '@/composables/notify'

export const useAdminStore = defineStore('admin', {
  state: () => ({
    currentSiteId: null,
    info: {
      currentVersion: 'n/a',
      latestVersion: 'n/a',
      activeWorkers: 0,
      clusterTotal: 0,
      groupsTotal: 0,
      pagesTotal: 0,
      usersTotal: 0,
      webhooksTotal: 0,
      loginsPastDay: 0,
      isApiEnabled: false,
      isMailConfigured: false,
      isMetricsEnabled: false,
      isPageviewsEnabled: false,
      isReplicationEnabled: false,
      isSchedulerHealthy: false
    },
    overlay: null,
    overlayOpts: {},
    sites: [],
    locales: [{ code: 'en', name: 'English' }],
    /** Set once `fetchLocales` has actually resolved -- lets a caller outside the admin area (e.g.
     *  `App.vue`'s router guard, OpenProject #1696) ask for the instance's installed locale catalogue
     *  without re-fetching it on every navigation once it is already known. */
    localesLoaded: false,
    /** Classification levels (OpenProject #1079), most-open first. What the group rule editor's
     *  CLASSIFICATION match picker and the page properties classification picker both read. */
    classificationLevels: []
  }),
  getters: {
    /**
     * `pending` until `fetchInfo` has both versions -- neither `latest` nor `outdated` can be
     * claimed before the server has answered.
     */
    versionStatus: (state) => {
      if (
        !state.info.currentVersion ||
        !state.info.latestVersion ||
        state.info.currentVersion === 'n/a' ||
        state.info.latestVersion === 'n/a'
      ) {
        return 'pending'
      }
      return semverGte(state.info.currentVersion, state.info.latestVersion) ? 'latest' : 'outdated'
    },
    isVersionLatest() {
      return this.versionStatus === 'latest'
    }
  },
  actions: {
    /**
     * Fetches the instance's full installed-locale catalogue (every locale the interface can be
     * rendered in, not just the site's active content locales -- see `siteStore.locales.active`).
     *
     * Idempotent once it has resolved: `AdminLayout.vue`'s mount and `App.vue`'s router guard (which
     * only needs this the moment a reader's `desiredLocale` isn't one of the site's active content
     * locales, OpenProject #1696) can both call it freely without doubling up the request on every
     * navigation. Nothing in this app mutates the installed-locale set mid-session (adding one is an
     * instance restart away), so there is no cache-invalidation case to handle here.
     */
    async fetchLocales() {
      if (this.localesLoaded) {
        return
      }
      try {
        const resp = await API_CLIENT.get('locales').json()
        this.locales = sortBy(cloneDeep(resp ?? []), ['nativeName', 'name'])
        this.localesLoaded = true
      } catch (err) {
        notify.negative('Failed to load locales.', err.message)
      }
    },
    async fetchInfo() {
      try {
        const resp = await API_CLIENT.get('system/info').json()
        this.info.activeWorkers = resp?.activeWorkers ?? 0
        this.info.clusterTotal = resp?.clusterTotal ?? 0
        this.info.groupsTotal = resp?.groupsTotal ?? 0
        this.info.pagesTotal = resp?.pagesTotal ?? 0
        this.info.usersTotal = resp?.usersTotal ?? 0
        this.info.webhooksTotal = resp?.webhooksTotal ?? 0
        this.info.loginsPastDay = resp?.loginsPastDay ?? 0
        this.info.currentVersion = resp?.currentVersion ?? 'n/a'
        this.info.latestVersion = resp?.latestVersion ?? 'n/a'
        this.info.isApiEnabled = resp?.isApiEnabled ?? false
        this.info.isMetricsEnabled = resp?.isMetricsEnabled ?? false
        this.info.isPageviewsEnabled = resp?.isPageviewsEnabled ?? false
        this.info.isMailConfigured = resp?.isMailConfigured ?? false
        this.info.isSchedulerHealthy = resp?.isSchedulerHealthy ?? false
      } catch (err) {
        notify.negative('Failed to load system info.', err.message)
      }
    },
    async fetchSites() {
      try {
        this.sites = (await API_CLIENT.get('sites').json()) ?? []
        if (!this.currentSiteId && this.sites.length > 0) {
          this.currentSiteId = this.sites[0].id
        }
      } catch (err) {
        notify.negative('Failed to load sites.', err.message)
      }
    },
    async fetchClassificationLevels() {
      try {
        this.classificationLevels = (await API_CLIENT.get('classification-levels').json()) ?? []
      } catch (err) {
        notify.negative('Failed to load classification levels.', err.message)
      }
    }
  }
})
