import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useSiteStore } from './site.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 716: `locales.active`
 * descriptors must carry a real `isRTL` signal so App.vue can set `dir` on `<html>` without a second
 * request to `/_api/locales`.
 */
describe('site store: applySiteInfo() locale direction', () => {
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

  it('marks RTL script locales (Arabic, Hebrew) as isRTL: true', () => {
    const store = useSiteStore()
    store.applySiteInfo(baseSiteInfo())

    const byCode = Object.fromEntries(store.locales.active.map((l) => [l.code, l]))
    expect(byCode.ar.isRTL).toBe(true)
    expect(byCode.he.isRTL).toBe(true)
  })

  it('marks LTR script locales (English, French) as isRTL: false', () => {
    const store = useSiteStore()
    store.applySiteInfo(baseSiteInfo())

    const byCode = Object.fromEntries(store.locales.active.map((l) => [l.code, l]))
    expect(byCode.en.isRTL).toBe(false)
    expect(byCode.fr.isRTL).toBe(false)
  })

  it('falls back to isRTL: false for a malformed locale code rather than throwing', () => {
    const store = useSiteStore()
    store.applySiteInfo(
      baseSiteInfo({ locales: { primary: 'en', showMenu: true, active: ['not-a-real-tag-🎈'] } })
    )

    expect(store.locales.active[0].isRTL).toBe(false)
  })

  it('defaults the initial state to a single, LTR "en" entry', () => {
    const store = useSiteStore()

    expect(store.locales.active).toEqual([
      { code: 'en', language: 'en', name: 'English', nativeName: 'English', isRTL: false }
    ])
  })

  /**
   * Regression coverage for feature 413, task 727: a real Chromium build (verified live via
   * Playwright, not assumed) implements `Intl.Locale.prototype.getTextInfo()` as a METHOD and has no
   * `.textInfo` getter at all -- the shape every other test in this file exercises, because that is
   * what this sandbox's Node happens to expose instead. Reading `.textInfo.direction` unconditionally
   * (as `describeLocales()` did before this task) throws on a real Chrome `Intl.Locale`, silently
   * caught and defaulted to `isRTL: false` for every locale -- i.e. `dir="rtl"` would never actually
   * apply for a real reader, regardless of everything built on top of it. This locks the fix in by
   * removing the getter Node exposes and simulating the method-only, Chrome-shaped object instead.
   */
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
