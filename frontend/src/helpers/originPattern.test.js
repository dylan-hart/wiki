import { describe, expect, it } from 'vitest'

import { isValidOriginPattern } from './originPattern.js'

describe('isValidOriginPattern', () => {
  it('accepts an origin with no path', () => {
    expect(isValidOriginPattern('https://api.example.com')).toBe(true)
    expect(isValidOriginPattern('http://example.com')).toBe(true)
  })

  it('accepts an origin with a path prefix', () => {
    expect(isValidOriginPattern('https://api.example.com/v1')).toBe(true)
    expect(isValidOriginPattern('https://api.example.com/v1/data')).toBe(true)
  })

  it('accepts an explicit port', () => {
    expect(isValidOriginPattern('https://api.example.com:8443/v1')).toBe(true)
  })

  it('accepts a *.-prefixed wildcard host', () => {
    expect(isValidOriginPattern('https://*.example.com')).toBe(true)
  })

  it('accepts a bracketed IPv6 literal host', () => {
    expect(isValidOriginPattern('https://[::1]')).toBe(true)
    expect(isValidOriginPattern('https://[fe80::1]')).toBe(true)
  })

  it('rejects a bare hostname with no scheme', () => {
    expect(isValidOriginPattern('api.example.com')).toBe(false)
    expect(isValidOriginPattern('api.example.com/v1')).toBe(false)
  })

  it('rejects a non-http(s) scheme', () => {
    expect(isValidOriginPattern('ftp://api.example.com')).toBe(false)
  })

  it('rejects a pattern carrying a query string', () => {
    expect(isValidOriginPattern('https://api.example.com/v1?x=1')).toBe(false)
  })

  it('rejects a pattern carrying a fragment', () => {
    expect(isValidOriginPattern('https://api.example.com/v1#frag')).toBe(false)
  })

  it('rejects more than one wildcard label', () => {
    expect(isValidOriginPattern('https://*.*.example.com')).toBe(false)
  })

  it('rejects a wildcard not at the start of the host', () => {
    expect(isValidOriginPattern('https://api.*.example.com')).toBe(false)
  })

  it('rejects userinfo in the origin', () => {
    expect(isValidOriginPattern('https://user:pass@api.example.com/v1')).toBe(false)
  })

  it('rejects whitespace', () => {
    expect(isValidOriginPattern('https://api example.com')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidOriginPattern('')).toBe(false)
  })
})
