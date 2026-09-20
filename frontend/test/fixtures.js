import { vi } from 'vitest'

/**
 * Each seed is a single identity field, not a realistic object: a fat default would silently
 * satisfy a component whose test meant to prove it copes with that field being absent.
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
 * Carries both `push` and `replace` so a store action reaching for the other one fails as a
 * readable assertion rather than a `TypeError` deep inside it.
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
