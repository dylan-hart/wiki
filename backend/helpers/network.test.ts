import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress, isValidOriginPattern, originMatchesAllowlist } from './network.ts'

describe('isPrivateAddress', () => {
  test('flags IPv4 loopback', () => {
    assert.equal(isPrivateAddress('127.0.0.1'), true)
    assert.equal(isPrivateAddress('127.255.255.255'), true)
  })

  test('flags IPv4 RFC 1918 ranges', () => {
    assert.equal(isPrivateAddress('10.0.0.1'), true)
    assert.equal(isPrivateAddress('172.16.0.1'), true)
    assert.equal(isPrivateAddress('172.31.255.255'), true)
    assert.equal(isPrivateAddress('192.168.1.1'), true)
  })

  test('flags the cloud metadata / link-local range', () => {
    assert.equal(isPrivateAddress('169.254.169.254'), true)
  })

  test('flags carrier-grade NAT and the "this network" range', () => {
    assert.equal(isPrivateAddress('100.64.0.1'), true)
    assert.equal(isPrivateAddress('0.0.0.0'), true)
  })

  test('does not flag a public IPv4 address', () => {
    assert.equal(isPrivateAddress('93.184.216.34'), false)
    assert.equal(isPrivateAddress('8.8.8.8'), false)
    // -> Adjacent to a private range but outside it -- a boundary check, not just any 172.x/192.x.
    assert.equal(isPrivateAddress('172.32.0.1'), false)
    assert.equal(isPrivateAddress('192.169.1.1'), false)
  })

  test('flags IPv6 loopback and unspecified', () => {
    assert.equal(isPrivateAddress('::1'), true)
    assert.equal(isPrivateAddress('::'), true)
  })

  test('flags IPv6 link-local and unique-local ranges', () => {
    assert.equal(isPrivateAddress('fe80::1'), true)
    assert.equal(isPrivateAddress('fc00::1'), true)
    assert.equal(isPrivateAddress('fd12:3456::1'), true)
  })

  test('does not flag a public IPv6 address', () => {
    assert.equal(isPrivateAddress('2606:4700:10::6814:179a'), false)
  })

  // -> The WHATWG URL parser (what actually produces `url.hostname`) always normalises an IPv4-mapped
  //    IPv6 literal into hex-group form and collapses `::` -- it can never emit the dotted-quad shape
  //    (`::ffff:169.254.169.254`) a previous version of this test asserted, so these hex-group forms
  //    are what a real caller (`models/liveData.ts`'s `assertNotPrivateAddress`, fed straight from
  //    `url.hostname`) actually has to check against (OpenProject #2236).
  test('flags an IPv4-mapped IPv6 address in the hex-group form URL.hostname actually emits', () => {
    assert.equal(isPrivateAddress('::ffff:a9fe:a9fe'), true) // ::ffff:169.254.169.254
    assert.equal(isPrivateAddress('::ffff:7f00:1'), true) // ::ffff:127.0.0.1
    assert.equal(isPrivateAddress('::ffff:c0a8:1'), true) // ::ffff:192.168.0.1
    assert.equal(isPrivateAddress('::ffff:808:808'), false) // ::ffff:8.8.8.8 -- public, not flagged
  })

  test('a bracketed IPv4-mapped URL hostname round-trips into a rejection', () => {
    const hostname = new URL('http://[::ffff:169.254.169.254]/').hostname.replace(/^\[|\]$/g, '')
    assert.equal(hostname, '::ffff:a9fe:a9fe')
    assert.equal(isPrivateAddress(hostname), true)
  })

  test('a non-IP-literal hostname is not itself flagged -- callers must resolve first', () => {
    assert.equal(isPrivateAddress('example.com'), false)
    assert.equal(isPrivateAddress('localhost'), false)
  })
})

describe('originMatchesAllowlist', () => {
  test('matches an exact origin with no path prefix', () => {
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com/metrics'), [
        'https://api.example.com'
      ]),
      true
    )
  })

  test('does not match a different hostname', () => {
    assert.equal(
      originMatchesAllowlist(new URL('https://evil.com/metrics'), ['https://api.example.com']),
      false
    )
  })

  test('does not match a different scheme', () => {
    assert.equal(
      originMatchesAllowlist(new URL('http://api.example.com/metrics'), [
        'https://api.example.com'
      ]),
      false
    )
  })

  test('matches case-insensitively on scheme and host', () => {
    assert.equal(
      originMatchesAllowlist(new URL('HTTPS://API.Example.COM/x'), ['https://api.example.com']),
      true
    )
  })

  test('a wildcard host pattern matches exactly one extra label', () => {
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com/x'), ['https://*.example.com']),
      true
    )
    assert.equal(
      originMatchesAllowlist(new URL('https://example.com/x'), ['https://*.example.com']),
      false
    )
    assert.equal(
      originMatchesAllowlist(new URL('https://a.b.example.com/x'), ['https://*.example.com']),
      false
    )
  })

  test('a path prefix matches the prefix itself and anything under it, not a longer sibling segment', () => {
    const allowed = ['https://api.example.com/v1']
    assert.equal(originMatchesAllowlist(new URL('https://api.example.com/v1'), allowed), true)
    assert.equal(originMatchesAllowlist(new URL('https://api.example.com/v1/'), allowed), true)
    assert.equal(originMatchesAllowlist(new URL('https://api.example.com/v1/sub'), allowed), true)
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com/v1-other'), allowed),
      false
    )
    assert.equal(originMatchesAllowlist(new URL('https://api.example.com/v2'), allowed), false)
  })

  test('no path prefix in the entry allows any path on that origin', () => {
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com/anything/at/all'), [
        'https://api.example.com'
      ]),
      true
    )
  })

  test('a differing explicit port does not match', () => {
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com:8443/x'), [
        'https://api.example.com'
      ]),
      false
    )
  })

  test('an entry naming the scheme default port matches a URL that omits it, and vice versa', () => {
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com/x'), ['https://api.example.com:443']),
      true
    )
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com:443/x'), ['https://api.example.com']),
      true
    )
  })

  test('matches a bracketed IPv6 literal entry against the bracketed hostname a real IPv6 URL produces', () => {
    const url = new URL('https://[2606:4700:10::6814:179a]/path')
    assert.equal(originMatchesAllowlist(url, ['https://[2606:4700:10::6814:179a]']), true)
  })

  test('an empty allowlist matches nothing', () => {
    assert.equal(originMatchesAllowlist(new URL('https://api.example.com/x'), []), false)
  })

  test('matches when any one of several entries matches', () => {
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com/x'), [
        'https://other.com',
        'https://*.example.com'
      ]),
      true
    )
  })
})

describe('isValidOriginPattern', () => {
  test('accepts an origin with no path', () => {
    assert.equal(isValidOriginPattern('https://api.example.com'), true)
    assert.equal(isValidOriginPattern('http://example.com'), true)
  })

  test('accepts an origin with a path prefix', () => {
    assert.equal(isValidOriginPattern('https://api.example.com/v1'), true)
    assert.equal(isValidOriginPattern('https://api.example.com/v1/data'), true)
  })

  test('accepts an explicit port', () => {
    assert.equal(isValidOriginPattern('https://api.example.com:8443/v1'), true)
  })

  test('accepts a *.-prefixed wildcard host', () => {
    assert.equal(isValidOriginPattern('https://*.example.com'), true)
  })

  test('accepts a bracketed IPv6 literal host', () => {
    assert.equal(isValidOriginPattern('https://[::1]'), true)
    assert.equal(isValidOriginPattern('https://[2606:4700:10::6814:179a]/v1'), true)
  })

  test('rejects a bare hostname with no scheme', () => {
    assert.equal(isValidOriginPattern('api.example.com'), false)
    assert.equal(isValidOriginPattern('api.example.com/v1'), false)
  })

  test('rejects a non-http(s) scheme', () => {
    assert.equal(isValidOriginPattern('ftp://api.example.com'), false)
    assert.equal(isValidOriginPattern('file:///etc/passwd'), false)
    assert.equal(isValidOriginPattern('javascript://api.example.com'), false)
  })

  test('rejects a pattern carrying a query string', () => {
    assert.equal(isValidOriginPattern('https://api.example.com/v1?x=1'), false)
  })

  test('rejects a pattern carrying a fragment', () => {
    assert.equal(isValidOriginPattern('https://api.example.com/v1#frag'), false)
  })

  test('rejects more than one wildcard label', () => {
    assert.equal(isValidOriginPattern('https://*.*.example.com'), false)
  })

  test('rejects a wildcard not at the start of the host', () => {
    assert.equal(isValidOriginPattern('https://api.*.example.com'), false)
  })

  // -> No userinfo has any business in a stored allowlist entry, and `new URL()` itself would
  //    silently accept and discard it -- checked explicitly rather than left to the regex, which
  //    already rejects most such strings only incidentally (OpenProject #2198).
  test('rejects userinfo in the origin', () => {
    assert.equal(isValidOriginPattern('https://user:pass@api.example.com/v1'), false)
  })

  test('rejects whitespace', () => {
    assert.equal(isValidOriginPattern('https://api example.com'), false)
    assert.equal(isValidOriginPattern(' https://api.example.com'), false)
  })

  test('rejects an empty string', () => {
    assert.equal(isValidOriginPattern(''), false)
  })
})
