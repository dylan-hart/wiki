import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { absoluteRedirectsAllowed, isFollowableRedirectTarget } from './redirectTarget.ts'
import { installTestWiki } from '../test/mocks.ts'

installTestWiki({ config: { security: { disallowOpenRedirect: true } } })

describe('isFollowableRedirectTarget', () => {
  test('refuses a protocol-relative //host target', () => {
    assert.equal(isFollowableRedirectTarget('//evil.example'), false)
  })

  test('refuses a /\\host target (browsers normalize it to //)', () => {
    assert.equal(isFollowableRedirectTarget('/\\evil.example'), false)
  })

  test('refuses javascript:', () => {
    assert.equal(isFollowableRedirectTarget('javascript:alert(1)'), false)
  })

  test('refuses javascript://%0aalert(1) (the naive scheme-prefix regex is fooled by this one)', () => {
    assert.equal(isFollowableRedirectTarget('javascript://%0aalert(1)'), false)
  })

  test('refuses data:', () => {
    assert.equal(isFollowableRedirectTarget('data:text/html,<script>alert(1)</script>'), false)
  })

  test('refuses an unparseable string', () => {
    assert.equal(isFollowableRedirectTarget('not a url at all'), false)
  })

  test('refuses a non-string value', () => {
    assert.equal(isFollowableRedirectTarget(undefined), false)
    assert.equal(isFollowableRedirectTarget(null), false)
    assert.equal(isFollowableRedirectTarget(42), false)
  })

  test('refuses an empty or blank string', () => {
    assert.equal(isFollowableRedirectTarget(''), false)
    assert.equal(isFollowableRedirectTarget('   '), false)
  })

  test('accepts a bare rooted path', () => {
    assert.equal(isFollowableRedirectTarget('/some/page'), true)
  })

  test('accepts an absolute https:// URL', () => {
    assert.equal(isFollowableRedirectTarget('https://example.com/page'), true)
  })

  test('accepts an absolute http:// URL', () => {
    assert.equal(isFollowableRedirectTarget('http://example.com/page'), true)
  })

  test('allowAbsolute: false still accepts a rooted path', () => {
    assert.equal(isFollowableRedirectTarget('/some/page', { allowAbsolute: false }), true)
  })

  test('allowAbsolute: false refuses an otherwise-valid absolute URL -- the disallowOpenRedirect switch', () => {
    assert.equal(
      isFollowableRedirectTarget('https://example.com/page', { allowAbsolute: false }),
      false
    )
  })

  test('allowedProtocols can be widened for a sink that legitimately allows more, e.g. mailto:/tel: on a navigation item', () => {
    const options = { allowedProtocols: ['http:', 'https:', 'mailto:', 'tel:'] }
    assert.equal(isFollowableRedirectTarget('mailto:person@example.com', options), true)
    assert.equal(isFollowableRedirectTarget('tel:+15555550100', options), true)
    // -> Widening the allowlist never re-admits a scheme not named on it
    assert.equal(isFollowableRedirectTarget('javascript:alert(1)', options), false)
  })
})

describe('absoluteRedirectsAllowed', () => {
  test('reflects CARDINAL.config.security.disallowOpenRedirect, inverted', () => {
    ;(globalThis as any).CARDINAL.config.security.disallowOpenRedirect = true
    assert.equal(absoluteRedirectsAllowed(), false)
    ;(globalThis as any).CARDINAL.config.security.disallowOpenRedirect = false
    assert.equal(absoluteRedirectsAllowed(), true)
    ;(globalThis as any).CARDINAL.config.security.disallowOpenRedirect = true
  })
})
