/**
 * Whether saving a site's config just moved its hostname away from `oldHostname`.
 *
 * This is the fact that decides what `AdminGeneral.vue`'s save handler does next for the site the
 * admin is *currently browsing while administering it*: `updateSite()` (`backend/models/sites.ts`)
 * calls `reloadCache()` synchronously on every patch, so the moment the PUT resolves, `WIKI.sites` /
 * `WIKI.sitesMappings` no longer map `oldHostname` to this site at all -- there is nothing left for
 * the old hostname to have "become" on the server. Re-resolving the browser's still-old
 * `window.location.hostname` past that point cannot know it was renamed; it either lands on
 * whatever other site (if any) now claims that hostname, or resolves nothing. Comparing the two
 * hostnames up front is what lets the caller skip that stale reload instead of mis-loading a
 * different site's config into `siteStore` with no warning.
 *
 * An empty/undefined `newHostname` is treated as "no change" rather than "false" for a different
 * reason: it means the caller has no confirmed new value to compare against (e.g. the field was
 * never submitted), not that a rename is known not to have happened.
 *
 * @param {string} oldHostname The hostname this site was serving before the save.
 * @param {string | undefined} newHostname The hostname just written by the save.
 * @returns {boolean}
 */
export function hostnameRenamedAway(oldHostname, newHostname) {
  return Boolean(newHostname) && newHostname !== oldHostname
}
