import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isFollowableRedirect } from './redirect.ts'

describe('isFollowableRedirect', () => {
  test('accepts a bare rooted path', () => {
    assert.equal(isFollowableRedirect('/admin/dashboard'), true)
  })

  test('accepts a complete https:// URL by default (allowExternal: true)', () => {
    assert.equal(isFollowableRedirect('https://example.com/path'), true)
  })

  test('accepts a complete http:// URL by default', () => {
    assert.equal(isFollowableRedirect('http://example.com/path'), true)
  })

  test('refuses a scheme-relative //host target — the leading-slash check this replaces would have passed it', () => {
    assert.equal(isFollowableRedirect('//attacker.example'), false)
    assert.equal(isFollowableRedirect('//attacker.example/phish'), false)
  })

  test('refuses a backslash-leading /\\host target — browsers normalize it to // too', () => {
    assert.equal(isFollowableRedirect('/\\attacker.example'), false)
  })

  test('refuses javascript: outright, unlike a bare new URL(...).protocol check', () => {
    assert.equal(isFollowableRedirect('javascript:alert(1)'), false)
  })

  test('refuses an obfuscated javascript: URL using a newline comment before the real scheme check would see it', () => {
    assert.equal(isFollowableRedirect('javascript://%0aalert(1)'), false)
  })

  test('refuses data:', () => {
    assert.equal(isFollowableRedirect('data:text/html,<script>alert(1)</script>'), false)
  })

  test('refuses an empty or whitespace-only value', () => {
    assert.equal(isFollowableRedirect(''), false)
    assert.equal(isFollowableRedirect('   '), false)
  })

  test('refuses a non-string value without throwing', () => {
    assert.equal(isFollowableRedirect(undefined), false)
    assert.equal(isFollowableRedirect(null), false)
    assert.equal(isFollowableRedirect(42), false)
    assert.equal(isFollowableRedirect({}), false)
  })

  test('refuses a relative (non-rooted) path — not a valid destination either way', () => {
    assert.equal(isFollowableRedirect('admin/dashboard'), false)
  })

  describe('allowExternal: false — the login/logout-redirect fields with disallowOpenRedirect on', () => {
    test('still accepts a rooted path', () => {
      assert.equal(isFollowableRedirect('/admin/dashboard', { allowExternal: false }), true)
    })

    test('refuses an otherwise-valid https:// URL', () => {
      assert.equal(
        isFollowableRedirect('https://example.com/path', { allowExternal: false }),
        false
      )
    })

    test('still refuses //host and javascript: the same as the default', () => {
      assert.equal(isFollowableRedirect('//attacker.example', { allowExternal: false }), false)
      assert.equal(isFollowableRedirect('javascript:alert(1)', { allowExternal: false }), false)
    })
  })
})
