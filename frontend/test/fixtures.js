import { vi } from 'vitest'

/**
 * The store seeds `mountWithApp`'s `stores` option takes, plus the router stub the page store wants.
 *
 * Each seed is a single repeated identity field, not a realistic object -- deliberately so, since a
 * fat default would silently satisfy a component whose test meant to prove it copes with a field
 * being absent. Seeding is never automatic: nothing writes to a store unless a mount names it (see
 * `mount.js`).
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
 * The `router` stub the page store navigates through (`stores/page.js` calls it from
 * `pageCreate`/`pageMove`/...). Carries both `push` and `replace` so a missing one fails as a
 * readable assertion rather than a `TypeError` deep inside the action.
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
