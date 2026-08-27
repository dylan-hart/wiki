import { describe, expect, it } from 'vitest'
import { isValidOriginPrefixPattern } from './originPattern.js'

describe('isValidOriginPrefixPattern', () => {
  it('accepts a bare https origin', () => {
    expect(isValidOriginPrefixPattern('https://api.example.com')).toBe(true)
  })

  it('accepts an origin with a path prefix', () => {
    expect(isValidOriginPrefixPattern('https://api.example.com/v1/widgets')).toBe(true)
  })

  it('accepts an explicit port', () => {
    expect(isValidOriginPrefixPattern('http://internal.example.com:8080/api')).toBe(true)
  })

  it('accepts a plain http origin', () => {
    expect(isValidOriginPrefixPattern('http://api.example.com')).toBe(true)
  })

  it('rejects a bare hostname with no scheme', () => {
    expect(isValidOriginPrefixPattern('api.example.com')).toBe(false)
  })

  it('rejects a non-http(s) scheme', () => {
    expect(isValidOriginPrefixPattern('ftp://api.example.com')).toBe(false)
    expect(isValidOriginPrefixPattern('ws://api.example.com')).toBe(false)
  })

  it('rejects a pattern carrying a query string', () => {
    expect(isValidOriginPrefixPattern('https://api.example.com/v1?token=abc')).toBe(false)
  })

  it('rejects a pattern carrying a fragment', () => {
    expect(isValidOriginPrefixPattern('https://api.example.com/v1#section')).toBe(false)
  })

  it('rejects a pattern carrying userinfo', () => {
    expect(isValidOriginPrefixPattern('https://user:pass@api.example.com/')).toBe(false)
  })

  it('rejects an unparsable string', () => {
    expect(isValidOriginPrefixPattern('not a url')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidOriginPrefixPattern('')).toBe(false)
  })
})
