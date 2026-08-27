import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18n, _resetI18nCache, t } from './i18n.js'

/**
 * Part of OpenProject #1624/#1635. Covers both call shapes the file header documents: the plain
 * async `t()` for a lifecycle method that can await, and the `I18n` Lit reactive controller for a
 * synchronous `render()` call site -- plus the fallback (both to English, and to a caller's own raw
 * string) that is the whole reason this file exists rather than reading `en.json` directly.
 */

/** Stubs `fetch('/_api/locales/:code/strings')` from a `{ locale: strings }` map. */
function stubLocales(byLocale) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url) => {
      const match = /\/_api\/locales\/([^/]+)\/strings/.exec(url)
      const strings = match ? byLocale[match[1]] : undefined
      return Promise.resolve({
        ok: strings !== undefined,
        json: () => Promise.resolve(strings ?? [])
      })
    })
  )
}

beforeEach(() => {
  _resetI18nCache()
  document.documentElement.lang = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.lang = ''
})

describe('t()', () => {
  it("resolves a key against the page's locale", async () => {
    document.documentElement.lang = 'fr'
    stubLocales({
      en: { 'blocks.qr-code.errors.tooLong': 'Too long.' },
      fr: { 'blocks.qr-code.errors.tooLong': 'Trop long.' }
    })

    await expect(t('blocks.qr-code.errors.tooLong', 'fallback')).resolves.toBe('Trop long.')
  })

  it('falls back to English when the page locale is missing the key', async () => {
    document.documentElement.lang = 'fr'
    stubLocales({
      en: { 'blocks.qr-code.errors.tooLong': 'Too long.' },
      fr: {}
    })

    await expect(t('blocks.qr-code.errors.tooLong', 'fallback')).resolves.toBe('Too long.')
  })

  it("falls back to the caller's own raw string, not the key, when neither locale has it", async () => {
    document.documentElement.lang = 'fr'
    stubLocales({ en: {}, fr: {} })

    await expect(t('blocks.qr-code.errors.tooLong', 'This is too long.')).resolves.toBe(
      'This is too long.'
    )
  })

  it('falls back the same way when the fetch itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down')))
    )

    await expect(t('blocks.qr-code.errors.tooLong', 'This is too long.')).resolves.toBe(
      'This is too long.'
    )
  })

  it('interpolates {param} placeholders in both the resolved and the fallback string', async () => {
    stubLocales({ en: { 'blocks.include.errors.pageNotFound': 'There is no page at "{path}".' } })

    await expect(
      t('blocks.include.errors.pageNotFound', 'fallback', { path: '/foo' })
    ).resolves.toBe('There is no page at "/foo".')
    await expect(
      t('blocks.include.errors.includeFailed', 'The page "{path}" failed.', { path: '/bar' })
    ).resolves.toBe('The page "/bar" failed.')
  })

  it('never rejects on an unknown locale code (the endpoint answers [])', async () => {
    document.documentElement.lang = 'xx'
    stubLocales({ en: {} })

    await expect(t('blocks.qr-code.errors.tooLong', 'This is too long.')).resolves.toBe(
      'This is too long.'
    )
  })
})

describe('I18n controller', () => {
  function makeHost() {
    return { addController: vi.fn(), requestUpdate: vi.fn() }
  }

  it('returns the fallback synchronously before the dictionary has loaded', () => {
    stubLocales({ en: { 'blocks.qr-code.errors.tooLong': 'Too long.' } })
    const host = makeHost()
    const i18n = new I18n(host)

    expect(i18n.t('blocks.qr-code.errors.tooLong', 'fallback')).toBe('fallback')
  })

  it('resolves the real string and calls requestUpdate exactly once the dictionary lands', async () => {
    stubLocales({ en: { 'blocks.qr-code.errors.tooLong': 'Too long.' } })
    const host = makeHost()
    const i18n = new I18n(host)
    i18n.hostConnected()

    await vi.waitFor(() => expect(host.requestUpdate).toHaveBeenCalledTimes(1))
    expect(i18n.t('blocks.qr-code.errors.tooLong', 'fallback')).toBe('Too long.')
  })

  it('keeps returning the fallback after loading when neither locale has the key', async () => {
    stubLocales({ en: {} })
    const host = makeHost()
    const i18n = new I18n(host)
    i18n.hostConnected()

    await vi.waitFor(() => expect(host.requestUpdate).toHaveBeenCalledTimes(1))
    expect(i18n.t('blocks.qr-code.errors.tooLong', 'This is too long.')).toBe('This is too long.')
  })
})
