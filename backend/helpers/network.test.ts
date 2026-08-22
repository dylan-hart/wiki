import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress } from './network.ts'

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
