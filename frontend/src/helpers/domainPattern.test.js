import { describe, expect, it } from 'vitest'

import { isValidDomainPattern } from './domainPattern.js'

describe('isValidDomainPattern', () => {
  it('accepts a plain hostname', () => {
    expect(isValidDomainPattern('api.example.com')).toBe(true)
    expect(isValidDomainPattern('example.com')).toBe(true)
    expect(isValidDomainPattern('localhost')).toBe(true)
  })

  it('accepts a *.-prefixed wildcard', () => {
    expect(isValidDomainPattern('*.example.com')).toBe(true)
  })

  it('accepts an IPv4 literal', () => {
    expect(isValidDomainPattern('203.0.113.5')).toBe(true)
  })

  it('accepts an IPv6 literal', () => {
    expect(isValidDomainPattern('::1')).toBe(true)
    expect(isValidDomainPattern('fe80::1')).toBe(true)
  })

  it('rejects a URL rather than a bare hostname', () => {
    expect(isValidDomainPattern('https://api.example.com')).toBe(false)
    expect(isValidDomainPattern('api.example.com/path')).toBe(false)
  })

  it('rejects a trailing slash', () => {
    expect(isValidDomainPattern('api.example.com/')).toBe(false)
  })

  it('rejects more than one wildcard label', () => {
    expect(isValidDomainPattern('*.*.example.com')).toBe(false)
  })

  it('rejects a wildcard not at the start', () => {
    expect(isValidDomainPattern('api.*.example.com')).toBe(false)
  })

  it('rejects an empty label', () => {
    expect(isValidDomainPattern('a..b.com')).toBe(false)
  })

  it('rejects a label starting or ending with a hyphen', () => {
    expect(isValidDomainPattern('-example.com')).toBe(false)
    expect(isValidDomainPattern('example-.com')).toBe(false)
  })

  it('rejects whitespace', () => {
    expect(isValidDomainPattern('api example.com')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidDomainPattern('')).toBe(false)
  })
})
