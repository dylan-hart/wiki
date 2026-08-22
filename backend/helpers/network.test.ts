import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hostnameMatchesAllowlist, isPrivateAddress, isValidDomainPattern } from './network.ts'

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

describe('hostnameMatchesAllowlist', () => {
  test('matches an exact hostname', () => {
    assert.equal(hostnameMatchesAllowlist('api.example.com', ['api.example.com']), true)
  })

  test('does not match a different hostname', () => {
    assert.equal(hostnameMatchesAllowlist('evil.com', ['api.example.com']), false)
  })

  test('matches case-insensitively', () => {
    assert.equal(hostnameMatchesAllowlist('API.Example.COM', ['api.example.com']), true)
    assert.equal(hostnameMatchesAllowlist('api.example.com', ['API.EXAMPLE.COM']), true)
  })

  test('a wildcard pattern matches exactly one extra label', () => {
    assert.equal(hostnameMatchesAllowlist('api.example.com', ['*.example.com']), true)
  })

  test('a wildcard pattern does not match the bare root domain', () => {
    assert.equal(hostnameMatchesAllowlist('example.com', ['*.example.com']), false)
  })

  test('a wildcard pattern does not match two extra labels', () => {
    assert.equal(hostnameMatchesAllowlist('a.b.example.com', ['*.example.com']), false)
  })

  test('a wildcard pattern does not match an unrelated suffix', () => {
    assert.equal(hostnameMatchesAllowlist('api.notexample.com', ['*.example.com']), false)
  })

  test('matches a bare IP-literal entry by exact string', () => {
    assert.equal(hostnameMatchesAllowlist('203.0.113.5', ['203.0.113.5']), true)
    assert.equal(hostnameMatchesAllowlist('203.0.113.6', ['203.0.113.5']), false)
  })

  test('an empty allowlist matches nothing', () => {
    assert.equal(hostnameMatchesAllowlist('api.example.com', []), false)
  })

  test('matches when any one of several patterns matches', () => {
    assert.equal(hostnameMatchesAllowlist('api.example.com', ['other.com', '*.example.com']), true)
  })
})

describe('isValidDomainPattern', () => {
  test('accepts a plain hostname', () => {
    assert.equal(isValidDomainPattern('api.example.com'), true)
    assert.equal(isValidDomainPattern('example.com'), true)
    assert.equal(isValidDomainPattern('localhost'), true)
  })

  test('accepts a *.-prefixed wildcard', () => {
    assert.equal(isValidDomainPattern('*.example.com'), true)
  })

  test('accepts an IPv4 literal', () => {
    assert.equal(isValidDomainPattern('203.0.113.5'), true)
  })

  test('accepts an IPv6 literal', () => {
    assert.equal(isValidDomainPattern('::1'), true)
    assert.equal(isValidDomainPattern('fe80::1'), true)
    assert.equal(isValidDomainPattern('2606:4700:10::6814:179a'), true)
  })

  test('rejects a URL rather than a bare hostname', () => {
    assert.equal(isValidDomainPattern('https://api.example.com'), false)
    assert.equal(isValidDomainPattern('api.example.com/path'), false)
  })

  test('rejects a trailing slash', () => {
    assert.equal(isValidDomainPattern('api.example.com/'), false)
  })

  test('rejects more than one wildcard label', () => {
    assert.equal(isValidDomainPattern('*.*.example.com'), false)
  })

  test('rejects a wildcard not at the start', () => {
    assert.equal(isValidDomainPattern('api.*.example.com'), false)
    assert.equal(isValidDomainPattern('example.com*'), false)
  })

  test('rejects an empty label', () => {
    assert.equal(isValidDomainPattern('a..b.com'), false)
    assert.equal(isValidDomainPattern('.example.com'), false)
  })

  test('rejects a label starting or ending with a hyphen', () => {
    assert.equal(isValidDomainPattern('-example.com'), false)
    assert.equal(isValidDomainPattern('example-.com'), false)
  })

  test('rejects whitespace', () => {
    assert.equal(isValidDomainPattern('api example.com'), false)
    assert.equal(isValidDomainPattern(' api.example.com'), false)
  })

  test('rejects an empty string', () => {
    assert.equal(isValidDomainPattern(''), false)
  })
})
