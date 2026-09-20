/**
 * Whether saving a site's config just moved its hostname away from `oldHostname` -- what tells
 * `AdminGeneral.vue`'s save handler not to re-resolve the site it is browsing. `updateSite()`
 * (`backend/models/sites.ts`) reloads the server's site cache synchronously on every patch, so once
 * the PUT resolves nothing maps `oldHostname` to this site any more: re-resolving the browser's
 * still-old `window.location.hostname` would land on whatever other site now claims that hostname,
 * or on nothing, and load a different site's config into `siteStore` with no warning.
 *
 * An empty `newHostname` counts as "no change": the caller has no confirmed value to compare
 * against, not a known non-rename.
 */
export function hostnameRenamedAway(oldHostname, newHostname) {
  return Boolean(newHostname) && newHostname !== oldHostname
}
