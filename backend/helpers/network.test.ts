import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress, isValidOriginPrefixPattern, urlMatchesAllowlist } from './network.ts'

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

  test('flags an IPv4-mapped IPv6 address by its embedded address', () => {
    assert.equal(isPrivateAddress('::ffff:169.254.169.254'), true)
    assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false)
  })

  test('does not flag a public IPv6 address', () => {
    assert.equal(isPrivateAddress('2606:4700:10::6814:179a'), false)
  })

  test('a non-IP-literal hostname is not itself flagged -- callers must resolve first', () => {
    assert.equal(isPrivateAddress('example.com'), false)
    assert.equal(isPrivateAddress('localhost'), false)
  })
})

describe('urlMatchesAllowlist', () => {
  test('matches an exact origin with no path restriction', () => {
    assert.equal(
      urlMatchesAllowlist(new URL('https://api.example.com/anything'), ['https://api.example.com']),
      true
    )
  })

  test('does not match a different host', () => {
    assert.equal(
      urlMatchesAllowlist(new URL('https://evil.com/'), ['https://api.example.com']),
      false
    )
  })

  test('does not match a differing port', () => {
    assert.equal(
      urlMatchesAllowlist(new URL('https://api.example.com:8443/'), ['https://api.example.com']),
      false
    )
  })

  test('does not match a differing scheme', () => {
    assert.equal(
      urlMatchesAllowlist(new URL('http://api.example.com/'), ['https://api.example.com']),
      false
    )
  })

  test('a path prefix matches the exact prefix and anything nested under it', () => {
    assert.equal(
      urlMatchesAllowlist(new URL('https://api.example.com/v1'), ['https://api.example.com/v1']),
      true
    )
    assert.equal(
      urlMatchesAllowlist(new URL('https://api.example.com/v1/widgets'), [
        'https://api.example.com/v1'
      ]),
      true
    )
  })

  test('an off-prefix path on an allowed origin does not match', () => {
    assert.equal(
      urlMatchesAllowlist(new URL('https://api.example.com/v2/widgets'), [
        'https://api.example.com/v1'
      ]),
      false
    )
  })

  test('a path prefix is a segment boundary, not a bare string prefix', () => {
    // -> "/v1extra" merely starts with the four characters "/v1" -- a naive `startsWith` would wrongly
    //    let a "/v1" prefix cover this unrelated endpoint too.
    assert.equal(
      urlMatchesAllowlist(new URL('https://api.example.com/v1extra'), [
        'https://api.example.com/v1'
      ]),
      false
    )
  })

  test('an empty allowlist matches nothing', () => {
    assert.equal(urlMatchesAllowlist(new URL('https://api.example.com/'), []), false)
  })

  test('matches when any one of several patterns matches', () => {
    assert.equal(
      urlMatchesAllowlist(new URL('https://api.example.com/v1'), [
        'https://other.com',
        'https://api.example.com/v1'
      ]),
      true
    )
  })

  test('a malformed pattern in the list is skipped rather than thrown on', () => {
    assert.equal(
      urlMatchesAllowlist(new URL('https://api.example.com/'), [
        'not a url',
        'https://api.example.com'
      ]),
      true
    )
  })
})

describe('isValidOriginPrefixPattern', () => {
  test('accepts a bare https origin', () => {
    assert.equal(isValidOriginPrefixPattern('https://api.example.com'), true)
  })

  test('accepts an origin with a path prefix', () => {
    assert.equal(isValidOriginPrefixPattern('https://api.example.com/v1/widgets'), true)
  })

  test('accepts an explicit port', () => {
    assert.equal(isValidOriginPrefixPattern('http://internal.example.com:8080/api'), true)
  })

  test('accepts a plain http origin', () => {
    assert.equal(isValidOriginPrefixPattern('http://api.example.com'), true)
  })

  test('rejects a bare hostname with no scheme', () => {
    assert.equal(isValidOriginPrefixPattern('api.example.com'), false)
  })

  test('rejects a non-http(s) scheme', () => {
    assert.equal(isValidOriginPrefixPattern('ftp://api.example.com'), false)
    assert.equal(isValidOriginPrefixPattern('ws://api.example.com'), false)
  })

  test('rejects a pattern carrying a query string', () => {
    assert.equal(isValidOriginPrefixPattern('https://api.example.com/v1?token=abc'), false)
  })

  test('rejects a pattern carrying a fragment', () => {
    assert.equal(isValidOriginPrefixPattern('https://api.example.com/v1#section'), false)
  })

  test('rejects a pattern carrying userinfo', () => {
    assert.equal(isValidOriginPrefixPattern('https://user:pass@api.example.com/'), false)
  })

  test('rejects an unparsable string', () => {
    assert.equal(isValidOriginPrefixPattern('not a url'), false)
  })

  test('rejects an empty string', () => {
    assert.equal(isValidOriginPrefixPattern(''), false)
  })
})
