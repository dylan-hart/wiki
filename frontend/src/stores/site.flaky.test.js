import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * QUARANTINED — this file is in the `*.flaky.*` lane and does NOT run under `npm run test`. It runs
 * under `npm run test:flaky`, which CI reports on but does not gate on. See
 * `docs/decisions/flaky-test-quarantine.md` for the lane's rules.
 *
 * **Expires 2026-12-06.** By then this test is either fixed or deleted.
 *
 * **Why it is here.** Regression coverage for feature 413, task 727: a real Chromium build
 * implements `Intl.Locale.prototype.getTextInfo()` as a METHOD with no `.textInfo` getter, unlike
 * this sandbox's Node. This test simulates that shape by subclassing the real `Intl.Locale`,
 * reassigning the global synchronously, and restoring it in a `finally` -- there is no `await`
 * anywhere in the body. Observed failing once in CI (`byCode.ar.isRTL` read `false` instead of
 * `true`), not reproducible locally and not reproduced on the immediately following CI run against
 * the identical commit. The exact mechanism is unconfirmed -- see OpenProject #2738 for what was
 * ruled out (this run's own code changes; an obvious concurrency bug inside the test itself, since
 * the mutation is synchronous and Vitest's default `isolate: true` should give each test file its
 * own realm).
 *
 * **The fix that retires it.** Reproduce it deliberately (repeat this test file many times under
 * CI's own Node/OS, or bisect Vitest's `isolate`/`pool` settings) to pin down the real mechanism,
 * then fix it directly rather than re-guessing from a single occurrence.
 */
describe('site store: applySiteInfo() locale direction — Chrome-shaped Intl.Locale', () => {
  function baseSiteInfo(overrides = {}) {
    return {
      id: 'site-1',
      hostname: 'example.com',
      title: 'Test Wiki',
      description: '',
      logoText: true,
      company: '',
      contentLicense: '',
      footerExtra: '',
      features: {},
      auth: {},
      editors: {
        asciidoc: { isActive: false },
        code: { isActive: false },
        markdown: { isActive: true },
        wysiwyg: { isActive: false }
      },
      locales: {
        primary: 'en',
        showMenu: true,
        active: ['en', 'ar', 'he', 'fr']
      },
      theme: {},
      ...overrides
    }
  }

  it('still resolves isRTL correctly against a Chrome-shaped Intl.Locale (getTextInfo() method, no .textInfo getter)', () => {
    const RealLocale = Intl.Locale
    class ChromeShapedLocale extends RealLocale {
      get textInfo() {
        throw new TypeError('textInfo is not a function or its return value is not iterable')
      }
      getTextInfo() {
        return { direction: new RealLocale(this.toString()).textInfo.direction }
      }
    }
    Intl.Locale = ChromeShapedLocale
    try {
      const store = useSiteStore()
      store.applySiteInfo(baseSiteInfo())

      const byCode = Object.fromEntries(store.locales.active.map((l) => [l.code, l]))
      expect(byCode.ar.isRTL).toBe(true)
      expect(byCode.he.isRTL).toBe(true)
      expect(byCode.en.isRTL).toBe(false)
    } finally {
      Intl.Locale = RealLocale
    }
  })
})
