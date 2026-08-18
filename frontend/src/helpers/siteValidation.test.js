import { describe, expect, it } from 'vitest'

import { hostnamePattern, isValidHostname } from './siteValidation.js'

describe('hostnamePattern / isValidHostname()', () => {
  it('accepts ordinary fully-qualified domain names', () => {
    expect(isValidHostname('wiki.example.com')).toBe(true)
    expect(isValidHostname('example.com')).toBe(true)
    expect(isValidHostname('sub.sub2.example.co.uk')).toBe(true)
    expect(isValidHostname('localhost')).toBe(true)
  })

  it('accepts the catch-all wildcard', () => {
    expect(isValidHostname('*')).toBe(true)
  })

  it('rejects a colon/port, matching the backend JSON schema', () => {
    expect(isValidHostname('wiki.example.com:3000')).toBe(false)
    expect(isValidHostname('localhost:8080')).toBe(false)
  })

  it('rejects uppercase, spaces and other invalid characters', () => {
    expect(isValidHostname('Wiki.Example.com')).toBe(false)
    expect(isValidHostname('wiki example.com')).toBe(false)
    expect(isValidHostname('wiki_example.com')).toBe(false)
    expect(isValidHostname('')).toBe(false)
  })

  it('matches the backend JSON schema pattern exactly', () => {
    expect(hostnamePattern.source).toBe('^(\\*|[a-z0-9.-]+)$')
  })
})
