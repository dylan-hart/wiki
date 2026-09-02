import { vi } from 'vitest'

import { useSiteStore } from './site.js'

/**
 * The two fixtures the page store's four suites share, lifted out when the single 1,215-line
 * `stores/page.test.js` was split by concern (TEST-F14) -- each was a byte-identical copy in more
 * than one shard.
 *
 * A sibling module rather than a `*.test.js`, matching `pages/graphFixtures.js` and the two
 * component harnesses: `vitest.config.js` collects only `*.test.js`, so this is imported and never
 * run as a suite of its own.
 */

/** The `API_CLIENT.get` response `pageLoad`/`pageEdit` expect, with only what a test cares about overridden. */
export function stubPageResponse(overrides = {}) {
  return {
    json: vi.fn().mockResolvedValue({
      id: 'page-1',
      relations: [],
      tocDepth: { min: 1, max: 2 },
      ...overrides
    })
  }
}

/** A site with two active locales, `en` primary — the shape `useLocales` and the prefix rule need. */
export function makeMultiLocaleSite({ forcePrefix = false } = {}) {
  const siteStore = useSiteStore()
  siteStore.$patch({
    id: 'site-1',
    locales: {
      primary: 'en',
      showMenu: true,
      forcePrefix,
      active: [
        { code: 'en', language: 'en', name: 'English', nativeName: 'English' },
        { code: 'fr', language: 'fr', name: 'French', nativeName: 'Français' }
      ]
    }
  })
  return siteStore
}
