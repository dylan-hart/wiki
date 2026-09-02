import { vi } from 'vitest'

/**
 * The store seeds `mountWithApp`'s `stores` option takes, plus the router stub the page store wants.
 *
 * Seeding in this corpus is single-field, not object-literal: `siteStore.id = 'site-1'` appears 92
 * times, `adminStore.currentSiteId = 'site-1'` 15, `pageStore.id = 'page-1'` 11,
 * `userStore.permissions = [...]` 8. So each seed here is just that one repeated identity field,
 * with everything else supplied per call -- these are not "a realistic site/user/page object", and
 * deliberately so: a fat default would silently satisfy a component whose test meant to prove it
 * copes with a field being absent.
 *
 * Seeding is never automatic. Nothing writes to a store unless a mount names it (see `mount.js`) --
 * `pages/ProfileInfo.test.js` and several others assert against stores nothing has touched.
 */
export function seedSite(overrides = {}) {
  return { id: 'site-1', ...overrides }
}

export function seedUser(overrides = {}) {
  return { permissions: [], ...overrides }
}

export function seedPage(overrides = {}) {
  return { id: 'page-1', ...overrides }
}

export function seedAdmin(overrides = {}) {
  return { currentSiteId: 'site-1', ...overrides }
}

/**
 * The `router` the page store navigates through (`stores/page.js` assigns it at boot and calls it
 * from `pageCreate`/`pageMove`/...). Four local copies existed with three different defaults, each
 * carrying only the one method its own tests happened to reach: this carries BOTH `push` and
 * `replace`, since a stub missing either fails as a `TypeError` deep inside the action rather than
 * as a readable assertion.
 *
 * `path` sets both `path` and `fullPath` on the current route, which is all any caller reads.
 */
export function stubRouter(overrides = {}) {
  const { path = '/some/page', ...rest } = overrides
  return {
    currentRoute: { value: { path, fullPath: path } },
    push: vi.fn(),
    replace: vi.fn(),
    ...rest
  }
}
