import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress, isValidOriginPrefixPattern, originMatchesAllowlist } from './network.ts'

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

describe('originMatchesAllowlist', () => {
  test('matches the exact origin with no path prefix stored', () => {
    const url = new URL('https://api.example.com/anything')
    assert.equal(originMatchesAllowlist(url, ['https://api.example.com']), true)
  })

  test('does not match a different host', () => {
    const url = new URL('https://evil.com/v1')
    assert.equal(originMatchesAllowlist(url, ['https://api.example.com/v1']), false)
  })

  test('does not match a different scheme', () => {
    const url = new URL('http://api.example.com/v1')
    assert.equal(originMatchesAllowlist(url, ['https://api.example.com/v1']), false)
  })

  test('does not match a different port', () => {
    const url = new URL('https://api.example.com:8443/v1')
    assert.equal(originMatchesAllowlist(url, ['https://api.example.com/v1']), false)
  })

  test('a path prefix matches itself and any nested path', () => {
    const patterns = ['https://api.example.com/v1']
    assert.equal(originMatchesAllowlist(new URL('https://api.example.com/v1'), patterns), true)
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com/v1/reports'), patterns),
      true
    )
  })

  test('a path prefix does not match an off-prefix sibling path', () => {
    const patterns = ['https://api.example.com/v1']
    assert.equal(originMatchesAllowlist(new URL('https://api.example.com/v2'), patterns), false)
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com/v1-legacy'), patterns),
      false
    )
  })

  test('a path prefix does not match the bare origin', () => {
    const patterns = ['https://api.example.com/v1']
    assert.equal(originMatchesAllowlist(new URL('https://api.example.com/'), patterns), false)
  })

  test('a trailing slash on the stored prefix is normalized away', () => {
    const patterns = ['https://api.example.com/v1/']
    assert.equal(
      originMatchesAllowlist(new URL('https://api.example.com/v1/reports'), patterns),
      true
    )
  })

  test('an empty allowlist matches nothing', () => {
    assert.equal(originMatchesAllowlist(new URL('https://api.example.com/v1'), []), false)
  })

  test('matches when any one of several patterns matches', () => {
    const patterns = ['https://other.com', 'https://api.example.com/v1']
    assert.equal(originMatchesAllowlist(new URL('https://api.example.com/v1/data'), patterns), true)
  })

  test('matches a bracketed IPv6 origin', () => {
    const patterns = ['https://[2606:4700:10::6814:179a]/v1']
    assert.equal(
      originMatchesAllowlist(new URL('https://[2606:4700:10::6814:179a]/v1/x'), patterns),
      true
    )
  })
})

describe('isValidOriginPrefixPattern', () => {
  test('accepts a bare origin with no path', () => {
    assert.equal(isValidOriginPrefixPattern('https://api.example.com'), true)
    assert.equal(isValidOriginPrefixPattern('http://api.example.com'), true)
  })

  test('accepts an origin with a path prefix', () => {
    assert.equal(isValidOriginPrefixPattern('https://api.example.com/v1'), true)
    assert.equal(isValidOriginPrefixPattern('https://api.example.com/v1/reports'), true)
  })

  test('accepts an explicit port', () => {
    assert.equal(isValidOriginPrefixPattern('https://api.example.com:8443/v1'), true)
  })

  test('accepts a bracketed IPv6 origin', () => {
    assert.equal(isValidOriginPrefixPattern('https://[::1]/v1'), true)
    assert.equal(isValidOriginPrefixPattern('https://[2606:4700:10::6814:179a]:8443/v1'), true)
  })

  test('rejects a bare hostname with no scheme -- the old allowedDomains shape', () => {
    assert.equal(isValidOriginPrefixPattern('api.example.com'), false)
  })

  test('rejects a scheme other than http/https', () => {
    assert.equal(isValidOriginPrefixPattern('ftp://api.example.com'), false)
    assert.equal(isValidOriginPrefixPattern('javascript://api.example.com'), false)
  })

  test('rejects a query string', () => {
    assert.equal(isValidOriginPrefixPattern('https://api.example.com/v1?x=1'), false)
  })

  test('rejects a fragment', () => {
    assert.equal(isValidOriginPrefixPattern('https://api.example.com/v1#section'), false)
  })

  test('rejects userinfo in the origin', () => {
    assert.equal(isValidOriginPrefixPattern('https://user:pass@api.example.com/v1'), false)
  })

  test('rejects whitespace', () => {
    assert.equal(isValidOriginPrefixPattern('https://api example.com/v1'), false)
  })

  test('rejects an empty string', () => {
    assert.equal(isValidOriginPrefixPattern(''), false)
  })

  test('a validated IPv6 entry actually matches the origin a real IPv6 URL produces', () => {
    const entry = 'https://[2606:4700:10::6814:179a]/v1'
    assert.equal(isValidOriginPrefixPattern(entry), true)
    assert.equal(
      originMatchesAllowlist(new URL('https://[2606:4700:10::6814:179a]/v1/x'), [entry]),
      true
    )
  })
})
