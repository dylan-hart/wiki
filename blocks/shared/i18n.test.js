import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetLocaleStringsCache, currentLocale, t } from './i18n.js'

function stubStrings(strings) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => strings
    })
  )
}

/*
 * OpenProject #1635: `t()` is `blocks/`'s own resolver for a reader-facing error string a block only
 * discovers it needs at runtime (an invalid URL, an overflowing QR payload, a page that turned out
 * not to exist) -- see the file header for why that rules out the renderer-passed-attributes
 * alternative the audit also named. It reads the locale off `<html lang>` (set by
 * `App.vue#applyLocale`) and resolves against the same public `/_api/locales/:code/strings` endpoint
 * `vue-i18n` loads for the app's own chrome.
 */
describe('shared/i18n.js: currentLocale()', () => {
  afterEach(() => {
    document.documentElement.lang = ''
  })

  it('reads the locale off <html lang>', () => {
    document.documentElement.lang = 'fr'

    expect(currentLocale()).toBe('fr')
  })

  it('falls back to en when <html lang> is unset', () => {
    document.documentElement.lang = ''

    expect(currentLocale()).toBe('en')
  })
})

describe('shared/i18n.js: t()', () => {
  beforeEach(() => {
    // -> One cached fetch per locale for the module's lifetime (one request per page load); each
    //    test needs its own stubbed response, so the cache must not survive between them -- the same
    //    reason ./config.test.js resets its own cache.
    _resetLocaleStringsCache()
    document.documentElement.lang = 'fr'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.lang = ''
  })

  it('resolves a key that has a translation in the current locale', async () => {
    stubStrings({ 'blocks.youtube.invalidUrl': 'Ceci n’est pas une adresse de vidéo YouTube.' })

    expect(await t('blocks.youtube.invalidUrl', 'This is not a YouTube video address.')).toBe(
      'Ceci n’est pas une adresse de vidéo YouTube.'
    )
  })

  it('falls back to the English string for a key with no translation', async () => {
    stubStrings({ 'blocks.youtube.invalidUrl': 'Ceci n’est pas une adresse de vidéo YouTube.' })

    expect(await t('blocks.qrCode.tooLong', 'This is too long to fit in a QR code.')).toBe(
      'This is too long to fit in a QR code.'
    )
  })

  it('falls back to the English string when the locale is unknown to the server', async () => {
    // -> getStrings() answers [] for a locale code it doesn't recognise, per backend/api/locales.ts
    stubStrings([])

    expect(await t('blocks.qrCode.tooLong', 'This is too long to fit in a QR code.')).toBe(
      'This is too long to fit in a QR code.'
    )
  })

  it('falls back to the English string when the strings request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    expect(await t('blocks.qrCode.tooLong', 'This is too long to fit in a QR code.')).toBe(
      'This is too long to fit in a QR code.'
    )
  })

  it('shares one request across concurrent callers for the same locale', async () => {
    stubStrings({ 'blocks.include.noPage': 'Il n’y a pas de page à "{path}".' })

    await Promise.all([
      t('blocks.include.noPage', 'fallback'),
      t('blocks.include.noPage', 'fallback')
    ])

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
