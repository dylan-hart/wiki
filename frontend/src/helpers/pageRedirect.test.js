import { describe, expect, it } from 'vitest'

import {
  emptyRedirect,
  isFollowable,
  parseRedirect,
  resolveRedirectTarget,
  serializeRedirect
} from './pageRedirect.js'

const activeLocaleCodes = ['en', 'fr']
// -> The shape `siteStore.localeRouting` builds (see `stores/site.js`), which is what
//   `shouldPrefixLocale`/`localizedPagePath` actually take on the frontend -- not the backend's
//   `LocaleRoutingConfig` (`{ primary, active, forcePrefix }`), which looks similar but isn't it.
const siteLocales = { useLocales: true, primary: 'en', forcePrefix: false }

describe('parseRedirect', () => {
  it('parses a well-formed page redirection', () => {
    expect(
      parseRedirect(JSON.stringify({ kind: 'page', target: '/foo/bar', showInterstitial: true }))
    ).toEqual({
      kind: 'page',
      target: '/foo/bar',
      showInterstitial: true
    })
  })

  it('falls back to an empty redirection for unparseable content', () => {
    expect(parseRedirect('not json')).toEqual({ kind: 'page', target: '', showInterstitial: false })
    expect(parseRedirect(undefined)).toEqual({ kind: 'page', target: '', showInterstitial: false })
  })
})

describe('serializeRedirect', () => {
  it('round-trips through parseRedirect', () => {
    const serialized = serializeRedirect({
      kind: 'url',
      target: ' https://example.com ',
      showInterstitial: true
    })
    expect(parseRedirect(serialized)).toEqual({
      kind: 'url',
      target: 'https://example.com',
      showInterstitial: true
    })
  })
})

describe('isFollowable', () => {
  it('follows a rooted page target', () => {
    expect(isFollowable({ kind: 'page', target: '/foo/bar' })).toBe(true)
  })

  it('refuses a page target with no leading slash', () => {
    expect(isFollowable({ kind: 'page', target: 'foo/bar' })).toBe(false)
  })

  it('refuses a protocol-relative page target', () => {
    expect(isFollowable({ kind: 'page', target: '//evil.example.com' })).toBe(false)
  })

  it('follows a well-formed http(s) URL target', () => {
    expect(isFollowable({ kind: 'url', target: 'https://example.com' })).toBe(true)
  })

  it('refuses a javascript: URL target', () => {
    expect(isFollowable({ kind: 'url', target: 'javascript:alert(1)' })).toBe(false)
  })

  it('refuses an empty target', () => {
    expect(isFollowable({ kind: 'page', target: '' })).toBe(false)
    expect(isFollowable(undefined)).toBe(false)
  })
})

describe('emptyRedirect', () => {
  it('is not followable', () => {
    expect(isFollowable(emptyRedirect())).toBe(false)
  })
})

describe('resolveRedirectTarget', () => {
  it("localizes a bare, well-formed target to the reader's current locale", () => {
    expect(resolveRedirectTarget('/foo/bar', activeLocaleCodes, 'fr', siteLocales)).toBe(
      '/fr/foo/bar'
    )
  })

  it('leaves a target already carrying a recognized locale prefix untouched', () => {
    expect(resolveRedirectTarget('/fr/foo/bar', activeLocaleCodes, 'en', siteLocales)).toBe(
      '/fr/foo/bar'
    )
  })

  it('does not prefix a target addressed at the primary locale', () => {
    expect(resolveRedirectTarget('/foo/bar', activeLocaleCodes, 'en', siteLocales)).toBe('/foo/bar')
  })

  it('passes a malformed, non-slash-leading target through untouched rather than mangling it', () => {
    // -> Regression: this used to `.slice(1)` unconditionally, turning 'foo/bar' into the
    //    mangled 'oo/bar' -- eating the real leading 'f' -- because it assumed every target was
    //    slash-leading. `isFollowable` already refuses anything without a leading slash, so the
    //    only observable effect of the old bug was a mangled diagnostic caption.
    expect(resolveRedirectTarget('foo/bar', activeLocaleCodes, 'en', siteLocales)).toBe('foo/bar')
  })

  it('passes a single malformed character through untouched', () => {
    expect(resolveRedirectTarget('x', activeLocaleCodes, 'en', siteLocales)).toBe('x')
  })

  it('passes an empty target through untouched', () => {
    expect(resolveRedirectTarget('', activeLocaleCodes, 'en', siteLocales)).toBe('')
  })
})
