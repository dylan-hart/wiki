import { describe, expect, it } from 'vitest'

import { API_KEY_SCOPES, groupScopesByVerb } from './apiKeyScopes'

/**
 * The real cross-workspace check against `backend/helpers/permissions.ts`'s `ALL_PERMISSIONS`
 * lives in `backend/helpers/permissions.test.ts` (OpenProject #1938), which reads this file as text
 * rather than the reverse -- a JS frontend cannot import the backend's TS source across the
 * workspace boundary, and a retyped snapshot here could drift from the backend list with a green
 * test suite either way (which is exactly what happened: see OpenProject #1272). This file keeps
 * only the assertions that are genuinely this list's own concern.
 */
describe('API_KEY_SCOPES', () => {
  it('includes the 4 scopes that were previously missing relative to the backend union (OpenProject #1272)', () => {
    expect(API_KEY_SCOPES).toEqual(
      expect.arrayContaining([
        'read:users',
        'read:groups',
        'manage:glossary',
        'manage:classification'
      ])
    )
  })

  it('has no duplicate scope entries', () => {
    expect(new Set(API_KEY_SCOPES).size).toBe(API_KEY_SCOPES.length)
  })
})

describe('groupScopesByVerb', () => {
  it('groups scopes by their verb prefix, preserving first-seen verb order', () => {
    const groups = groupScopesByVerb(['manage:users', 'read:pages', 'manage:groups', 'read:source'])

    expect(groups).toEqual([
      { verb: 'manage', scopes: ['manage:users', 'manage:groups'] },
      { verb: 'read', scopes: ['read:pages', 'read:source'] }
    ])
  })

  it('gives a verb with a single member its own single-item group', () => {
    const groups = groupScopesByVerb(['manage:users', 'review:pages'])

    expect(groups).toContainEqual({ verb: 'review', scopes: ['review:pages'] })
  })

  it('defaults to grouping the full API_KEY_SCOPES vocabulary, accounting for every scope exactly once', () => {
    const groups = groupScopesByVerb()

    expect(groups.flatMap((g) => g.scopes).sort()).toEqual([...API_KEY_SCOPES].sort())
  })
})
