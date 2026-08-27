import { describe, expect, it } from 'vitest'

import { isValidOriginPrefixPattern } from './originPattern.js'

describe('isValidOriginPrefixPattern', () => {
  it('accepts a bare origin with no path', () => {
    expect(isValidOriginPrefixPattern('https://api.example.com')).toBe(true)
    expect(isValidOriginPrefixPattern('http://api.example.com')).toBe(true)
  })

  it('accepts an origin with a path prefix', () => {
    expect(isValidOriginPrefixPattern('https://api.example.com/v1')).toBe(true)
    expect(isValidOriginPrefixPattern('https://api.example.com/v1/reports')).toBe(true)
  })

  it('accepts an explicit port', () => {
    expect(isValidOriginPrefixPattern('https://api.example.com:8443/v1')).toBe(true)
  })

  it('accepts a bracketed IPv6 origin', () => {
    expect(isValidOriginPrefixPattern('https://[::1]/v1')).toBe(true)
    expect(isValidOriginPrefixPattern('https://[fe80::1]/v1')).toBe(true)
  })

  it('rejects a bare hostname with no scheme -- the old allowedDomains shape', () => {
    expect(isValidOriginPrefixPattern('api.example.com')).toBe(false)
  })

  it('rejects a scheme other than http/https', () => {
    expect(isValidOriginPrefixPattern('ftp://api.example.com')).toBe(false)
  })

  it('rejects a query string', () => {
    expect(isValidOriginPrefixPattern('https://api.example.com/v1?x=1')).toBe(false)
  })

  it('rejects a fragment', () => {
    expect(isValidOriginPrefixPattern('https://api.example.com/v1#section')).toBe(false)
  })

  it('rejects userinfo in the origin', () => {
    expect(isValidOriginPrefixPattern('https://user:pass@api.example.com/v1')).toBe(false)
  })

  it('rejects whitespace', () => {
    expect(isValidOriginPrefixPattern('https://api example.com/v1')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidOriginPrefixPattern('')).toBe(false)
  })
})
