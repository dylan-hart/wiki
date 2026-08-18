import { describe, expect, it } from 'vitest'

import { hostnameRenamedAway } from './siteRename.js'

describe('hostnameRenamedAway', () => {
  it('is false when the hostname is unchanged', () => {
    expect(hostnameRenamedAway('wiki.example.com', 'wiki.example.com')).toBe(false)
  })

  it('is true when the hostname changed to a different value', () => {
    expect(hostnameRenamedAway('wiki.example.com', 'wiki.example.org')).toBe(true)
  })

  it('is true when the hostname changed away from the catch-all wildcard', () => {
    expect(hostnameRenamedAway('*', 'wiki.example.com')).toBe(true)
  })

  it('is true when the hostname changed to the catch-all wildcard', () => {
    expect(hostnameRenamedAway('wiki.example.com', '*')).toBe(true)
  })

  it('is false when the new value is empty/undefined (no real change submitted)', () => {
    expect(hostnameRenamedAway('wiki.example.com', '')).toBe(false)
    expect(hostnameRenamedAway('wiki.example.com', undefined)).toBe(false)
  })
})
