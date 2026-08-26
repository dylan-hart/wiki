import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsoluteHttpUrl, isFollowableRedirectTarget } from './redirectTarget.ts'

describe('isFollowableRedirectTarget', () => {
  test('accepts a bare rooted path', () => {
    assert.equal(isFollowableRedirectTarget('/some/page'), true)
  })

  test('accepts a complete https:// URL', () => {
    assert.equal(isFollowableRedirectTarget('https://example.com/page'), true)
  })

  test('accepts a complete http:// URL', () => {
    assert.equal(isFollowableRedirectTarget('http://example.com/page'), true)
  })

  test('rejects a protocol-relative path', () => {
    assert.equal(isFollowableRedirectTarget('//evil.example'), false)
  })

  test('rejects a backslash-rooted path -- browsers normalise it to //', () => {
    assert.equal(isFollowableRedirectTarget('/\\evil.example'), false)
  })

  test('rejects javascript: regardless of quoting', () => {
    assert.equal(isFollowableRedirectTarget('javascript:alert(1)'), false)
  })

  test('rejects javascript:// dressed up to fool a scheme-prefix regex', () => {
    // -> `javascript://%0aalert(1)`: to a naive `/^[a-z][a-z0-9+.-]*:\/\//i` test this reads as
    //    scheme "javascript" followed by "//", same as any legitimate absolute URL. Parsing it as a
    //    real URL and checking .protocol (still "javascript:") is what actually refuses it.
    assert.equal(isFollowableRedirectTarget('javascript://%0aalert(1)'), false)
  })

  test('rejects data: URLs', () => {
    assert.equal(isFollowableRedirectTarget('data:text/html,<script>alert(1)</script>'), false)
  })

  test('rejects an empty or blank target', () => {
    assert.equal(isFollowableRedirectTarget(''), false)
    assert.equal(isFollowableRedirectTarget('   '), false)
    assert.equal(isFollowableRedirectTarget(null), false)
    assert.equal(isFollowableRedirectTarget(undefined), false)
  })

  test('rejects a scheme-less, non-rooted string', () => {
    assert.equal(isFollowableRedirectTarget('example.com/page'), false)
  })

  test('tolerates surrounding whitespace', () => {
    assert.equal(isFollowableRedirectTarget('  /some/page  '), true)
  })
})

describe('isAbsoluteHttpUrl', () => {
  test('accepts http and https', () => {
    assert.equal(isAbsoluteHttpUrl('http://example.com'), true)
    assert.equal(isAbsoluteHttpUrl('https://example.com'), true)
  })

  test('rejects a non-http(s) scheme even when parseable', () => {
    assert.equal(isAbsoluteHttpUrl('javascript:alert(1)'), false)
    assert.equal(isAbsoluteHttpUrl('data:text/html,x'), false)
    assert.equal(isAbsoluteHttpUrl('ftp://example.com/file'), false)
  })

  test('rejects a value that does not parse as a URL at all', () => {
    assert.equal(isAbsoluteHttpUrl('/relative/path'), false)
    assert.equal(isAbsoluteHttpUrl('not a url'), false)
  })
})
